// Transcrição paralela de vídeos Vimeo do portal Brazillionaires.
//
// Pipeline por vídeo:
//   1. yt-dlp download m4a/mp3 (audio-only — economiza banda)
//   2. ffmpeg → mp3 16kHz mono 64kbps (formato ótimo pra Whisper)
//   3. Whisper API (verbose_json + segment timestamps)
//      Provider: GROQ_API_KEY presente → Groq whisper-large-v3 (free tier alto)
//                fallback: OpenAI whisper-1
//   4. Save transcripts/{itemId}-{vimeoId}.{json,md}
//   5. Cleanup intermediários
//
// Usa concurrency limitado pra respeitar rate limit + I/O local.
//
// Skipping inteligente: se já existe transcript .md no destino, pula.
//
// Uso: npx tsx scripts/transcribe-brazillionaires.ts [--workers=4]

import { mkdir, writeFile, readFile, unlink, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { execSync } from "node:child_process";
import { tmpdir } from "node:os";

import OpenAI from "openai";

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

const REFERER = "https://brazillionaires.virtualnet.site/";
const ROOT = join(process.cwd(), "_planning", "carriers", "agency_brazillionaires", "raw");
const QUEUE_FILE = join(ROOT, "_video-queue.json");

interface QueueEntry {
  itemId: number;
  itemTitle: string;
  section: string;
  subSectionId: number;
  subSectionName: string;
  vimeoId: string;
  vimeoHash: string | null;
  playerUrl: string;
}

interface ProcessResult {
  status: "success" | "skipped" | "error";
  itemId: number;
  vimeoId: string;
  duration?: number;
  textLength?: number;
  costUsd?: number;
  message?: string;
}

// Provider config: Groq se GROQ_API_KEY presente (drop-in OpenAI compat), senão OpenAI.
const GROQ_KEY = process.env.GROQ_API_KEY;
const PROVIDER = GROQ_KEY ? "groq" : "openai";
const PROVIDER_BASE_URL = GROQ_KEY ? "https://api.groq.com/openai/v1" : undefined;
// whisper-large-v3-turbo tem rate limit independente do large-v3 (free tier separado)
const WHISPER_MODEL = GROQ_KEY ? "whisper-large-v3-turbo" : "whisper-1";
// Groq free tier: $0.00 (até 14400s/min audio). OpenAI: $0.006/min.
const COST_PER_MIN = GROQ_KEY ? 0 : 0.006;

async function transcribeOne(entry: QueueEntry, openai: OpenAI): Promise<ProcessResult> {
  const sectionDir = join(ROOT, entry.section, "transcripts");
  await mkdir(sectionDir, { recursive: true });
  const outBase = join(sectionDir, `${entry.itemId}-${entry.vimeoId}`);
  const mdPath = `${outBase}.md`;
  const jsonPath = `${outBase}.json`;

  if (existsSync(mdPath) && existsSync(jsonPath)) {
    return { status: "skipped", itemId: entry.itemId, vimeoId: entry.vimeoId, message: "already exists" };
  }

  // Tmp dir único pra esse vídeo
  const tmp = join(tmpdir(), `nlg-vid-${entry.vimeoId}-${process.pid}`);
  await mkdir(tmp, { recursive: true });

  try {
    // 1. Download audio-only via yt-dlp (mais rápido que vídeo full)
    const ytdlpCmd = [
      "python3", "-m", "yt_dlp",
      "--quiet", "--no-warnings",
      "--referer", REFERER,
      "-f", "bestaudio/best",
      "-o", `"${join(tmp, "audio.%(ext)s")}"`,
      `"${entry.playerUrl}"`,
    ].join(" ");
    execSync(ytdlpCmd, { stdio: "ignore", timeout: 5 * 60 * 1000 });

    // Find downloaded file (extension varies)
    const downloaded = execSync(`ls "${tmp}"/audio.* 2>/dev/null | head -1`, { encoding: "utf8" }).trim();
    if (!downloaded) {
      throw new Error("yt-dlp não baixou nenhum arquivo");
    }

    // 2. Convert to MP3 16kHz mono. Groq/OpenAI Whisper limit é 25MB.
    //    Bitrate adaptativo: começa em 64K, se passar 25MB, retry com 24K.
    const mp3Path = join(tmp, "audio.mp3");
    let bitrate = "64k";
    let mp3Stat;
    for (const tryBitrate of ["64k", "32k", "24k"]) {
      bitrate = tryBitrate;
      execSync(`ffmpeg -y -i "${downloaded}" -vn -ar 16000 -ac 1 -b:a ${bitrate} "${mp3Path}" 2>/dev/null`, {
        timeout: 5 * 60 * 1000,
      });
      mp3Stat = await stat(mp3Path);
      if (mp3Stat.size < 25 * 1024 * 1024) break; // OK abaixo de 25MB
    }
    if (!mp3Stat || mp3Stat.size < 1000) {
      throw new Error("MP3 vazio ou muito pequeno");
    }
    if (mp3Stat.size > 25 * 1024 * 1024) {
      throw new Error(`MP3 ainda > 25MB mesmo com 24K bitrate (${mp3Stat.size} bytes)`);
    }

    // 3. Whisper API. Provider Groq ou OpenAI (compatible API).
    const audioFile = await readFile(mp3Path);
    const transcript = await openai.audio.transcriptions.create({
      file: new File([new Uint8Array(audioFile)], "audio.mp3", { type: "audio/mpeg" }),
      model: WHISPER_MODEL,
      response_format: "verbose_json",
      timestamp_granularities: ["segment"],
      language: "pt",
    });

    const duration = transcript.duration || 0;
    const text = transcript.text || "";
    const costUsd = (duration / 60) * COST_PER_MIN;

    // 4. Save outputs
    await writeFile(jsonPath, JSON.stringify({
      itemId: entry.itemId,
      itemTitle: entry.itemTitle,
      section: entry.section,
      subSectionName: entry.subSectionName,
      vimeoId: entry.vimeoId,
      vimeoHash: entry.vimeoHash,
      playerUrl: entry.playerUrl,
      duration,
      language: transcript.language,
      text,
      segments: transcript.segments || [],
      transcribedAt: new Date().toISOString(),
    }, null, 2));

    const md = [
      `# Transcript: ${entry.itemTitle}`,
      ``,
      `**Item ID:** ${entry.itemId}  `,
      `**Section:** ${entry.section} → ${entry.subSectionName}  `,
      `**Vimeo:** ${entry.vimeoId}  `,
      `**Duration:** ${Math.floor(duration / 60)}:${String(Math.floor(duration % 60)).padStart(2, "0")}  `,
      `**Language:** ${transcript.language}  `,
      ``,
      `---`,
      ``,
      text,
      ``,
    ].join("\n");
    await writeFile(mdPath, md);

    // 5. Cleanup
    try {
      await unlink(downloaded);
      await unlink(mp3Path);
    } catch {}

    return {
      status: "success",
      itemId: entry.itemId,
      vimeoId: entry.vimeoId,
      duration,
      textLength: text.length,
      costUsd,
    };
  } catch (err) {
    return {
      status: "error",
      itemId: entry.itemId,
      vimeoId: entry.vimeoId,
      message: err instanceof Error ? err.message : String(err),
    };
  } finally {
    // Cleanup tmp dir
    try { execSync(`rm -rf "${tmp}"`, { stdio: "ignore" }); } catch {}
  }
}

async function processBatch(entries: QueueEntry[], openai: OpenAI, workers: number): Promise<ProcessResult[]> {
  const results: ProcessResult[] = [];
  const queue = [...entries];
  let processed = 0;
  const total = entries.length;

  async function worker(workerId: number) {
    while (queue.length > 0) {
      const entry = queue.shift();
      if (!entry) break;

      const result = await transcribeOne(entry, openai);
      results.push(result);
      processed++;

      const emoji = { success: "✓", skipped: "—", error: "✗" }[result.status];
      const status = result.status === "success"
        ? `${Math.floor((result.duration || 0) / 60)}:${String(Math.floor((result.duration || 0) % 60)).padStart(2, "0")} (${(result.textLength || 0)} chars, $${(result.costUsd || 0).toFixed(3)})`
        : (result.message || "");

      console.log(
        `[w${workerId}] ${processed}/${total} ${emoji} ${entry.itemId}-${entry.vimeoId} "${entry.itemTitle.slice(0, 45)}" — ${status}`
      );
    }
  }

  await Promise.all(Array.from({ length: workers }, (_, i) => worker(i + 1)));
  return results;
}

async function main() {
  const args = process.argv.slice(2);
  const workers = parseInt(args.find(a => a.startsWith("--workers="))?.split("=")[1] || "4", 10);

  // Inicializa client baseado em provider detectado
  const apiKey = GROQ_KEY || process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error("Nem GROQ_API_KEY nem OPENAI_API_KEY configurados");
    process.exit(1);
  }
  const openai = new OpenAI({
    apiKey,
    baseURL: PROVIDER_BASE_URL,
  });
  console.log(`[transcribe] Provider: ${PROVIDER} (model: ${WHISPER_MODEL})`);

  if (!existsSync(QUEUE_FILE)) {
    console.error(`Queue file não existe: ${QUEUE_FILE}\nRoda crawl-brazillionaires.ts primeiro.`);
    process.exit(1);
  }
  const queue: QueueEntry[] = JSON.parse(readFileSync(QUEUE_FILE, "utf8"));

  // Dedup queue: mesmo Vimeo ID em múltiplos items vira 1 transcript referenciado
  const uniqueByVimeo = new Map<string, QueueEntry>();
  for (const e of queue) {
    if (!uniqueByVimeo.has(e.vimeoId)) {
      uniqueByVimeo.set(e.vimeoId, e);
    }
  }
  const entries = Array.from(uniqueByVimeo.values());

  console.log(`\n[transcribe] Queue: ${queue.length} entries, ${entries.length} vídeos únicos`);
  console.log(`[transcribe] Workers: ${workers}`);
  console.log(`[transcribe] Estimated cost: ~$${(entries.length * 38 * 0.006).toFixed(2)} (assuming avg 38min)\n`);

  const startMs = Date.now();
  const results = await processBatch(entries, openai, workers);
  const elapsedMs = Date.now() - startMs;

  const success = results.filter(r => r.status === "success");
  const skipped = results.filter(r => r.status === "skipped");
  const errors = results.filter(r => r.status === "error");

  const totalDur = success.reduce((s, r) => s + (r.duration || 0), 0);
  const totalCost = success.reduce((s, r) => s + (r.costUsd || 0), 0);

  console.log(`\n=== Transcribe summary ===`);
  console.log(`✓ Success: ${success.length}`);
  console.log(`— Skipped: ${skipped.length}`);
  console.log(`✗ Errors:  ${errors.length}`);
  console.log(`Total duration: ${Math.floor(totalDur / 60)} min`);
  console.log(`Total cost:     $${totalCost.toFixed(2)}`);
  console.log(`Wall time:      ${Math.floor(elapsedMs / 60000)} min`);

  if (errors.length > 0) {
    console.log(`\nErrors:`);
    for (const e of errors) {
      console.log(`  - ${e.itemId}-${e.vimeoId}: ${e.message}`);
    }
  }
}

main().catch((err) => {
  console.error("[transcribe] falha:", err);
  process.exit(1);
});
