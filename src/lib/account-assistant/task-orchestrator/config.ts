/**
 * Config + flag do Motor de Orquestração de Tarefas (Pedro 2026-06-20).
 * Plano: _planning/jussara-sparkbot/EXECUCAO.md.
 *
 * PRINCÍPIO: a tarefa é um OBJETO PERSISTENTE no DB (task_drafts/draft_steps),
 * não uma lembrança na janela de contexto. O bot relê via show_draft, muta via
 * tools determinísticas que devolvem o ESTADO REAL, e só afirma o que veio no
 * retorno. Fecha os 2 buracos do caso Jussara: L7 (perder o fluxo) e L11
 * (afirmar "agendado" sem agendar).
 *
 * Flag default OFF / log-first (espelha isGroupCampaignsEnabled): com OFF as
 * tools NÃO são registradas (o LLM nem as vê). Só liga em prod depois de validar
 * 1 caso real (smoke supervisionado).
 */

/** Feature ligada? Default OFF (log-first). */
export function isTaskOrchestratorEnabled(): boolean {
  const v = (process.env.TASK_ORCHESTRATOR_ENABLED || "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

/** Cap defensivo de passos por rascunho (sem clamp de 3 do followup; alto). */
export const MAX_DRAFT_STEPS = 60;

/**
 * Caps do apply_flow_to_contacts (review 2026-06-21): teto anti-spam/ban/custo ao
 * aplicar um template a N contatos de uma vez. Sem isso, fluxo de 60 passos × tag
 * de 5000 contatos = 300k mensagens num loop. Pedro pediu "tag com cuidado".
 */
export const MAX_APPLY_CONTACTS = 200;
export const MAX_APPLY_MESSAGES = 2000;

/** Hora padrão de envio quando o passo não especifica send_time (local do rep). */
export const DEFAULT_SEND_TIME = "09:00";

/** Offset máximo em dias por passo (espelha o CHECK do schema). */
export const MAX_OFFSET_DAYS = 365;

/** Kinds de tarefa suportados (espelha o CHECK de task_drafts.kind). */
export const TASK_KINDS = ["followup_sequence", "file_export", "campaign"] as const;
export type TaskKind = (typeof TASK_KINDS)[number];

/** Status do ciclo de montagem (espelha o CHECK de task_drafts.status). */
export const DRAFT_STATUSES = [
  "building",
  "ready_for_review",
  "materializing",
  "materialized",
  "failed",
  "cancelled",
] as const;
export type DraftStatus = (typeof DRAFT_STATUSES)[number];

// --- Helpers puros (testáveis) ---------------------------------------------

/** "HH:MM" 24h válido? */
export function isValidSendTime(t: unknown): t is string {
  if (typeof t !== "string") return false;
  const m = t.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return false;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  return h >= 0 && h <= 23 && min >= 0 && min <= 59;
}

/** offset_days válido (inteiro 0..MAX_OFFSET_DAYS)? */
export function isValidOffsetDays(n: unknown): n is number {
  return Number.isInteger(n) && (n as number) >= 0 && (n as number) <= MAX_OFFSET_DAYS;
}
