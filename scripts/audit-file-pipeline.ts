// Auditoria do pipeline de arquivos via Stevo (attachment URL-string).
// Testa extractMediaAttachments → detectFileKind pra todos os tipos.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { extractMediaAttachments } from "@/lib/ai/media-extractor";
import { detectFileKind, sniffFileKind } from "@/lib/account-assistant/file-processor";

// Padrão real do Stevo: .../media/<tipo>/sparkbot/<ts>-<nome>.<ext>
const STEVO = "https://hel1.your-objectstorage.com/stevo/whatsapp/media";

interface Case {
  name: string;
  url: string;
  webhookContentType: string; // o que o webhook Stevo manda (vimos: text/plain)
  expectExtracted: boolean;
  expectKind: string;
}

const cases: Case[] = [
  // CSV (já validado)
  { name: "CSV com extensão", url: `${STEVO}/document/sparkbot/123-mentoria.csv`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "csv" },
  // XLSX
  { name: "XLSX com extensão", url: `${STEVO}/document/sparkbot/123-Lista%20Mentoria.xlsx`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "xlsx" },
  { name: "XLS (excel velho)", url: `${STEVO}/document/sparkbot/123-planilha.xls`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "xlsx" },
  // PDF
  { name: "PDF com extensão", url: `${STEVO}/document/sparkbot/123-proposta.pdf`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "pdf" },
  // Imagens
  { name: "JPG com extensão", url: `${STEVO}/image/sparkbot/123-foto.jpg`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "image" },
  { name: "JPEG com extensão", url: `${STEVO}/image/sparkbot/123-foto.jpeg`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "image" },
  { name: "PNG com extensão", url: `${STEVO}/image/sparkbot/123-print.png`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "image" },
  { name: "WEBP", url: `${STEVO}/image/sparkbot/123-img.webp`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "image" },
  { name: "HEIC (iPhone)", url: `${STEVO}/image/sparkbot/123-IMG_0042.heic`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "heic" },
  // EDGE CASES — sem extensão na URL (agora extraídos via path + sniffing)
  { name: "Imagem SEM extensão (path /image/)", url: `${STEVO}/image/sparkbot/abc-123-uuid`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "image" },
  { name: "Doc SEM extensão (path /document/)", url: `${STEVO}/document/sparkbot/abc-123-uuid`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "unknown" },
  // EDGE — query string após extensão
  { name: "CSV com query string", url: `${STEVO}/document/sparkbot/123-x.csv?token=abc&exp=999`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "csv" },
  { name: "JPG com query string", url: `${STEVO}/image/sparkbot/123-x.jpg?sig=xyz`, webhookContentType: "text/plain", expectExtracted: true, expectKind: "image" },
];

let pass = 0;
let warn = 0;
console.log("=== Auditoria pipeline de arquivos (Stevo URL-string) ===\n");

for (const c of cases) {
  const body = { attachments: [c.url], contentType: c.webhookContentType, messageType: "Custom" };
  const atts = extractMediaAttachments(body as Record<string, unknown>);
  const extracted = atts.length > 0;

  let kind = "unknown";
  if (extracted) {
    kind = detectFileKind(atts[0].contentType, atts[0].fileName);
  }

  const extractOk = extracted === c.expectExtracted;
  const kindOk = !extracted || kind === c.expectKind;
  const ok = extractOk && kindOk;

  const icon = ok ? "✅" : c.name.startsWith("⚠️") ? "⚠️ " : "❌";
  if (ok && !c.name.startsWith("⚠️")) pass++;
  if (c.name.startsWith("⚠️")) warn++;

  console.log(`${icon} ${c.name}`);
  console.log(`   extracted=${extracted} (exp ${c.expectExtracted}), kind=${kind} (exp ${c.expectKind})`);
  if (extracted) console.log(`   → ct=${atts[0].contentType}, fileName=${atts[0].fileName || "(none)"}`);
  console.log("");
}

console.log(`\n${pass} casos OK, ${warn} edge cases.\n`);

// ── Sniffing por magic bytes (fallback quando sem extensão) ──
console.log("=== Sniffing magic bytes (fallback p/ URL sem extensão) ===\n");
const sniffCases: Array<{ name: string; buf: Buffer; expect: string }> = [
  { name: "PDF magic", buf: Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d]), expect: "pdf" },
  { name: "JPEG magic", buf: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]), expect: "image" },
  { name: "PNG magic", buf: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]), expect: "image" },
  { name: "XLSX (ZIP) magic", buf: Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14]), expect: "xlsx" },
  { name: "CSV texto", buf: Buffer.from("Nome,Telefone\nPedro,7867717077\n"), expect: "csv" },
  { name: "Lixo binário", buf: Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]), expect: "unknown" },
];
let sniffPass = 0;
for (const s of sniffCases) {
  const k = sniffFileKind(s.buf);
  const ok = k === s.expect;
  if (ok) sniffPass++;
  console.log(`${ok ? "✅" : "❌"} ${s.name} → ${k} (exp ${s.expect})`);
}
console.log(`\n${sniffPass}/${sniffCases.length} sniffing OK`);
console.log("\nNOTA: 'Doc SEM extensão' vira octet-stream → detectFileKind=unknown,");
console.log("mas no processFile o sniffing dos magic bytes detecta o tipo real (csv/pdf/xlsx).");
