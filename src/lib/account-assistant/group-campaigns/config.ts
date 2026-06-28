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

function envOn(name: string): boolean {
  const v = (process.env[name] || "").toLowerCase();
  return v === "1" || v === "on" || v === "true";
}

/** Feature LEGADA (H40, direto-Stevo). Default OFF. Retirada na fase F5 do H46. */
export function isGroupCampaignsEnabled(): boolean {
  return envOn("GROUP_CAMPAIGNS_ENABLED");
}

/**
 * H46 — Campanhas em Grupo V2 (grupos = contatos GHL). Flag NOVA, separada da
 * legada. Default OFF / log-first: com OFF as tools V2 não se registram e o prompt
 * é idêntico ao de hoje. Gateia tools + seção de prompt + caps.
 */
export function isGroupCampaignsV2Enabled(): boolean {
  return envOn("GROUP_CAMPAIGNS_V2");
}

/**
 * H46 — Captura/biblioteca de mídia do rep (rep manda áudio/imagem/doc → guarda →
 * dispara). Flag separada (a captura inbound pode ligar antes do outbound). OFF.
 */
export function isRepMediaEnabled(): boolean {
  return envOn("REP_MEDIA_ENABLED");
}

// --- Caps anti-ban ENFORÇADOS (H46, decisão Pedro #1) -----------------------
// O número que entrega no grupo é o MESMO do DM do SparkBot (sem instância
// dedicada). Logo o ban derruba o copiloto — esses caps NÃO são decorativos:
// são enforçados por query real (recipients sent hoje) no schedule/recurring.
// Conservadores de propósito; o rep é avisado nos Termos (ponto 3).

/** Máximo de grupos distintos que recebem disparo por dia, por location. */
export const GROUP_MAX_GROUPS_PER_DAY = 10;

/** Máximo de mensagens pro MESMO grupo por dia. */
export const GROUP_MAX_MSGS_PER_GROUP_PER_DAY = 2;

/** Teto total de mensagens de grupo por dia, por location. */
export const GROUP_MAX_MSGS_PER_DAY_TOTAL = 20;

/** Intervalo PADRÃO entre posts em grupos diferentes (s). Conservador. */
export const GROUP_INTERVAL_SECONDS_DEFAULT = 300; // 5 min

/** Piso do intervalo (s) — nunca espaçar menos que isto. 3x o piso do DM. */
export const GROUP_INTERVAL_FLOOR_SECONDS = 180; // 3 min

/**
 * Teto do intervalo (s). Alinhado ao CHECK de `bulk_message_jobs.interval_seconds`
 * (>=30 AND <=600, migration 00050) — sem isto, "posta a cada 15min" (900) estoura
 * o CHECK no INSERT (23514) e o agendamento falha silencioso.
 */
export const GROUP_INTERVAL_CEIL_SECONDS = 600; // 10 min

/** Jitter PADRÃO (s) somado/subtraído ao intervalo (humaniza o pacing). */
export const GROUP_JITTER_SECONDS_DEFAULT = 60;

/** Máximo de grupos por campanha no MVP (cap defensivo). */
export const GROUP_MAX_GROUPS_PER_CAMPAIGN = 50;

/** Máximo de variações de texto que o rep pode dar por campanha. */
export const GROUP_MAX_VARIATIONS = 5;

// --- Helpers puros (testáveis) ---------------------------------------------

/** Clampa o intervalo ao [piso anti-ban, teto do CHECK]; default se inválido. */
export function clampGroupInterval(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || n <= 0) return GROUP_INTERVAL_SECONDS_DEFAULT;
  return Math.min(GROUP_INTERVAL_CEIL_SECONDS, Math.max(GROUP_INTERVAL_FLOOR_SECONDS, Math.round(n)));
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
