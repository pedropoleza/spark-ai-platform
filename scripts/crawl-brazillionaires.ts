// Crawler do portal Brazillionaires (https://brazillionaires.virtualnet.site/)
// Plataforma GoodBarber, API REST pública (api.ww-api.com).
//
// Output:
//   _planning/carriers/brazillionaires_portal/raw/{section}/items/{itemId}.json
//   _planning/carriers/brazillionaires_portal/raw/{section}/pdfs/{pdfId}.pdf
//   _planning/carriers/brazillionaires_portal/raw/{section}/pdfs/{pdfId}.txt
//   _planning/carriers/brazillionaires_portal/raw/_video-queue.json
//
// Uso: npx tsx scripts/crawl-brazillionaires.ts

import { mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const WEBZINE_ID = 2009698;
const REFERER = "https://brazillionaires.virtualnet.site/";
const API_BASE = "https://api.ww-api.com/front/get_items";
const PDF_BASE = "https://brazillionaires.virtualnet.site/apiv3/attachment/download";
const ROOT = join(process.cwd(), "_planning", "carriers", "brazillionaires_portal", "raw");

// Sections selecionadas pelo Pedro (Bootcamps fora de scope)
interface SectionDef {
  slug: string;
  parentName: string;
  subSections: { id: number; name: string }[];
}

const SECTIONS: SectionDef[] = [
  {
    slug: "eventos",
    parentName: "Comece Aqui / Eventos",
    subSections: [
      { id: 66043736, name: "Fazer a Prova" },
      { id: 64067065, name: "Como Funciona a Profissão" },
      { id: 64067113, name: "Passei na Prova, e Agora" },
      { id: 64568456, name: "Como Convidar" },
    ],
  },
  {
    slug: "aprender-profissao",
    parentName: "Aprender a Profissão",
    subSections: [
      { id: 64072072, name: "Como Atender Clientes" },
      { id: 64072885, name: "Termo+Benefício em Vida" },
      { id: 64072908, name: "Plano Indexado" },
      { id: 64072912, name: "401k+Annuities" },
      { id: 64790960, name: "Como Conhecer Pessoas" },
      { id: 65604413, name: "Bônus" },
    ],
  },
  {
    slug: "aprender-aplicacao",
    parentName: "Aprender Aplicação",
    subSections: [
      { id: 64173649, name: "Como Fazer a Aplicação" },
      { id: 64173681, name: "Processo de Underwriting" },
    ],
  },
];

interface RawItem {
  type?: string;
  id: number;
  author?: string;
  title: string;
  date?: string;
  summary?: string;
  content?: string;
  images?: { url: string }[];
  [key: string]: unknown;
}

interface VideoQueueEntry {
  itemId: number;
  itemTitle: string;
  section: string;
  subSectionId: number;
  subSectionName: string;
  vimeoId: string;
  vimeoHash: string | null;
  playerUrl: string;
}

interface PdfQueueEntry {
  itemId: number;
  itemTitle: string;
  section: string;
  pdfId: string;
  url: string;
}

const VIMEO_REGEX = /player\.vimeo\.com\/video\/(\d+)(?:\?h=([a-f0-9]+))?/g;
const PDF_REGEX = /attachment\/download\/(\d+)/g;

async function fetchJson(url: string): Promise<{ items?: RawItem[] }> {
  const res = await fetch(url, { headers: { Referer: REFERER } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.json();
}

async function downloadFile(url: string, dest: string): Promise<boolean> {
  if (existsSync(dest)) return false;
  const res = await fetch(url, { headers: { Referer: REFERER } });
  if (!res.ok) {
    console.warn(`  ⚠️  download failed ${res.status}: ${url}`);
    return false;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buffer);
  return true;
}

function extractFilename(contentDisposition: string | null): string | null {
  if (!contentDisposition) return null;
  const m = contentDisposition.match(/filename="?([^"]+)"?/);
  return m ? m[1] : null;
}

async function downloadPdf(pdfId: string, destDir: string): Promise<{ filename: string; size: number } | null> {
  const url = `${PDF_BASE}/${pdfId}/`;
  const dest = join(destDir, `${pdfId}.pdf`);
  if (existsSync(dest)) {
    return { filename: `${pdfId}.pdf`, size: 0 };
  }
  const res = await fetch(url, { headers: { Referer: REFERER } });
  if (!res.ok) {
    console.warn(`  ⚠️  PDF ${pdfId} HTTP ${res.status}`);
    return null;
  }
  const filename = extractFilename(res.headers.get("content-disposition")) || `${pdfId}.pdf`;
  const buffer = Buffer.from(await res.arrayBuffer());
  await writeFile(dest, buffer);
  // pdftotext extraction
  try {
    execSync(`pdftotext -layout "${dest}" "${dest.replace(".pdf", ".txt")}"`, { stdio: "ignore" });
  } catch {
    console.warn(`  ⚠️  pdftotext falhou pro PDF ${pdfId}`);
  }
  return { filename, size: buffer.length };
}

function htmlToText(html: string): string {
  // Remove script/style tags (raros mas defensive)
  let text = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  text = text.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  // Vimeo iframe → marker
  text = text.replace(
    /<iframe[^>]*player\.vimeo\.com\/video\/(\d+)[^>]*>[\s\S]*?<\/iframe>/g,
    "[VIDEO:vimeo:$1]"
  );
  // PDF link → marker
  text = text.replace(
    /<a[^>]*href="[^"]*attachment\/download\/(\d+)\/?[^"]*"[^>]*>([^<]*)<\/a>/g,
    "[PDF:$1:$2]"
  );
  // Convert basic HTML to text
  text = text.replace(/<br\s*\/?>/gi, "\n");
  text = text.replace(/<\/p>/gi, "\n\n");
  text = text.replace(/<\/li>/gi, "\n");
  text = text.replace(/<li[^>]*>/gi, "- ");
  text = text.replace(/<[^>]+>/g, " "); // strip remaining tags
  // Decode HTML entities (basic)
  text = text.replace(/&nbsp;/g, " ");
  text = text.replace(/&amp;/g, "&");
  text = text.replace(/&lt;/g, "<");
  text = text.replace(/&gt;/g, ">");
  text = text.replace(/&quot;/g, '"');
  text = text.replace(/&#39;/g, "'");
  text = text.replace(/&aacute;/g, "á");
  text = text.replace(/&eacute;/g, "é");
  text = text.replace(/&iacute;/g, "í");
  text = text.replace(/&oacute;/g, "ó");
  text = text.replace(/&uacute;/g, "ú");
  text = text.replace(/&atilde;/g, "ã");
  text = text.replace(/&otilde;/g, "õ");
  text = text.replace(/&ccedil;/g, "ç");
  // Whitespace cleanup
  text = text.replace(/[ \t]+/g, " ");
  text = text.replace(/\n[ \t]+/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n");
  return text.trim();
}

async function main() {
  await mkdir(ROOT, { recursive: true });

  const videoQueue: VideoQueueEntry[] = [];
  const pdfsDownloaded: PdfQueueEntry[] = [];
  let totalItems = 0;
  let totalErrors = 0;

  console.log(`\n[crawl] Webzine ${WEBZINE_ID} | ${SECTIONS.length} sections selecionadas\n`);

  for (const sec of SECTIONS) {
    const secDir = join(ROOT, sec.slug);
    await mkdir(join(secDir, "items"), { recursive: true });
    await mkdir(join(secDir, "pdfs"), { recursive: true });
    await mkdir(join(secDir, "transcripts"), { recursive: true });

    console.log(`\n=== ${sec.parentName} ===`);

    for (const sub of sec.subSections) {
      console.log(`\n  [${sub.id}] ${sub.name}`);

      let items: RawItem[];
      try {
        const data = await fetchJson(`${API_BASE}/${WEBZINE_ID}/${sub.id}/?category_index=0`);
        items = data.items || [];
      } catch (err) {
        console.error(`  ✗ fetch falhou: ${err}`);
        totalErrors++;
        continue;
      }

      console.log(`    ${items.length} items`);

      for (const item of items) {
        totalItems++;
        const itemFile = join(secDir, "items", `${item.id}.json`);

        // Save raw JSON pra referência futura
        await writeFile(itemFile, JSON.stringify(item, null, 2));

        // Save markdown processado (text-friendly)
        const content = item.content || "";
        const cleanText = htmlToText(content);
        const md = [
          `# ${item.title}`,
          ``,
          `**Author:** ${item.author || "—"}  `,
          `**Date:** ${item.date || "—"}  `,
          `**Item ID:** ${item.id}  `,
          `**Section:** ${sec.parentName} → ${sub.name}  `,
          `**Section ID:** ${sub.id}  `,
          ``,
          `## Summary`,
          ``,
          item.summary || "(sem summary)",
          ``,
          `## Content`,
          ``,
          cleanText || "(sem conteúdo de texto)",
          ``,
        ].join("\n");
        await writeFile(itemFile.replace(".json", ".md"), md);

        // Extract Vimeo IDs
        const vimeoMatches = Array.from((item.content || "").matchAll(VIMEO_REGEX));
        for (const m of vimeoMatches) {
          const vimeoId = m[1];
          const vimeoHash = m[2] || null;
          const playerUrl = vimeoHash
            ? `https://player.vimeo.com/video/${vimeoId}?h=${vimeoHash}`
            : `https://player.vimeo.com/video/${vimeoId}`;
          videoQueue.push({
            itemId: item.id,
            itemTitle: item.title,
            section: sec.slug,
            subSectionId: sub.id,
            subSectionName: sub.name,
            vimeoId,
            vimeoHash,
            playerUrl,
          });
        }

        // Download PDFs
        const pdfMatches = new Set<string>();
        for (const m of (item.content || "").matchAll(PDF_REGEX)) {
          pdfMatches.add(m[1]);
        }
        for (const pdfId of pdfMatches) {
          const result = await downloadPdf(pdfId, join(secDir, "pdfs"));
          if (result) {
            pdfsDownloaded.push({
              itemId: item.id,
              itemTitle: item.title,
              section: sec.slug,
              pdfId,
              url: `${PDF_BASE}/${pdfId}/`,
            });
            console.log(`      📄 PDF ${pdfId}: ${result.filename}`);
          }
        }

        const videoCount = vimeoMatches.length;
        if (videoCount > 0 || pdfMatches.size > 0) {
          console.log(`    ✓ ${item.id} "${item.title.slice(0, 50)}" (${videoCount} videos, ${pdfMatches.size} PDFs)`);
        } else {
          console.log(`    ✓ ${item.id} "${item.title.slice(0, 50)}" (text only)`);
        }
      }
    }
  }

  // Save queue files
  const queueFile = join(ROOT, "_video-queue.json");
  await writeFile(queueFile, JSON.stringify(videoQueue, null, 2));

  const pdfManifest = join(ROOT, "_pdfs-manifest.json");
  await writeFile(pdfManifest, JSON.stringify(pdfsDownloaded, null, 2));

  console.log(`\n\n=== Crawl summary ===`);
  console.log(`Total items: ${totalItems}`);
  console.log(`Video queue: ${videoQueue.length} entries`);
  console.log(`PDFs downloaded: ${pdfsDownloaded.length}`);
  console.log(`Errors: ${totalErrors}`);
  console.log(`\nVideo queue saved: ${queueFile}`);
  console.log(`PDFs manifest saved: ${pdfManifest}`);
  console.log(`\nNext: rodar scripts/transcribe-vimeo-batch.ts pra processar vídeos.`);
}

main().catch((err) => {
  console.error("[crawl] falha catastrófica:", err);
  process.exit(1);
});
