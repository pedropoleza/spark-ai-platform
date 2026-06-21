/**
 * Config + flag da feature de Campanhas em Grupo (Pedro 2026-06-18).
 *
 * Flag de rollout GROUP_CAMPAIGNS_ENABLED (default OFF / log-first). Com OFF as
 * tools NÃO são registradas (o LLM nem as vê) e nada pode ser criado — disciplina
 * do projeto: só liga em prod depois de validar 1 caso real. O runner roteia por
 * job.target_type independente da flag (defense-in-depth), mas como nenhum job de
 * grupo nasce com a flag OFF, ele fica naturalmente inerte.
 *
 * Constantes anti-ban CONSERVADORAS: grupo é mais arriscado que DM (audiência
 * grande, muitos não-contatos). Por isso o piso de intervalo (180s) é 3x o do DM
 * (60s, FLOOR_INTERVAL_S em bulk-delivery-strategy.ts). Pacing + jitter espaçam os
 * grupos; a variação de texto reduz detecção de padrão.
 */

/** Feature ligada? Default OFF (log-first). Espelha isEntitlementsEnforced. */
export function isGroupCampaignsEnabled(): boolean {
  const v = (process.env.GROUP_CAMPAIGNS_ENABLED || "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

/** Intervalo PADRÃO entre posts em grupos diferentes (s). Conservador. */
export const GROUP_INTERVAL_SECONDS_DEFAULT = 300; // 5 min

/** Piso do intervalo (s) — nunca espaçar menos que isto. 3x o piso do DM. */
export const GROUP_INTERVAL_FLOOR_SECONDS = 180; // 3 min

/** Jitter PADRÃO (s) somado/subtraído ao intervalo (humaniza o pacing). */
export const GROUP_JITTER_SECONDS_DEFAULT = 60;

/** Máximo de grupos por campanha no MVP (cap defensivo). */
export const GROUP_MAX_GROUPS_PER_CAMPAIGN = 50;

/** Máximo de variações de texto que o rep pode dar por campanha. */
export const GROUP_MAX_VARIATIONS = 5;

// --- Helpers puros (testáveis) ---------------------------------------------

/** Clampa o intervalo informado ao piso anti-ban; default se inválido. */
export function clampGroupInterval(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return GROUP_INTERVAL_SECONDS_DEFAULT;
  return Math.max(GROUP_INTERVAL_FLOOR_SECONDS, Math.round(n));
}

/** "07:30" → cron "30 7 * * *". null se inválido. */
export function dailyTimeToCron(t: string): string | null {
  const m = (t || "").trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return `${min} ${h} * * *`;
}
