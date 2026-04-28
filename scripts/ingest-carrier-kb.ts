// Ingestão da Carrier Knowledge Base (RAG via pgvector).
//
// Lê _planning/carriers/{carrier}/**/*.md, parseia frontmatter YAML,
// gera embedding via OpenAI, UPSERT em carrier_knowledge.
//
// Idempotente: usa content_hash (sha256 do corpo) pra detectar se chunk
// mudou. Se hash igual ao DB, pula embedding — economiza tempo e custo.
//
// Uso:
//   npx tsx scripts/ingest-carrier-kb.ts --carrier=national_life_group [--dry-run] [--force-embed]
//
// Variáveis necessárias (de .env.local — projeto carrega via Next, mas
// script standalone precisa carregar manual):
//   OPENAI_API_KEY
//   NEXT_PUBLIC_SUPABASE_URL
//   SUPABASE_SERVICE_ROLE_KEY
//
// O script:
//   1. carrega .env.local
//   2. walk MD files (pula raw/ e README.md/_template.md)
//   3. parse frontmatter; valida campos obrigatórios
//   4. compute content_hash; lookup existente no DB
//   5. se hash mudou OU --force-embed: gera embedding, UPSERT
//   6. se hash igual: pula embedding mas atualiza metadata se mudou
//   7. log estruturado por chunk + resumo final

import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import matter from "gray-matter";
import OpenAI from "openai";
import { createClient } from "@supabase/supabase-js";

// Voyage com payment method (não cobra dentro de 200M tokens free) = 2000 RPM.
// Sem payment method = 3 RPM. Definimos delay mínimo conservador via env var
// ou padrão 100ms (= 600 RPM, abaixo do limit pago). Backoff em 429.
let lastVoyageCall = 0;
const VOYAGE_MIN_INTERVAL_MS = parseInt(process.env.VOYAGE_MIN_INTERVAL_MS || "100", 10);

async function embedVoyage(input: string, key: string, retries = 3): Promise<number[]> {
  const now = Date.now();
  const elapsed = now - lastVoyageCall;
  if (elapsed < VOYAGE_MIN_INTERVAL_MS) {
    await new Promise((r) => setTimeout(r, VOYAGE_MIN_INTERVAL_MS - elapsed));
  }
  lastVoyageCall = Date.now();

  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      input,
      model: "voyage-3-large",
      input_type: "document",
    }),
  });
  if (res.status === 429 && retries > 0) {
    // Rate limit hit (apesar do delay). Aguarda 60s + retry.
    const errText = await res.text();
    console.warn(`  ⏳ Voyage 429 — aguardando 60s antes de retry (${errText.slice(0, 100)})`);
    await new Promise((r) => setTimeout(r, 60_000));
    return embedVoyage(input, key, retries - 1);
  }
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Voyage API ${res.status}: ${errText.slice(0, 300)}`);
  }
  const data = await res.json() as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

// ---------- env loading -----------------------------------------------------
// Script roda fora do Next, então tem que carregar .env.local na unha.
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
loadDotEnv(join(process.cwd(), ".env"));

// Provider config — DEPOIS do loadDotEnv pra ler env vars já populadas.
// Voyage primary (free tier generoso, 1024 dims voyage-3-large).
// OpenAI fallback (1536 dims text-embedding-3-small) — usado se VOYAGE_API_KEY
// ausente. Nota: schema atual é vector(1024) (migration 00039), então OpenAI
// fallback NÃO funciona sem revert da migration.
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const EMBEDDING_PROVIDER = VOYAGE_KEY ? "voyage" : "openai";
const EMBEDDING_MODEL = VOYAGE_KEY ? "voyage-3-large" : "text-embedding-3-small";

// ---------- types -----------------------------------------------------------
interface ChunkFrontmatter {
  carrier: string;
  category: "overview" | "product" | "rider" | "underwriting" | "compliance"
            | "process" | "pitfall" | "resource" | "commission" | "workflow";
  subcategory?: string;
  slug: string;
  title: string;
  priority: "always" | "on_demand";
  product_refs?: string[];
  state_specific?: string[] | null;
  tags?: string[];
  applies_to_companies?: string[];
  source: "official" | "imo" | "community" | "synthetic";
  source_url?: string;
  source_doc_cat?: string;
  last_verified?: string; // ISO date YYYY-MM-DD
}

interface IngestResult {
  status: "inserted" | "updated" | "skipped" | "metadata_only" | "error";
  slug: string;
  path: string;
  message?: string;
}

interface Options {
  dryRun: boolean;
  forceEmbed: boolean;
  actorUserId: string;
}

// ---------- helpers ---------------------------------------------------------
async function walkMarkdown(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const path = join(dir, e.name);
    if (e.isDirectory()) {
      // Pula raw/ (PDFs extraídos servem de referência, não vão pra KB)
      // Pula _* (subdirs internos tipo _templates/_examples)
      if (e.name === "raw" || e.name.startsWith("_")) continue;
      out.push(...(await walkMarkdown(path)));
    } else if (e.name.endsWith(".md")) {
      // Pula arquivos meta — só ingere chunks reais
      if (e.name === "README.md" || e.name === "_template.md") continue;
      out.push(path);
    }
  }
  return out;
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function validateFrontmatter(fm: Partial<ChunkFrontmatter>, path: string): string | null {
  const required = ["carrier", "category", "slug", "title", "priority", "source"] as const;
  for (const key of required) {
    if (!fm[key]) return `frontmatter.${key} obrigatório (${path})`;
  }
  if (!["always", "on_demand"].includes(fm.priority!)) {
    return `priority deve ser 'always' ou 'on_demand' (${path})`;
  }
  if (!["official", "imo", "community", "synthetic"].includes(fm.source!)) {
    return `source inválido (${path})`;
  }
  const validCategories = ["overview", "product", "rider", "underwriting", "compliance",
                           "process", "pitfall", "resource", "commission", "workflow"];
  if (!validCategories.includes(fm.category!)) {
    return `category inválida — use uma de: ${validCategories.join(", ")} (${path})`;
  }
  return null;
}

// ---------- core ingestion --------------------------------------------------
async function processFile(
  path: string,
  baseDir: string,
  openai: OpenAI,
  supabase: ReturnType<typeof createClient>,
  opts: Options,
): Promise<IngestResult> {
  const relPath = relative(baseDir, path);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    return { status: "error", slug: relPath, path: relPath, message: `read failed: ${err}` };
  }

  const { data, content } = matter(raw);
  const fm = data as Partial<ChunkFrontmatter>;

  const validationErr = validateFrontmatter(fm, relPath);
  if (validationErr) {
    return { status: "error", slug: fm.slug || relPath, path: relPath, message: validationErr };
  }

  const trimmedContent = content.trim();
  if (trimmedContent.length === 0) {
    return { status: "error", slug: fm.slug!, path: relPath, message: "corpo vazio" };
  }
  if (trimmedContent.length > 5000) {
    return {
      status: "error",
      slug: fm.slug!,
      path: relPath,
      message: `corpo ${trimmedContent.length} chars > 5000 (chunk muito grande — quebrar em sub-chunks)`,
    };
  }

  const contentHash = sha256(trimmedContent);

  // Lookup existente pra decidir embedding.
  // Cast genérico — types do Supabase não foram gerados pra carrier_knowledge,
  // e este script roda standalone (não precisa de strict typing do build).
  const { data: existingRaw } = await supabase
    .from("carrier_knowledge")
    .select("id, content_hash, embedding_model, embedded_at")
    .eq("carrier", fm.carrier!)
    .eq("category", fm.category!)
    .eq("slug", fm.slug!)
    .filter("subcategory", fm.subcategory ? "eq" : "is", fm.subcategory ?? "null")
    .maybeSingle();
  const existing = existingRaw as null | {
    id: string;
    content_hash: string;
    embedding_model: string | null;
    embedded_at: string | null;
  };

  const needsEmbed = opts.forceEmbed
    || !existing
    || existing.content_hash !== contentHash
    || existing.embedding_model !== EMBEDDING_MODEL;

  let embedding: number[] | null = null;
  if (needsEmbed && !opts.dryRun) {
    try {
      // Embedding input enriquecido: title + tags + category/subcategory + content.
      // Tags + categoria atuam como keyword boost — query "diabetes" mapeia
      // melhor pra chunk com tag "diabetes" do que se input fosse só content.
      const tagLine = (fm.tags && fm.tags.length > 0)
        ? `Tags: ${fm.tags.join(", ")}\n`
        : "";
      const subcatLine = fm.subcategory
        ? `Category: ${fm.category}/${fm.subcategory}\n`
        : `Category: ${fm.category}\n`;
      const embeddingInput = `${fm.title}\n${subcatLine}${tagLine}\n${trimmedContent}`;
      if (EMBEDDING_PROVIDER === "voyage") {
        embedding = await embedVoyage(embeddingInput, VOYAGE_KEY!);
      } else {
        const res = await openai.embeddings.create({
          model: "text-embedding-3-small",
          input: embeddingInput,
        });
        embedding = res.data[0].embedding;
      }
    } catch (err) {
      return {
        status: "error",
        slug: fm.slug!,
        path: relPath,
        message: `embedding falhou: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  if (opts.dryRun) {
    return {
      status: existing ? (needsEmbed ? "updated" : "skipped") : "inserted",
      slug: fm.slug!,
      path: relPath,
      message: `dry-run; needs_embed=${needsEmbed}`,
    };
  }

  const baseRow = {
    carrier: fm.carrier!,
    category: fm.category!,
    subcategory: fm.subcategory ?? null,
    slug: fm.slug!,
    title: fm.title!,
    content: trimmedContent,
    priority: fm.priority!,
    product_refs: fm.product_refs ?? null,
    state_specific: fm.state_specific ?? null,
    tags: fm.tags ?? null,
    applies_to_companies: fm.applies_to_companies ?? null,
    content_hash: contentHash,
    source: fm.source!,
    source_url: fm.source_url ?? null,
    source_doc_cat: fm.source_doc_cat ?? null,
    last_verified_at: fm.last_verified ? new Date(fm.last_verified).toISOString() : null,
    verified_by_user_id: fm.last_verified ? opts.actorUserId : null,
    last_modified_by_user_id: opts.actorUserId,
  };

  if (existing) {
    // UPDATE — se needsEmbed, sobe embedding novo; senão, só atualiza metadata.
    const updateRow: Record<string, unknown> = { ...baseRow };
    if (needsEmbed) {
      updateRow.embedding = embedding;
      updateRow.embedding_model = EMBEDDING_MODEL;
      updateRow.embedded_at = new Date().toISOString();
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await (supabase.from("carrier_knowledge") as any)
      .update(updateRow)
      .eq("id", existing.id);
    if (error) return { status: "error", slug: fm.slug!, path: relPath, message: (error as Error).message };
    return {
      status: needsEmbed ? "updated" : "metadata_only",
      slug: fm.slug!,
      path: relPath,
    };
  }

  // INSERT — chunk novo
  const insertRow = {
    ...baseRow,
    embedding,
    embedding_model: EMBEDDING_MODEL,
    embedded_at: embedding ? new Date().toISOString() : null,
    created_by_user_id: opts.actorUserId,
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { error } = await (supabase.from("carrier_knowledge") as any).insert(insertRow);
  if (error) return { status: "error", slug: fm.slug!, path: relPath, message: (error as Error).message };
  return { status: "inserted", slug: fm.slug!, path: relPath };
}

// ---------- main ------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const carrier = args.find((a) => a.startsWith("--carrier="))?.split("=")[1];
  if (!carrier) {
    console.error("Uso: npx tsx scripts/ingest-carrier-kb.ts --carrier=<slug> [--dry-run] [--force-embed]");
    process.exit(1);
  }
  const dryRun = args.includes("--dry-run");
  const forceEmbed = args.includes("--force-embed");

  const openaiKey = process.env.OPENAI_API_KEY;
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!openaiKey || !supabaseUrl || !supabaseKey) {
    console.error("ENVs faltando: OPENAI_API_KEY, NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY");
    process.exit(1);
  }

  const openai = new OpenAI({ apiKey: openaiKey });
  const supabase = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false },
  });

  const baseDir = join(process.cwd(), "_planning", "carriers", carrier);
  if (!existsSync(baseDir)) {
    console.error(`Diretório não existe: ${baseDir}`);
    process.exit(1);
  }

  console.log(`\n[ingest] carrier=${carrier} dry_run=${dryRun} force_embed=${forceEmbed}`);
  console.log(`[ingest] basedir=${baseDir}\n`);

  const files = await walkMarkdown(baseDir);
  console.log(`[ingest] ${files.length} arquivo(s) MD encontrado(s)\n`);

  if (files.length === 0) {
    console.log("[ingest] nada pra processar");
    process.exit(0);
  }

  const counts = { inserted: 0, updated: 0, skipped: 0, metadata_only: 0, error: 0 };
  const opts: Options = {
    dryRun,
    forceEmbed,
    actorUserId: process.env.INGEST_ACTOR_USER_ID || "ingest-script",
  };

  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await processFile(file, baseDir, openai, supabase as any, opts);
    counts[result.status]++;
    const emoji = {
      inserted: "✓",
      updated: "↻",
      skipped: "—",
      metadata_only: "≡",
      error: "✗",
    }[result.status];
    const msg = result.message ? ` (${result.message})` : "";
    console.log(`  ${emoji} ${result.slug.padEnd(40)} ${result.path}${msg}`);
  }

  console.log(`\n[ingest] resumo:`);
  console.log(`  ✓ ${counts.inserted} inseridos`);
  console.log(`  ↻ ${counts.updated} atualizados (re-embedded)`);
  console.log(`  ≡ ${counts.metadata_only} só metadata (hash igual)`);
  console.log(`  — ${counts.skipped} skipped (dry-run)`);
  console.log(`  ✗ ${counts.error} erros\n`);

  process.exit(counts.error > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[ingest] falha catastrófica:", err);
  process.exit(1);
});
