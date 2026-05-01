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
export type FileKind = "image" | "pdf" | "csv" | "xlsx" | "unknown";

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/jpg", "image/webp", "image/gif"];
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
  if (IMAGE_MIMES.some((x) => m.startsWith(x))) return "image";
  if (m === "application/pdf") return "pdf";
  if (XLSX_MIMES.some((x) => m === x)) return "xlsx";
  if (CSV_MIMES.some((x) => m === x)) {
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
  const kind = input.kindHint || detectFileKind(input.mime, input.filename);
  if (kind === "unknown") {
    throw new FileProcessError("unsupported_type", `Tipo não suportado: ${input.mime || input.filename}`);
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
