// Processor: combina items + PDFs + transcripts → chunks otimizados pra KB.
//
// Pipeline por item:
//   1. Carrega item.json
//   2. Carrega PDFs associados (.txt extraído via pdftotext)
//   3. Carrega transcripts associados (.json com text completo)
//   4. Combina raw text
//   5. Se total > 4500 chars: usa Claude Haiku pra summarizar mantendo
//      info-chave (quem, o que, como, quando, números). Output ≤4500 chars.
//   6. Detecta categoria semântica (training/regulation/howto/etc)
//   7. Extrai keywords/tags do conteúdo
//   8. Output: chunk final em formato Markdown frontmatter padrão.
//
// Output em _planning/carriers/brazillionaires_portal/{section}/{slug}.md
// (mesma estrutura que NLG — pronto pra ingest-carrier-kb.ts)
//
// Uso: npx tsx scripts/process-brazillionaires-chunks.ts

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import Anthropic from "@anthropic-ai/sdk";

// Carrega .env.local
function loadDotEnv(path: string) {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}
loadDotEnv(join(process.cwd(), ".env.local"));

const ROOT = join(process.cwd(), "_planning", "carriers", "brazillionaires_portal");
const RAW = join(ROOT, "raw");
const SOURCE_BASE = "https://brazillionaires.virtualnet.site";

const SECTION_META: Record<string, { name: string; mainCategory: string }> = {
  "eventos": { name: "Comece Aqui / Eventos", mainCategory: "workflow" },
  "aprender-profissao": { name: "Aprender a Profissão", mainCategory: "process" },
  "aprender-aplicacao": { name: "Aprender Aplicação", mainCategory: "process" },
};

const SUB_SECTION_NAMES: Record<number, string> = {
  66043736: "Fazer a Prova",
  64067065: "Como Funciona a Profissão",
  64067113: "Passei na Prova, e Agora",
  64568456: "Como Convidar",
  64072072: "Como Atender Clientes",
  64072885: "Termo+Benefício em Vida",
  64072908: "Plano Indexado",
  64072912: "401k+Annuities",
  64790960: "Como Conhecer Pessoas",
  65604413: "Bônus",
  64173649: "Como Fazer a Aplicação",
  64173681: "Processo de Underwriting",
};

interface RawItem {
  id: number;
  title: string;
  author?: string;
  date?: string;
  summary?: string;
  content?: string;
  [key: string]: unknown;
}

interface ItemFile {
  section: string;
  itemPath: string;
  jsonPath: string;
  item: RawItem;
}

interface VideoQueueEntry {
  itemId: number;
  vimeoId: string;
  vimeoHash: string | null;
  subSectionId: number;
  subSectionName: string;
}

interface Transcript {
  itemId: number;
  vimeoId: string;
  duration: number;
  text: string;
}

const VIMEO_REGEX = /player\.vimeo\.com\/video\/(\d+)/g;
const PDF_REGEX = /attachment\/download\/(\d+)/g;

function htmlToText(html: string): string {
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  text = text.replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/g, "");
  text = text.replace(/<a[^>]*href="[^"]*"[^>]*>([^<]*)<\/a>/g, "[link]$1[/link]");
  text = text.replace(/<img[^>]*>/g, "");
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<[^>]+>/g, " ");
  text = text.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  text = text.replace(/[ \t]+/g, " ").replace(/\n[ \t]+/g, "\n").replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

async function findItems(section: string): Promise<ItemFile[]> {
  const itemsDir = join(RAW, section, "items");
  if (!existsSync(itemsDir)) return [];
  const files = await readdir(itemsDir);
  const out: ItemFile[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    const jsonPath = join(itemsDir, f);
    const raw = await readFile(jsonPath, "utf8");
    let item: RawItem;
    try {
      item = JSON.parse(raw);
    } catch {
      continue;
    }
    out.push({ section, itemPath: jsonPath, jsonPath, item });
  }
  return out;
}

async function findTranscripts(itemId: number, section: string): Promise<Transcript[]> {
  const tDir = join(RAW, section, "transcripts");
  if (!existsSync(tDir)) return [];
  const files = await readdir(tDir);
  const out: Transcript[] = [];
  for (const f of files) {
    if (!f.startsWith(`${itemId}-`) || !f.endsWith(".json")) continue;
    const data = JSON.parse(await readFile(join(tDir, f), "utf8"));
    out.push({
      itemId,
      vimeoId: data.vimeoId,
      duration: data.duration || 0,
      text: data.text || "",
    });
  }
  return out;
}

async function findPdfTexts(itemContent: string, section: string): Promise<{ pdfId: string; text: string }[]> {
  const pdfsDir = join(RAW, section, "pdfs");
  if (!existsSync(pdfsDir)) return [];
  const pdfIds = new Set<string>();
  for (const m of itemContent.matchAll(PDF_REGEX)) pdfIds.add(m[1]);
  const out: { pdfId: string; text: string }[] = [];
  for (const pdfId of pdfIds) {
    const txtPath = join(pdfsDir, `${pdfId}.txt`);
    if (existsSync(txtPath)) {
      const text = await readFile(txtPath, "utf8");
      out.push({ pdfId, text });
    }
  }
  return out;
}

async function summarizeWithClaude(
  anthropic: Anthropic,
  itemTitle: string,
  rawText: string,
): Promise<string> {
  const msg = await anthropic.messages.create({
    model: "claude-haiku-4-5",
    max_tokens: 1500,
    messages: [
      {
        role: "user",
        content: `Você é um sumarizador especialista que prepara conteúdo de treinamento de venda de seguros pra uma knowledge base de IA assistente. O resumo será consumido por outro LLM (Sparkbot) que ajuda reps a operar — então mantém DENSIDADE de informação, não floreio.

Item: "${itemTitle}"

Conteúdo bruto (texto + transcrição de vídeo + extratos de PDF):
---
${rawText}
---

Resuma em PT-BR seguindo essa estrutura:

**Resumo:** 2-3 frases sobre o que é/cobre.

**Pontos-chave:**
- 5-10 bullets densos, ESPECÍFICOS, com números/regras/passos quando houver.
- Se citar pessoas (Marina, Rickson, Gustavo Couto, etc), mantenha o nome.
- Se for técnico (UW rules, comissão, campos de form), preserve detalhes.

**Quando usar / contexto:** 1-2 frases sobre quando rep deve consultar isso.

**Pitfalls / dicas:** se houver "cuidado com X", "sempre faça Y", "nunca esqueça Z" — coloque aqui.

Tamanho-alvo: 1500-3500 chars total. NÃO seja vago — quem usa isso é rep que precisa agir. Inclua números, nomes próprios, processos exatos. NÃO repita o título no início. NÃO use markdown headers # — só **bold** pra labels acima.`,
      },
    ],
  });
  const block = msg.content[0];
  return block.type === "text" ? block.text : "";
}

function inferTags(item: RawItem, fullText: string): string[] {
  const tags = new Set<string>();
  const t = (item.title + " " + (item.summary || "") + " " + fullText).toLowerCase();

  // Tópicos comuns
  const topicMap: Record<string, string[]> = {
    "iul": ["iul", "indexed-universal-life", "plano-indexado"],
    "term": ["term", "termo", "term-life"],
    "annuit": ["annuity", "annuities", "anuidade"],
    "401k": ["401k", "401(k)", "qualified-plan"],
    "underwrit": ["underwriting", "uw"],
    "aplica[çc][ãa]o": ["aplicacao", "application"],
    "licen[çc]a": ["licenca", "license", "licensing"],
    "prova": ["exam", "prova"],
    "fingerprint": ["fingerprinting"],
    "rollover": ["rollover", "1035"],
    "comiss[ãa]o": ["comissao", "commission"],
    "bootcamp": ["bootcamp"],
    "marina|gustavo couto|rickson|frederico|rita": ["instrutor"],
    "infinite banking": ["infinite-banking", "ibc"],
    "napkin": ["napkin", "presentation"],
    "emergency contact": ["emergency-contact-list"],
    "convidar": ["recruiting", "convite", "prospecting"],
    "networking": ["networking"],
    "media social|m[ií]dia social": ["social-media"],
    "imagem": ["personal-brand"],
    "pipeline": ["pipeline"],
    "estudo de caso": ["case-study", "estudo-caso"],
    "national life|nlg": ["nlg", "national-life-group"],
    "ameritas": ["ameritas"],
    "fingerprint": ["fingerprint"],
    "e-app|eapp": ["eapp"],
    "foresight": ["foresight"],
    "rapidprotect": ["rapidprotect"],
    "flexlife": ["flexlife"],
    "peaklife": ["peaklife"],
    "summitlife": ["summitlife"],
  };

  for (const [pattern, ts] of Object.entries(topicMap)) {
    if (new RegExp(pattern, "i").test(t)) {
      ts.forEach((x) => tags.add(x));
    }
  }

  return Array.from(tags).slice(0, 12);
}

function inferSubcategory(subSectionId: number, content: string): string {
  const subName = SUB_SECTION_NAMES[subSectionId];
  if (!subName) return "general";
  return slugify(subName);
}

interface ProcessedChunk {
  itemId: number;
  section: string;
  subSectionId: number;
  fullPath: string;
  sourceUrl: string;
  body: string;
  tags: string[];
  videoCount: number;
  pdfCount: number;
  totalRawChars: number;
  finalChars: number;
}

async function processItem(
  itemFile: ItemFile,
  videoQueue: VideoQueueEntry[],
  anthropic: Anthropic | null,
): Promise<ProcessedChunk | null> {
  const item = itemFile.item;

  // Detect sub-section: cross-ref the video queue OR fall back to scanning
  let subSectionId = 0;
  for (const vq of videoQueue) {
    if (vq.itemId === item.id) {
      subSectionId = vq.subSectionId;
      break;
    }
  }
  // Fallback: try to detect via section path. For sections without videos, still need subSection.
  if (subSectionId === 0) {
    // Use section folder + first sub-section we find. Best effort.
    const allSubsForSection: Record<string, number[]> = {
      "eventos": [66043736, 64067065, 64067113, 64568456],
      "aprender-profissao": [64072072, 64072885, 64072908, 64072912, 64790960, 65604413],
      "aprender-aplicacao": [64173649, 64173681],
    };
    // Pick first as fallback (we lose precision pra alguns items texto-only)
    subSectionId = (allSubsForSection[itemFile.section] || [0])[0];
  }
  const subSectionName = SUB_SECTION_NAMES[subSectionId] || "general";
  const sectionMeta = SECTION_META[itemFile.section] || { name: itemFile.section, mainCategory: "training" };

  // Combina conteúdos
  const itemText = htmlToText(item.content || "");
  const transcripts = await findTranscripts(item.id, itemFile.section);
  const pdfs = await findPdfTexts(item.content || "", itemFile.section);

  const rawParts: string[] = [];
  if (item.summary) rawParts.push(`SUMMARY: ${item.summary}`);
  if (itemText) rawParts.push(`TEXTO DO ITEM:\n${itemText}`);
  for (const t of transcripts) {
    if (t.text) rawParts.push(`TRANSCRIÇÃO DE VÍDEO (${Math.floor(t.duration / 60)}min):\n${t.text}`);
  }
  for (const p of pdfs) {
    if (p.text) {
      // Limita texto de PDF a 4KB por PDF (alguns são guias enormes)
      const pt = p.text.length > 4000 ? p.text.slice(0, 4000) + "\n[... PDF truncado em 4KB ...]" : p.text;
      rawParts.push(`PDF (${p.pdfId}):\n${pt}`);
    }
  }
  const rawText = rawParts.join("\n\n---\n\n");
  const totalRaw = rawText.length;

  if (totalRaw < 100) {
    // Item sem conteúdo útil
    return null;
  }

  // Body — se conteúdo ≤4500 chars, mantém raw com pequena limpeza.
  // Se >4500, summariza com Claude.
  let body: string;
  const TARGET_MAX = 4500;
  if (totalRaw <= TARGET_MAX) {
    // Mantém raw mas formatado
    const parts: string[] = [];
    if (item.summary) parts.push(`**Resumo:** ${item.summary}`);
    if (itemText) parts.push(`**Conteúdo:**\n${itemText}`);
    for (const t of transcripts) {
      const summary = t.text.length > 1500 ? t.text.slice(0, 1500) + "..." : t.text;
      parts.push(`**Transcript de vídeo (${Math.floor(t.duration / 60)}min):**\n${summary}`);
    }
    for (const p of pdfs) {
      const summary = p.text.length > 1000 ? p.text.slice(0, 1000) + "..." : p.text;
      parts.push(`**PDF ${p.pdfId}:**\n${summary}`);
    }
    body = parts.join("\n\n");
    if (body.length > TARGET_MAX) body = body.slice(0, TARGET_MAX) + "\n[...truncado]";
  } else if (anthropic) {
    // Summariza com Claude
    try {
      body = await summarizeWithClaude(anthropic, item.title, rawText);
      if (body.length > TARGET_MAX) body = body.slice(0, TARGET_MAX) + "\n[...]";
    } catch (err) {
      // Fallback: trunca raw
      body = rawText.slice(0, TARGET_MAX) + "\n[...truncado por falha de summarization]";
      console.warn(`  ⚠️  Claude falhou pro ${item.id}: ${err}`);
    }
  } else {
    body = rawText.slice(0, TARGET_MAX) + "\n[...truncado]";
  }

  const tags = inferTags(item, rawText);
  const slug = `${item.id}-${slugify(item.title)}`;
  const subcategory = `${sectionMeta.mainCategory}:${slugify(subSectionName)}`;
  const sourceUrl = `${SOURCE_BASE}/${itemFile.section}/c/0/i/${item.id}/${slugify(item.title)}`;
  const lastVerified = item.date ? item.date.slice(0, 10) : "2026-04-28";

  // Resources annotations
  const videoNote = transcripts.length > 0
    ? `\n\n**Recursos:**\n${transcripts.map(t => `- Vídeo Vimeo: ${t.vimeoId} (${Math.floor(t.duration / 60)}:${String(Math.floor(t.duration % 60)).padStart(2, "0")} min)`).join("\n")}`
    : "";
  const pdfNote = pdfs.length > 0
    ? `\n${pdfs.map(p => `- PDF: ${p.pdfId}`).join("\n")}`
    : "";
  const fullSourceNote = transcripts.length + pdfs.length > 0
    ? `${videoNote}${pdfNote}\n- Source: ${sourceUrl}`
    : `\n\n**Source:** ${sourceUrl}`;

  const finalBody = body + fullSourceNote;

  // Frontmatter
  const fm = [
    `---`,
    `carrier: brazillionaires_portal`,
    `category: workflow`,
    `subcategory: ${slugify(subSectionName)}`,
    `slug: ${slug}`,
    `title: "${item.title.replace(/"/g, '\\"')}"`,
    `priority: on_demand`,
    `tags: [${tags.join(", ")}]`,
    `applies_to_companies: []`,
    `source: official`,
    `source_url: ${sourceUrl}`,
    `source_doc_cat: brazillionaires-portal-${itemFile.section}-${slugify(subSectionName)}`,
    `last_verified: ${lastVerified}`,
    `---`,
    ``,
    finalBody,
    ``,
  ].join("\n");

  // Output path: _planning/carriers/brazillionaires_portal/{section}/{slug}.md
  const outPath = join(ROOT, itemFile.section, `${slug}.md`);
  await mkdir(join(ROOT, itemFile.section), { recursive: true });
  await writeFile(outPath, fm);

  return {
    itemId: item.id,
    section: itemFile.section,
    subSectionId,
    fullPath: outPath,
    sourceUrl,
    body: finalBody,
    tags,
    videoCount: transcripts.length,
    pdfCount: pdfs.length,
    totalRawChars: totalRaw,
    finalChars: finalBody.length,
  };
}

async function main() {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.error("ANTHROPIC_API_KEY não configurado — summarization desabilitado, items grandes serão truncados");
  }
  const anthropic = apiKey ? new Anthropic({ apiKey }) : null;

  // Carrega video queue pra detectar sub-section por item
  const videoQueueFile = join(RAW, "_video-queue.json");
  const videoQueue: VideoQueueEntry[] = existsSync(videoQueueFile)
    ? JSON.parse(readFileSync(videoQueueFile, "utf8"))
    : [];

  let totalProcessed = 0;
  let totalSummarized = 0;
  let totalSkipped = 0;
  let totalRawChars = 0;
  let totalFinalChars = 0;

  for (const section of Object.keys(SECTION_META)) {
    const items = await findItems(section);
    console.log(`\n=== ${section}: ${items.length} items ===`);

    for (const itemFile of items) {
      const result = await processItem(itemFile, videoQueue, anthropic);
      if (!result) {
        console.log(`  — ${itemFile.item.id} skipped (vazio)`);
        totalSkipped++;
        continue;
      }
      totalProcessed++;
      if (result.totalRawChars > 4500) totalSummarized++;
      totalRawChars += result.totalRawChars;
      totalFinalChars += result.finalChars;
      const compress = result.totalRawChars > 0 ? (result.finalChars * 100 / result.totalRawChars).toFixed(0) : "—";
      console.log(`  ✓ ${result.itemId} ${itemFile.item.title.slice(0, 50).padEnd(50)} ${result.totalRawChars}→${result.finalChars} chars (${compress}%) — videos:${result.videoCount} pdfs:${result.pdfCount}`);
    }
  }

  console.log(`\n=== Process summary ===`);
  console.log(`Items processed: ${totalProcessed}`);
  console.log(`Items summarized via Claude: ${totalSummarized}`);
  console.log(`Items skipped: ${totalSkipped}`);
  console.log(`Total raw: ${(totalRawChars / 1024).toFixed(0)} KB`);
  console.log(`Total final: ${(totalFinalChars / 1024).toFixed(0)} KB`);
  if (totalRawChars > 0) {
    console.log(`Compression: ${(totalFinalChars * 100 / totalRawChars).toFixed(0)}%`);
  }
}

main().catch((err) => {
  console.error("[process] falha:", err);
  process.exit(1);
});
