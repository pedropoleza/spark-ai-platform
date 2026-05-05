/**
 * Recorder de admin_signals.
 *
 * Agrega sinais (failures, missed capabilities, errors, ideas) pro painel
 * admin do Pedro. Anti-duplicação via fingerprint determinístico:
 *   fingerprint = sha256(type + ':' + normalize(title)).slice(0, 32)
 *
 * Mesmo title (case/spaces ignorados) + mesmo type → mesma row, com
 * occurrence_count++ e last_seen_at = now. Reduz spam de "rep pediu X"
 * 50 vezes pra 1 row com count=50.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { createHash } from "crypto";

export type SignalType = "failure" | "missed_capability" | "error" | "idea";
export type SignalSeverity = "low" | "medium" | "high" | "critical";
export type SignalSource = "bot_auto" | "manual" | "system";

export interface RecordSignalInput {
  type: SignalType;
  title: string;
  description?: string;
  severity?: SignalSeverity;
  source?: SignalSource;
  metadata?: Record<string, unknown>;
}

export interface RecordSignalResult {
  ok: boolean;
  signal_id?: string;
  was_new?: boolean;
  occurrence_count?: number;
  error?: string;
}

/**
 * Normaliza um title pra clustering: lowercase, remove pontuação,
 * collapse whitespace, trim. Mantém palavras significativas.
 */
function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove diacríticos (á → a)
    .replace(/[^\w\s]/g, " ") // pontuação → espaço
    .replace(/\s+/g, " ")
    .trim();
}

function computeFingerprint(type: SignalType, title: string): string {
  const normalized = normalizeTitle(title);
  const raw = `${type}:${normalized}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

/**
 * Registra (ou incrementa) um signal. Sempre best-effort — falha não
 * deve quebrar o caller. Roda em background dos hooks (executeTool,
 * report_missed_capability tool, manual UI add).
 */
export async function recordSignal(input: RecordSignalInput): Promise<RecordSignalResult> {
  const title = (input.title || "").trim().slice(0, 200);
  if (!title) return { ok: false, error: "title obrigatório" };

  const supabase = createAdminClient();
  const fingerprint = computeFingerprint(input.type, title);
  const severity = input.severity || "medium";
  const source = input.source || "bot_auto";
  const description = input.description?.slice(0, 2000) || null;
  const incomingMeta = input.metadata || {};

  // Tenta achar existente pelo fingerprint
  const { data: existing } = await supabase
    .from("admin_signals")
    .select("id, occurrence_count, metadata, severity")
    .eq("fingerprint", fingerprint)
    .maybeSingle();

  if (existing) {
    // Merge metadata: mantém existente + acumula sample_metadata em array
    type Meta = Record<string, unknown> & {
      samples?: Array<Record<string, unknown>>;
    };
    const existingMeta = (existing.metadata || {}) as Meta;
    const samples = Array.isArray(existingMeta.samples) ? existingMeta.samples : [];
    // Mantém últimas 10 amostras
    const newSamples = [
      ...samples.slice(-9),
      { at: new Date().toISOString(), ...incomingMeta },
    ];
    const newMeta = { ...existingMeta, samples: newSamples };

    // Bump severity se incoming é maior
    const sevRank: Record<SignalSeverity, number> = {
      low: 1, medium: 2, high: 3, critical: 4,
    };
    const newSev =
      sevRank[severity] > sevRank[existing.severity as SignalSeverity]
        ? severity
        : (existing.severity as SignalSeverity);

    await supabase
      .from("admin_signals")
      .update({
        occurrence_count: existing.occurrence_count + 1,
        last_seen_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        metadata: newMeta,
        severity: newSev,
      })
      .eq("id", existing.id);

    return {
      ok: true,
      signal_id: existing.id,
      was_new: false,
      occurrence_count: existing.occurrence_count + 1,
    };
  }

  // Novo
  const { data: created, error } = await supabase
    .from("admin_signals")
    .insert({
      type: input.type,
      title,
      description,
      fingerprint,
      severity,
      source,
      metadata: { samples: [{ at: new Date().toISOString(), ...incomingMeta }] },
    })
    .select("id")
    .single();

  if (error) {
    console.warn("[admin-signals] insert falhou:", error.message);
    return { ok: false, error: error.message };
  }
  return { ok: true, signal_id: created.id, was_new: true, occurrence_count: 1 };
}

/**
 * Wrapper que registra em background (não bloqueia caller).
 * Use quando o caller é um hot path (ex: executeTool error catch).
 */
export function recordSignalAsync(input: RecordSignalInput): void {
  recordSignal(input).catch((err) => {
    console.warn("[admin-signals] recordSignalAsync falhou:", err);
  });
}
