/**
 * Parser unificado de arquivos pro Sparkbot.
 *
 * Compartilhado entre:
 *   - Web UI: POST /api/sparkbot/upload (multipart) → parse(buffer)
 *   - WhatsApp webhook: extractMediaAttachments → parse(buffer)
 *
 * Pass-through: não persistimos arquivo original. Retornamos dados
 * parseados (texto/base64/rows) e caller monta RepInput.
 *
 * Limites:
 *   - imagem: 10 MB → base64 inline (vision)
 *   - PDF: 10 MB → unpdf extract → texto
 *   - CSV/XLSX: 5 MB / 500 rows truncate → estrutura tabular
 */

import { parse as papaParse } from "papaparse";
// RISCO ACEITO (Pedro 2026-05-27, ultra-review): xlsx@0.18.5 tem CVEs high sem fix
// no npm (GHSA-4r6h-8v6p-xvw6 prototype pollution, GHSA-5pgg-2g8v-p4x9 ReDoS) — a
// lib foi abandonada no npm (SheetJS migrou pro tarball próprio). Mantido por ora:
// o parse SÓ roda em upload de rep/admin AUTENTICADO (anexo ao SparkBot / base de
// conhecimento), com limite de tamanho (FILE_LIMITS.xlsx) — NÃO é exposto a lead
// externo, então a exploitabilidade real é baixa. Migrar pro tarball oficial do
// SheetJS é a saída quando valer adicionar a build-dep do cdn.sheetjs.com. Ver
// docs/DECISIONS.md.
import * as XLSX from "xlsx";
import type { RepInput, TabularData, TabularSheet } from "@/types/account-assistant";

// ============================================================
// Constantes
// ============================================================
export const FILE_LIMITS = {
  image: 10 * 1024 * 1024,        // 10 MB
  pdf: 10 * 1024 * 1024,          // 10 MB
  csv: 5 * 1024 * 1024,           // 5 MB
  xlsx: 10 * 1024 * 1024,         // 10 MB
} as const;

export const TABULAR_MAX_ROWS = 500;
export const PDF_MAX_TEXT_CHARS = 50_000; // truncate texto extraído

// ============================================================
// Tipo de detecção
// ============================================================
export type FileKind = "image" | "pdf" | "csv" | "xlsx" | "heic" | "unknown";

// Fix Track 8 H-MM-6 (review 2026-05-05): adicionado image/heic + image/heif
// pra iPhones (~40% dos reps). Ainda não converte automaticamente — só
// rejeita com mensagem clara. Conversion via heic-convert lib é nice-to-have.
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
const HEIC_MIMES = ["image/heic", "image/heif"];
const CSV_MIMES = ["text/csv", "application/csv", "text/plain"];
const XLSX_MIMES = [
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/x-excel",
];

/**
 * Detecta kind a partir de mime + filename. Trust mime first; fallback
 * pra extensão se mime for genérico.
 */
export function detectFileKind(mime: string | undefined, filename: string | undefined): FileKind {
  const m = (mime || "").toLowerCase();
  const fn = (filename || "").toLowerCase();
  // HEIC/HEIF (iPhone default) — detecta separado pra dar mensagem clara
  if (HEIC_MIMES.some((x) => m.startsWith(x)) || fn.endsWith(".heic") || fn.endsWith(".heif")) {
    return "heic";
  }
  if (IMAGE_MIMES.some((x) => m.startsWith(x))) return "image";
  if (m === "application/pdf") return "pdf";
  if (XLSX_MIMES.some((x) => m === x)) return "xlsx";
  // Fix Pedro 2026-05-19: text/csv e application/csv são EXPLICITAMENTE CSV —
  // não exigir extensão no filename (caso Stevo: attachment é URL-string sem
  // fileName → filename vira "arquivo" sem ext, e o CSV era rejeitado como
  // "Tipo não suportado: text/csv"). Só text/plain precisa confirmar extensão.
  if (m === "text/csv" || m === "application/csv") return "csv";
  if (m === "text/plain") {
    // text/plain pode ser muita coisa — checa extensão
    return fn.endsWith(".csv") ? "csv" : "unknown";
  }
  // Fallback por extensão
  if (fn.endsWith(".png") || fn.endsWith(".jpg") || fn.endsWith(".jpeg") || fn.endsWith(".webp") || fn.endsWith(".gif")) return "image";
  if (fn.endsWith(".pdf")) return "pdf";
  if (fn.endsWith(".csv")) return "csv";
  if (fn.endsWith(".xlsx") || fn.endsWith(".xls")) return "xlsx";
  return "unknown";
}

// ============================================================
// Erros tipados
// ============================================================
export class FileProcessError extends Error {
  constructor(public code: string, message: string) {
    super(message);
    this.name = "FileProcessError";
  }
}

// ============================================================
// Parsers
// ============================================================

/** Imagem → base64 data URI inline. Validação básica de tamanho. */
function processImage(buffer: Buffer, mime: string, filename: string): Extract<RepInput, { kind: "image" }> {
  if (buffer.length > FILE_LIMITS.image) {
    throw new FileProcessError("file_too_large", `imagem maior que ${FILE_LIMITS.image / 1024 / 1024} MB`);
  }
  const mimeOk = IMAGE_MIMES.find((m) => mime.startsWith(m)) || "image/jpeg";
  const base64 = buffer.toString("base64");
  return {
    kind: "image",
    base64_data_uri: `data:${mimeOk};base64,${base64}`,
    filename,
  };
}

/** PDF → texto via unpdf. Trunca a PDF_MAX_TEXT_CHARS pra não estourar prompt. */
async function processPdf(buffer: Buffer, filename: string): Promise<Extract<RepInput, { kind: "document" }>> {
  if (buffer.length > FILE_LIMITS.pdf) {
    throw new FileProcessError("file_too_large", `PDF maior que ${FILE_LIMITS.pdf / 1024 / 1024} MB`);
  }
  // Lazy import — unpdf é pesado (~2 MB) e nem todo path precisa.
  const { extractText, getDocumentProxy } = await import("unpdf");
  try {
    const u8 = new Uint8Array(buffer);
    const pdf = await getDocumentProxy(u8);
    const { text } = await extractText(pdf, { mergePages: true });
    let extracted = Array.isArray(text) ? text.join("\n") : text;
    extracted = (extracted || "").trim();
    if (!extracted) {
      throw new FileProcessError("pdf_empty", "PDF sem texto extraível (pode ser imagem scaneada)");
    }
    if (extracted.length > PDF_MAX_TEXT_CHARS) {
      extracted = extracted.slice(0, PDF_MAX_TEXT_CHARS) + `\n\n[…truncado em ${PDF_MAX_TEXT_CHARS} chars]`;
    }
    return { kind: "document", extracted_text: extracted, filename };
  } catch (err) {
    if (err instanceof FileProcessError) throw err;
    throw new FileProcessError("pdf_parse_failed", `Falha extraindo PDF: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** CSV → TabularData. Detecta delimiter auto, header na primeira linha. */
function processCsv(buffer: Buffer, filename: string): Extract<RepInput, { kind: "tabular" }> {
  if (buffer.length > FILE_LIMITS.csv) {
    throw new FileProcessError("file_too_large", `CSV maior que ${FILE_LIMITS.csv / 1024 / 1024} MB`);
  }
  // Tenta UTF-8; se falhar, tenta latin1 (CSV brasileiro velho)
  let text = "";
  try {
    text = buffer.toString("utf-8");
    // Detecta BOM e remove
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  } catch {
    text = buffer.toString("latin1");
  }
  if (!text.trim()) {
    throw new FileProcessError("csv_empty", "CSV vazio");
  }

  const result = papaParse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
    dynamicTyping: false, // mantém tudo string — bot decide tipos
    transformHeader: (h) => h.trim(),
  });

  if (result.errors && result.errors.length > 0 && result.data.length === 0) {
    const e = result.errors[0];
    throw new FileProcessError("csv_parse_failed", `Falha parseando CSV: ${e.message}`);
  }

  const allRows = result.data.filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
  const totalRows = allRows.length;
  const rows = allRows.slice(0, TABULAR_MAX_ROWS);
  const columns = result.meta.fields || (rows[0] ? Object.keys(rows[0]) : []);

  if (totalRows === 0) {
    throw new FileProcessError("csv_no_rows", "CSV sem linhas com dados");
  }

  return {
    kind: "tabular",
    tabular: {
      filename,
      columns,
      total_rows: totalRows,
      rows: rows as Array<Record<string, string | number | null>>,
      source_mime: "text/csv",
    },
  };
}

/** XLSX → TabularData. Lê todas sheets, ativa = primeira não-vazia. */
function processXlsx(buffer: Buffer, filename: string): Extract<RepInput, { kind: "tabular" }> {
  if (buffer.length > FILE_LIMITS.xlsx) {
    throw new FileProcessError("file_too_large", `XLSX maior que ${FILE_LIMITS.xlsx / 1024 / 1024} MB`);
  }
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: false });
  } catch (err) {
    throw new FileProcessError("xlsx_parse_failed", `Falha parseando XLSX: ${err instanceof Error ? err.message : String(err)}`);
  }

  const sheets: TabularSheet[] = [];
  let activeSheet: TabularSheet | null = null;

  for (const sheetName of workbook.SheetNames) {
    const ws = workbook.Sheets[sheetName];
    const json = XLSX.utils.sheet_to_json<Record<string, string | number | null>>(ws, {
      defval: null,
      raw: false, // formata datas/numbers como string
    });
    if (json.length === 0) continue;

    const allRows = json.filter((r) => Object.values(r).some((v) => v !== null && v !== ""));
    const totalRows = allRows.length;
    const rows = allRows.slice(0, TABULAR_MAX_ROWS);
    const columns = rows[0] ? Object.keys(rows[0]) : [];

    const sheet: TabularSheet = { name: sheetName, columns, total_rows: totalRows, rows };
    sheets.push(sheet);
    if (!activeSheet && totalRows > 0) activeSheet = sheet;
  }

  if (!activeSheet) {
    throw new FileProcessError("xlsx_no_data", "XLSX sem sheets com dados");
  }

  const tabular: TabularData = {
    filename,
    columns: activeSheet.columns,
    total_rows: activeSheet.total_rows,
    rows: activeSheet.rows,
    sheets,
    active_sheet: activeSheet.name,
    source_mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  };

  return { kind: "tabular", tabular };
}

/**
 * Detecta o tipo do arquivo pelos magic bytes do conteúdo (fallback quando
 * mime/filename não bastam). Pedro 2026-05-19.
 */
export function sniffFileKind(buffer: Buffer): FileKind {
  if (buffer.length < 4) return "unknown";
  const b = buffer;

  // PDF: "%PDF"
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "pdf";

  // JPEG: FF D8 FF
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image";
  // PNG: 89 50 4E 47
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image";
  // GIF: "GIF8"
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return "image";
  // WEBP: "RIFF"..."WEBP"
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
      b.length >= 12 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image";
  // HEIC: bytes 4-11 contêm "ftypheic"/"ftypheif"/"ftypmif1"
  if (b.length >= 12) {
    const ftyp = b.toString("ascii", 4, 12);
    if (/ftyp(heic|heif|hevc|mif1|msf1)/i.test(ftyp)) return "heic";
  }

  // XLSX (ZIP): "PK\x03\x04" — mas .docx/.pptx também são ZIP. Pra MVP
  // assumimos planilha (caso de uso dominante). XLS velho: D0 CF 11 E0.
  if (b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04) return "xlsx";
  if (b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0) return "xlsx";

  // CSV/texto: primeiros bytes são ASCII/UTF-8 imprimível + tem delimitador.
  // Heurística conservadora: amostra 500 bytes, >90% imprimível, tem vírgula
  // ou ; ou tab + quebra de linha.
  const sample = b.subarray(0, Math.min(500, b.length));
  let printable = 0;
  for (const byte of sample) {
    if (byte === 0x09 || byte === 0x0a || byte === 0x0d || (byte >= 0x20 && byte <= 0x7e) || byte >= 0x80) {
      printable++;
    }
  }
  const ratio = printable / sample.length;
  const text = sample.toString("utf8");
  if (ratio > 0.9 && /[,;\t]/.test(text) && /[\r\n]/.test(text)) return "csv";

  return "unknown";
}

// ============================================================
// API pública
// ============================================================

export interface ProcessFileInput {
  buffer: Buffer;
  mime?: string;
  filename: string;
  kindHint?: FileKind;
}

export interface ProcessFileResult {
  kind: FileKind;
  repInput: RepInput;
  /** Resumo curto pra UI mostrar como chip + bot ver no contexto. */
  summary: string;
}

/**
 * Entry point unificado. Detecta tipo, valida tamanho, parse e retorna
 * RepInput pronto pra `processIncoming`. Caller só passa o buffer cru.
 */
export async function processFile(input: ProcessFileInput): Promise<ProcessFileResult> {
  let kind = input.kindHint || detectFileKind(input.mime, input.filename);
  // Fix Pedro 2026-05-19: quando mime+filename não bastam (ex: Stevo manda
  // URL sem extensão + contentType genérico), faz sniffing dos magic bytes
  // do conteúdo. Cobre foto tirada na hora, arquivo renomeado, etc.
  if (kind === "unknown") {
    const sniffed = sniffFileKind(input.buffer);
    if (sniffed !== "unknown") {
      console.log(`[file-processor] kind detectado via sniffing: ${sniffed} (mime=${input.mime}, fn=${input.filename})`);
      kind = sniffed;
    }
  }
  if (kind === "unknown") {
    throw new FileProcessError("unsupported_type", `Tipo não suportado: ${input.mime || input.filename}`);
  }
  // Fix Track 8 H-MM-6: HEIC do iPhone — Claude/GPT-4 Vision não aceitam.
  // Antes silently rejeitado em "unknown" → rep não sabia. Agora mensagem
  // explícita pra rep mudar formato no celular.
  if (kind === "heic") {
    throw new FileProcessError(
      "heic_not_supported",
      "Foto em formato HEIC do iPhone não é suportada ainda. Pra resolver: Settings > Câmera > Formatos > 'Mais Compatível' (vai virar JPG). Ou tira print da foto e manda o screenshot.",
    );
  }

  let repInput: RepInput;
  let summary: string;

  if (kind === "image") {
    repInput = processImage(input.buffer, input.mime || "image/jpeg", input.filename);
    summary = `Imagem ${input.filename} (${formatBytes(input.buffer.length)})`;
  } else if (kind === "pdf") {
    repInput = await processPdf(input.buffer, input.filename);
    const r = repInput as Extract<RepInput, { kind: "document" }>;
    summary = `PDF ${input.filename} — ${r.extracted_text.length.toLocaleString()} chars de texto`;
  } else if (kind === "csv") {
    repInput = processCsv(input.buffer, input.filename);
    const r = repInput as Extract<RepInput, { kind: "tabular" }>;
    summary = `CSV ${input.filename} — ${r.tabular.total_rows} linhas, ${r.tabular.columns.length} colunas`;
  } else if (kind === "xlsx") {
    repInput = processXlsx(input.buffer, input.filename);
    const r = repInput as Extract<RepInput, { kind: "tabular" }>;
    summary = `Excel ${input.filename} — ${r.tabular.total_rows} linhas, ${r.tabular.columns.length} colunas`
      + (r.tabular.sheets && r.tabular.sheets.length > 1 ? ` (${r.tabular.sheets.length} sheets)` : "");
  } else {
    throw new FileProcessError("unsupported_type", `kind ${kind} não tratado`);
  }

  return { kind, repInput, summary };
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
