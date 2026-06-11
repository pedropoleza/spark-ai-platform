/**
 * Tools de Disparo em Massa (Bulk Messages) do SparkBot.
 *
 * Pedro 2026-05-04: rep pede "manda msg pra todos com tag X". Não temos
 * drip mode no Spark Leads workflows direto, então o bot mimica o fluxo:
 *   1. Filtra contatos por tag (search GHL)
 *   2. Calcula scheduled_at de cada um (drip + jitter, default 90s ± 30s)
 *   3. Cria bulk_message_jobs + bulk_message_recipients no DB
 *   4. Cron processa fila no MAX_PER_TICK (5/tick), respeitando quiet_hours
 *   5. Variação por contato via Haiku (default 'light') pra evitar pattern
 *      detection do WhatsApp
 *
 * Tools (5):
 *   - list_bulk_jobs        (safe) — jobs do rep + status
 *   - get_bulk_job_progress (safe) — detalhes de 1 job
 *   - pause_bulk_job        (med)  — pausa execução
 *   - resume_bulk_job       (med)  — retoma de paused
 *   - cancel_bulk_job       (high) — cancela definitivamente
 *
 * V1 tools removidas (Pedro 2026-05-20): preview_bulk_message e schedule_bulk_message
 * eram DEPRECATED desde 2026-05-16. Use preview_bulk_message_v2 / schedule_bulk_message_v2.
 *
 * Cap diário: agent_configs.daily_bulk_message_cap (default 100/dia/location).
 * Conta TODAS as recipients criadas nas últimas 24h pra location. Se exceder,
 * V2 preview/schedule rejeitam.
 */

import type { ToolEntry } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";


/**
 * Calcula a string YYYY-MM-DD do dia em America/New_York pra um Date.
 * Fix H1 (review 2026-05-16): antes usava hardcoded -4h offset que quebra
 * em winter (EST=UTC-5). Agora usa Intl.DateTimeFormat com timeZone que
 * lida com DST automaticamente.
 */
export function toEtDayString(d: Date): string {
  // en-CA dá ISO format YYYY-MM-DD direto
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/**
 * Calcula o offset em ms do ET pra um Date específico (lida com DST).
 * Usado pra construir startISO/endISO de uma janela em ET.
 */
function etOffsetMsForDate(d: Date): number {
  // Truque: pegar timestamp do mesmo "wall clock" em UTC vs em ET e ver diff
  const dtUtc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  const dtEt = new Date(d.toLocaleString("en-US", { timeZone: "America/New_York" }));
  return dtUtc.getTime() - dtEt.getTime();
}

/**
 * Conta quantas recipients estão agendadas pra ENVIAR num dia específico
 * (default: hoje, na timezone America/New_York). Usado pra enforcement do
 * daily_bulk_message_cap.
 *
 * Fix Pedro 2026-05-16 (caso Gustavo): antes contava qualquer recipient
 * criado nas últimas 24h — isso era errado porque um job agendado pra
 * terça 19/05 era contado contra cap do dia 16/05 (data de criação),
 * truncando silenciosamente 6 → 2 recipients. Agora conta por DIA DE
 * ENVIO (scheduled_at), não por dia de criação. Cap do dia 19 só pesa
 * recipients que VÃO SAIR no dia 19.
 *
 * Fix H1 (review 2026-05-16): timezone math DST-correct (Intl.DateTimeFormat
 * em vez de offset hardcoded -4h).
 *
 * @param locationId - location pra filtrar
 * @param windowDate - opcional ISO date (YYYY-MM-DD). Default: hoje em ET.
 */
export async function countRecipientsLast24h(
  locationId: string,
  windowDate?: Date | string,
): Promise<number> {
  const supabase = createAdminClient();

  // Resolve janela [dayStart, dayEnd) DST-correct em ET
  const target = windowDate
    ? typeof windowDate === "string"
      ? new Date(windowDate)
      : windowDate
    : new Date();
  const dayStr = toEtDayString(target);
  // Construa start/end usando offset DST-correto pra esse dia
  const dayStartLocal = new Date(`${dayStr}T00:00:00`);
  const dayEndLocal = new Date(`${dayStr}T23:59:59.999`);
  const offsetMs = etOffsetMsForDate(dayStartLocal);
  const dayStartIso = new Date(dayStartLocal.getTime() + offsetMs).toISOString();
  const dayEndIso = new Date(dayEndLocal.getTime() + offsetMs).toISOString();

  // Fix Pedro 2026-05-15: exclui jobs cancelled (recipients que
  // NUNCA vão sair não devem contar pro cap diário).
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("location_id", locationId)
    .neq("status", "cancelled");
  if (!jobs || jobs.length === 0) return 0;
  const jobIds = jobs.map((j) => j.id);
  // Conta recipients com scheduled_at DENTRO do dia alvo + exclui status que
  // NUNCA vão sair: cancelled, skipped, failed (review C2 2026-05-16).
  // Antes contava failed, inflando cap em locations com runs com many failures.
  const { count } = await supabase
    .from("bulk_message_recipients")
    .select("id", { count: "exact", head: true })
    .in("job_id", jobIds)
    .not("status", "in", "(cancelled,skipped,failed)")
    .gte("scheduled_at", dayStartIso)
    .lte("scheduled_at", dayEndIso);
  return count ?? 0;
}

/**
 * Cap diário base. Pedro 2026-05-16 (F3.1): default 100 → 300 pra reduzir
 * fricção de override em uso normal. Override fica reservado pra picos.
 * Configurável per-agent via agent_configs.daily_bulk_message_cap.
 *
 * Fix M14 (review 2026-05-16): mudança silenciosa = reps com cap NULL
 * (default) ganharam 3x. Recomendação operacional: admin verifique em
 * SQL `SELECT agent_id, daily_bulk_message_cap FROM agent_configs WHERE
 * daily_bulk_message_cap IS NULL OR daily_bulk_message_cap = 100` pra
 * decidir caso a caso. Sem migration automática porque defaults são per-
 * agent (não global) e mudança hard pode surpreender admins.
 */
export const DEFAULT_DAILY_BULK_CAP = 300;

export async function getDailyCap(agentId: string | null): Promise<number | null> {
  if (!agentId) return DEFAULT_DAILY_BULK_CAP;
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_configs")
    .select("daily_bulk_message_cap")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!data) return DEFAULT_DAILY_BULK_CAP;
  return data.daily_bulk_message_cap ?? null;
}

/**
 * Cap semanal opcional (F3.4 Pedro 2026-05-16). NULL = sem cap secundário.
 * Quando setado, schedule_bulk_message_v2 checa total rolling 7 days antes
 * de criar job. Proteção contra "rep dispara 300/dia × 7 dias = 2100 msgs".
 */
export async function getWeeklyCap(agentId: string | null): Promise<number | null> {
  if (!agentId) return null;
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_configs")
    .select("weekly_bulk_message_cap")
    .eq("agent_id", agentId)
    .maybeSingle();
  return data?.weekly_bulk_message_cap ?? null;
}

/**
 * Conta recipients enviadas/agendadas nos últimos 7 dias (rolling).
 */
export async function countRecipientsLast7Days(locationId: string): Promise<number> {
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("location_id", locationId)
    .neq("status", "cancelled");
  if (!jobs || jobs.length === 0) return 0;
  const ids = jobs.map((j) => j.id);
  // Fix C2 2026-05-16: exclui failed também (não conta pro cap rolling).
  const { count } = await supabase
    .from("bulk_message_recipients")
    .select("id", { count: "exact", head: true })
    .in("job_id", ids)
    .not("status", "in", "(cancelled,skipped,failed)")
    .gte("scheduled_at", cutoff);
  return count ?? 0;
}

/**
 * F3.2 Pedro 2026-05-16: detecta contatos que receberam bulk msg recentemente
 * (default 24h). Usado pelo preview_bulk_message_v2 pra avisar duplicação.
 * NÃO bloqueia schedule (Pedro escolheu warn-only).
 *
 * @returns Map<contact_id, {last_sent_at, hours_ago}>
 */
export async function getContactsWithRecentBulk(
  locationId: string,
  contactIds: string[],
  hoursBack: number = 24,
): Promise<Map<string, { last_sent_at: string; hours_ago: number }>> {
  const result = new Map<string, { last_sent_at: string; hours_ago: number }>();
  if (contactIds.length === 0) return result;
  const supabase = createAdminClient();
  const cutoff = new Date(Date.now() - hoursBack * 60 * 60 * 1000).toISOString();
  // Supabase tem limite implícito de ~~1000 items em IN clauses — chunk se necessário
  const CHUNK = 500;
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK);
    const { data } = await supabase
      .from("bulk_contact_cooldown")
      .select("contact_id, last_sent_at")
      .eq("location_id", locationId)
      .in("contact_id", chunk)
      .gte("last_sent_at", cutoff);
    for (const row of data || []) {
      const lastSent = row.last_sent_at;
      const hoursAgo = Math.floor((Date.now() - new Date(lastSent).getTime()) / (1000 * 60 * 60));
      result.set(row.contact_id, { last_sent_at: lastSent, hours_ago: hoursAgo });
    }
  }
  return result;
}

/**
 * F4.3 Pedro 2026-05-16: detecta jobs ativos do rep com template SIMILAR
 * (Jaccard >= 0.7 sobre palavras únicas). Anti-duplicação acidental.
 * Usado pelo preview pra avisar "tem job similar rodando — quer mergear ou criar novo?"
 */
export interface SimilarJobMatch {
  job_id: string;
  status: string;
  label: string | null;
  template_preview: string;
  similarity: number;
  total_contacts: number;
  pending_count: number;
}

/**
 * Fix H2 (review 2026-05-16): tokens >= 1 char (não > 2) pra preservar
 * palavras curtas PT-BR ("oi", "te", "me", "se", "ok", "ja"). Antes
 * threshold 0.7 raramente batia em templates curtos PT por causa do filter.
 * Também normaliza accents pra match "saúde" === "saude".
 */
function jaccardSimilarity(a: string, b: string): number {
  const tokenize = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .normalize("NFD")
        .replace(/[̀-ͯ]/g, "") // strip accents
        .replace(/\{[^}]*\}/g, " ") // remove placeholders {first_name} etc
        .replace(/[^\w\s]+/g, " ")
        .split(/\s+/)
        .filter((w) => w.length >= 2), // 2+ chars (era 3+) pra incluir "oi", "te"
    );
  const sa = tokenize(a);
  const sb = tokenize(b);
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const w of sa) if (sb.has(w)) inter++;
  const union = sa.size + sb.size - inter;
  return union === 0 ? 0 : inter / union;
}

export async function findSimilarActiveJobs(
  repId: string,
  locationId: string,
  newTemplate: string,
  threshold: number = 0.7,
): Promise<SimilarJobMatch[]> {
  if (!newTemplate || newTemplate.length < 20) return [];
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id, status, label, message_template, total_contacts, sent_count")
    .eq("rep_id", repId)
    .eq("location_id", locationId)
    .in("status", ["running", "paused"])
    .limit(50);

  const matches: SimilarJobMatch[] = [];
  for (const j of jobs || []) {
    const sim = jaccardSimilarity(newTemplate, j.message_template || "");
    if (sim >= threshold) {
      matches.push({
        job_id: j.id,
        status: j.status,
        label: j.label,
        template_preview: String(j.message_template).slice(0, 80),
        similarity: Math.round(sim * 100) / 100,
        total_contacts: j.total_contacts,
        pending_count: j.total_contacts - (j.sent_count ?? 0),
      });
    }
  }
  return matches.sort((a, b) => b.similarity - a.similarity);
}

/**
 * F3.2: registra que um contato recebeu msg bulk (chamado pelo runner após send).
 * UPSERT com increment de send_count_30d (rolling — não exato mas suficiente).
 */
export async function recordContactBulkSent(
  contactId: string,
  locationId: string,
  jobId: string | null,
): Promise<void> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();
  try {
    // Tenta UPDATE primeiro (caso já exista)
    const { data: existing } = await supabase
      .from("bulk_contact_cooldown")
      .select("send_count_30d, last_sent_at")
      .eq("contact_id", contactId)
      .eq("location_id", locationId)
      .maybeSingle();

    if (existing) {
      // Se última msg foi >30d atrás, reseta counter; senão incrementa
      const lastSent = new Date(existing.last_sent_at).getTime();
      const isNew30dWindow = Date.now() - lastSent > 30 * 24 * 60 * 60 * 1000;
      await supabase
        .from("bulk_contact_cooldown")
        .update({
          last_sent_at: now,
          job_id: jobId,
          send_count_30d: isNew30dWindow ? 1 : (existing.send_count_30d ?? 0) + 1,
          updated_at: now,
        })
        .eq("contact_id", contactId)
        .eq("location_id", locationId);
    } else {
      await supabase
        .from("bulk_contact_cooldown")
        .insert({
          contact_id: contactId,
          location_id: locationId,
          last_sent_at: now,
          job_id: jobId,
          send_count_30d: 1,
        });
    }
  } catch (err) {
    // Não-fatal — cooldown é metadado warn-only
    console.warn("[bulk-cooldown] recordContactBulkSent falhou:", err);
  }
}

/**
 * Cap diário efetivo pra um dia específico, somando overrides ativos.
 * Pedro 2026-05-16 (Fase 2): rep pode pedir cap_override pra dia específico
 * via tool `bulk_request_cap_override`. Esta função soma todos os extras
 * aprovados pro dia em questão.
 *
 * @param locationId — pra buscar overrides do dia
 * @param baseCap — cap base do agente (null = sem cap)
 * @param forDate — dia alvo (date local ET, YYYY-MM-DD ou Date)
 */
export async function getEffectiveDailyCap(
  locationId: string,
  baseCap: number | null,
  forDate?: Date | string,
): Promise<number | null> {
  if (baseCap === null) return null;
  const supabase = createAdminClient();
  // Fix H1 (review 2026-05-16): usa toEtDayString DST-correct
  const target = forDate
    ? typeof forDate === "string"
      ? new Date(forDate)
      : forDate
    : new Date();
  const dayStr = toEtDayString(target);

  const { data: overrides } = await supabase
    .from("bulk_cap_overrides")
    .select("extra_granted")
    .eq("location_id", locationId)
    .eq("for_date", dayStr);

  const totalExtra = (overrides || []).reduce(
    (sum, o) => sum + (o.extra_granted ?? 0),
    0,
  );
  return baseCap + totalExtra;
}

/**
 * Calcula scheduled_at sequencial pra cada recipient com jitter.
 * baseStart é o timestamp do primeiro envio.
 */
export function computeScheduledAts(
  count: number,
  baseStart: Date,
  intervalSeconds: number,
  jitterSeconds: number,
): Date[] {
  const result: Date[] = [];
  for (let i = 0; i < count; i++) {
    const offset = i * intervalSeconds;
    const jitter = jitterSeconds > 0
      ? (Math.random() * 2 - 1) * jitterSeconds // [-jitter, +jitter]
      : 0;
    const ts = new Date(baseStart.getTime() + (offset + jitter) * 1000);
    result.push(ts);
  }
  return result;
}

// ─────────────────────────────────────────────────────────────────────
// F60 (Pedro 2026-06-10) — Cap diário nos caminhos AUTOMÁTICOS de disparo
// ─────────────────────────────────────────────────────────────────────
// Gap de paridade: a UI promete "Aborda até N pessoas/dia" mas o teto só
// era enforçado no chat do SparkBot. Prospecção, campanhas /hub e recorrentes
// enfileiravam TODOS os contatos sem teto. Este helper é o ponto único de
// distribuição cap-aware reusado pelo campaign-populator e pelo recurring-runner.
//
// SEMÂNTICA ESCOLHIDA (documentada — decisão F60):
//   1. O cap é um TETO por DIA-DE-ENVIO em America/New_York — mesmo dia-ET que
//      countRecipientsLast24h e o cap do chat já usam. NÃO é janela rolante de
//      24h nem cap por-execução.
//   2. ESPALHA, não trunca: todos os contatos são agendados, mas no máximo
//      `cap` por dia-ET; o excedente ROLA pro próximo dia (começa às 09:00 ET).
//      Diverge DE PROPÓSITO do chat path (que TRUNCA): lá o rep faz um disparo
//      único e o trim é a UX certa; aqui é prospecção/campanha contínua e a
//      promessa "até N/dia" é de RITMO (pacing), não de descarte. Admin pode
//      cancelar o job se a cauda for longa demais.
//   3. `usedByEtDay` semeia o contador com o que JÁ está agendado pra cada dia
//      (location-wide, via countRecipientsLast24h) — teto é da LOCATION/dia,
//      consistente com o chat (conta location-wide vs cap por-agente).
//   4. Enforcement no POPULATE-TIME (aqui), NÃO no runner: cada recipient nasce
//      com scheduled_at no seu dia, então o bulk-message-runner (que só claim'a
//      scheduled_at <= now) respeita o teto naturalmente, sem contador próprio.
//
// Pura/determinística (injete `rng` nos testes). cap null/<=0 → comportamento
// linear histórico (baseStart + i*interval + jitter), zero mudança.
//
// TZ-independente da máquina: agrupa por toEtDayString (Intl com America/New_York)
// e constrói os instantes de rollover via etWallTimeToUtc (two-pass Intl), então
// roda igual em UTC (serverless) e na máquina local do dev (testes).

export interface DailyCapDistributionInput {
  count: number;
  /** Teto por dia-ET. null/<=0 = sem teto (linear). */
  dailyCap: number | null;
  intervalSeconds: number;
  jitterSeconds: number;
  /** 1º slot do dia 0. */
  baseStart: Date;
  /** recipients já agendados por dia-ET (YYYY-MM-DD) — seed location-wide. */
  usedByEtDay?: Map<string, number>;
  /** hora ET onde os dias rolados começam (default 9). */
  rolloverStartHourEt?: number;
  /** safety bound de dias (default = adaptativo p/ caber count/cap). */
  maxDays?: number;
  /** injeção de aleatoriedade pra teste determinístico (default Math.random). */
  rng?: () => number;
}

/**
 * Converte uma wall-clock ET (ano/mês/dia/hora) no instante UTC correspondente,
 * DST-correct e independente do fuso da máquina. Two-pass: chuta UTC=wall e
 * corrige pelo offset real que o Intl reporta (converge em ≤2 iterações, cobre
 * transições de horário de verão).
 */
function etWallTimeToUtc(
  year: number,
  month1: number, // 1-12
  day: number,
  hour: number,
  minute = 0,
): Date {
  let utc = Date.UTC(year, month1 - 1, day, hour, minute, 0);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  for (let k = 0; k < 3; k++) {
    const parts = fmt.formatToParts(new Date(utc));
    const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const etHour = get("hour") === 24 ? 0 : get("hour"); // alguns runtimes dão "24" pra meia-noite
    const asEt = Date.UTC(get("year"), get("month") - 1, get("day"), etHour, get("minute"), get("second"));
    const desired = Date.UTC(year, month1 - 1, day, hour, minute, 0);
    const diff = desired - asEt;
    if (diff === 0) break;
    utc += diff;
  }
  return new Date(utc);
}

/** Instante UTC de `hour:00` ET do dia SEGUINTE a `etDayStr` (YYYY-MM-DD). */
function etNextDayAtHour(etDayStr: string, hour: number): Date {
  const [y, m, d] = etDayStr.split("-").map(Number);
  // Date.UTC normaliza overflow de dia/mês; o two-pass re-deriva o dia-ET real.
  return etWallTimeToUtc(y, m, d + 1, hour, 0);
}

/**
 * Espalha `count` recipients em scheduled_at[] respeitando o cap por dia-ET.
 * Ver bloco F60 acima pra semântica completa.
 */
export function distributeScheduledAtsByDailyCap(
  input: DailyCapDistributionInput,
): Date[] {
  const rng = input.rng ?? Math.random;
  const intervalMs = Math.max(1, input.intervalSeconds) * 1000;
  const jitterMaxMs = Math.max(0, input.jitterSeconds) * 1000;
  // jitter SEMPRE forward [0, jitterMax) — espelha o populator/recurring atuais.
  const jitter = () => Math.floor(rng() * jitterMaxMs);
  const cap =
    input.dailyCap != null && input.dailyCap > 0 ? Math.floor(input.dailyCap) : null;
  const out: Date[] = [];
  if (input.count <= 0) return out;

  // Sem cap → linear histórico (baseStart + i*interval + jitter). Zero mudança.
  if (cap === null) {
    for (let i = 0; i < input.count; i++) {
      out.push(new Date(input.baseStart.getTime() + i * intervalMs + jitter()));
    }
    return out;
  }

  const rolloverHour = input.rolloverStartHourEt ?? 9;
  const maxDays =
    input.maxDays ?? Math.min(3650, Math.ceil(input.count / cap) + 10);
  const used = input.usedByEtDay ?? new Map<string, number>();
  const placed = new Map<string, number>(); // dia-ET → colocados por ESTE job
  const dayLoad = (day: string) => (used.get(day) ?? 0) + (placed.get(day) ?? 0);

  let cursor = new Date(input.baseStart);
  let daysRolled = 0;

  for (let i = 0; i < input.count; i++) {
    // Dia-ET do cursor (re-detecta cruzamento natural de meia-noite ET — cobre
    // o caso cap enorme onde os slots transbordam o dia sozinhos).
    let day = toEtDayString(cursor);
    // Rola enquanto o dia (seed + colocados) já bateu o cap.
    while (dayLoad(day) >= cap && daysRolled < maxDays) {
      cursor = etNextDayAtHour(day, rolloverHour);
      day = toEtDayString(cursor);
      daysRolled++;
    }
    out.push(new Date(cursor.getTime() + jitter()));
    placed.set(day, (placed.get(day) ?? 0) + 1);
    cursor = new Date(cursor.getTime() + intervalMs);
  }
  return out;
}

/**
 * Helper de conveniência pros runners: resolve o cap efetivo do job e devolve
 * os scheduled_at[] já distribuídos, semeando o uso de HOJE (dia-ET do baseStart)
 * via countRecipientsLast24h. Mantém a lógica de cap idêntica entre o
 * campaign-populator e o recurring-runner (fonte única).
 *
 * Se `dailyCap` for null → linear (sem query de seed desnecessária).
 */
export async function buildCappedScheduledAts(opts: {
  locationId: string;
  count: number;
  dailyCap: number | null;
  intervalSeconds: number;
  jitterSeconds: number;
  baseStart: Date;
}): Promise<Date[]> {
  if (opts.dailyCap == null || opts.dailyCap <= 0) {
    return distributeScheduledAtsByDailyCap({
      count: opts.count,
      dailyCap: null,
      intervalSeconds: opts.intervalSeconds,
      jitterSeconds: opts.jitterSeconds,
      baseStart: opts.baseStart,
    });
  }
  // Semeia o dia de HOJE (dia-ET do baseStart) com o que já está agendado pra
  // location — assim respeitamos "quantos já saíram nas últimas 24h" (o gap que
  // o task aponta). Dias futuros nascem zerados (cross-job em dias futuros é a
  // mesma simplificação warn-only do cooldown — documentado em F60).
  const usedByEtDay = new Map<string, number>();
  const todayEt = toEtDayString(opts.baseStart);
  const usedToday = await countRecipientsLast24h(opts.locationId, opts.baseStart);
  if (usedToday > 0) usedByEtDay.set(todayEt, usedToday);
  return distributeScheduledAtsByDailyCap({
    count: opts.count,
    dailyCap: opts.dailyCap,
    intervalSeconds: opts.intervalSeconds,
    jitterSeconds: opts.jitterSeconds,
    baseStart: opts.baseStart,
    usedByEtDay,
  });
}

/**
 * Track 7 C4 fix (review 2026-05-05): se start_at cair dentro de quiet_hours
 * configurado pro agent, desloca pro próximo `quiet_end`. Antes, recipients
 * ficavam em loop pending→sending→pending até quiet acabar, depois disparavam
 * em rajada de 30s = ban WhatsApp.
 *
 * Espelha lógica de `isInQuietHours` em dispatcher.ts/bulk-message-runner.ts.
 */
export async function adjustStartAtForQuietHours(
  agentId: string | null,
  startAt: Date,
): Promise<Date> {
  if (!agentId) return startAt;
  const supabase = createAdminClient();
  const { data: config } = await supabase
    .from("agent_configs")
    .select("quiet_hours")
    .eq("agent_id", agentId)
    .maybeSingle();
  type QuietHours = {
    enabled?: boolean;
    timezone?: string;
    start?: string;
    end?: string;
    days?: number[];
  };
  const qh = (config?.quiet_hours || null) as QuietHours | null;
  if (!qh || !qh.enabled) return startAt;
  const tz = qh.timezone || "America/New_York";
  const start = qh.start || "22:00";
  const end = qh.end || "07:00";
  const days = qh.days || [0, 1, 2, 3, 4, 5, 6];

  try {
    // Itera minuto a minuto até achar slot fora de quiet (max 24h)
    const cursor = new Date(startAt);
    const maxIter = 24 * 60;
    for (let i = 0; i < maxIter; i++) {
      const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz,
        hour12: false,
        weekday: "short",
        hour: "2-digit",
        minute: "2-digit",
      });
      const parts = fmt.formatToParts(cursor);
      const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
      const wkMap: Record<string, number> = {
        Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6,
      };
      const weekday = wkMap[get("weekday")] ?? 0;
      const hr = parseInt(get("hour")) || 0;
      const mi = parseInt(get("minute")) || 0;
      const nowMin = hr * 60 + mi;
      const [sH, sM] = start.split(":").map(Number);
      const [eH, eM] = end.split(":").map(Number);
      const startMin = sH * 60 + sM;
      const endMin = eH * 60 + eM;
      let inQuiet: boolean;
      if (!days.includes(weekday)) {
        inQuiet = false;
      } else if (startMin > endMin) {
        inQuiet = nowMin >= startMin || nowMin <= endMin;
      } else {
        inQuiet = nowMin >= startMin && nowMin <= endMin;
      }
      if (!inQuiet) return cursor;
      cursor.setMinutes(cursor.getMinutes() + 1);
    }
    return startAt; // fallback se não achar
  } catch {
    return startAt;
  }
}

/**
 * Detecta bulk jobs ATIVOS (running ou paused) do rep nessa location.
 * Pedro 2026-05-15: bot precisa avisar rep quando outro disparo tá em
 * andamento ANTES de criar novo. Rep escolhe esperar OU paralelo (com
 * risco de espaçamento desigual no WhatsApp do número de envio).
 */
export interface ActiveBulkJob {
  job_id: string;
  status: "running" | "paused";
  total_contacts: number;
  sent_count: number;
  pending_count: number;
  /** Etapa 4.7 final (Pedro 2026-05-28): contagem de replies pra esse job. */
  reply_count: number;
  /** Etapa 4.7 final: reply_count / sent_count em %, 1 casa decimal. */
  reply_rate_pct: number;
  segments_labels: string[];
  delivery_strategy_type: string;
  next_scheduled_at: string | null;
  estimated_completion_at: string | null;
  is_multi_segment: boolean;
  /** F4.2 Pedro 2026-05-16: label humana do job. */
  label: string | null;
  /** F4.1 Pedro 2026-05-16: priority 1-100. Default 50. */
  priority: number;
}

export async function getActiveBulkJobs(
  repId: string,
  locationId: string,
): Promise<ActiveBulkJob[]> {
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select(
      "id, status, total_contacts, sent_count, filter_config, estimated_completion_at, label, priority",
    )
    .eq("rep_id", repId)
    .eq("location_id", locationId)
    .in("status", ["running", "paused"])
    .order("priority", { ascending: false })
    .order("created_at", { ascending: false });
  if (!jobs || jobs.length === 0) return [];

  // Pra cada job ativo, pega next_scheduled_at do recipient pending mais próximo
  // E reply_count (Etapa 4.7 final — Pedro 2026-05-28).
  const jobIds = jobs.map((j) => j.id);
  const [{ data: nextScheduled }, { data: repliedRecips }] = await Promise.all([
    supabase
      .from("bulk_message_recipients")
      .select("job_id, scheduled_at")
      .in("job_id", jobIds)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true }),
    supabase
      .from("bulk_message_recipients")
      .select("job_id")
      .in("job_id", jobIds)
      .not("replied_at", "is", null),
  ]);
  const nextByJob = new Map<string, string>();
  for (const r of nextScheduled || []) {
    if (!nextByJob.has(r.job_id)) {
      nextByJob.set(r.job_id, r.scheduled_at);
    }
  }
  const repliedByJob = new Map<string, number>();
  for (const r of repliedRecips || []) {
    repliedByJob.set(r.job_id, (repliedByJob.get(r.job_id) || 0) + 1);
  }

  return jobs.map((j) => {
    const fc = j.filter_config as Record<string, unknown> | null;
    const isMulti = fc && fc.type === "multi";
    const segments = isMulti
      ? ((fc.segments as Array<{ label: string }> | undefined) || []).map(
          (s) => s.label,
        )
      : [];
    const strategy = isMulti
      ? (fc.delivery_strategy as Record<string, unknown> | undefined)
      : undefined;
    const pending = j.total_contacts - (j.sent_count || 0);
    const sent = j.sent_count || 0;
    const replies = repliedByJob.get(j.id) || 0;
    return {
      job_id: j.id,
      status: j.status as "running" | "paused",
      total_contacts: j.total_contacts,
      sent_count: sent,
      pending_count: pending,
      reply_count: replies,
      reply_rate_pct: sent > 0 ? Math.round((replies / sent) * 1000) / 10 : 0,
      segments_labels: segments,
      delivery_strategy_type: (strategy?.type as string) || "today",
      next_scheduled_at: nextByJob.get(j.id) || null,
      estimated_completion_at: j.estimated_completion_at,
      is_multi_segment: !!isMulti,
      label: j.label ?? null,
      priority: j.priority ?? 50,
    };
  });
}

export async function resolveAgentId(
  locationId: string,
): Promise<string | null> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", locationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  return data?.id ?? null;
}

// =====================================================================
// Tool: list_bulk_jobs
// =====================================================================
const listBulkJobs: ToolEntry = {
  def: {
    name: "list_bulk_jobs",
    description:
      "Lista os disparos em massa do rep — running, pausados, completados (últimos 7 dias).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["running", "paused", "completed", "cancelled", "failed", "all"],
          description: "Filtra por status. Default 'all'.",
        },
        limit: {
          type: "number",
          description: "Max resultados. Default 10, max 30.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const supabase = createAdminClient();
    const limit = Math.min(30, Math.max(1, Number(args.limit) || 10));
    const filterStatus = String(args.status || "all");

    let query = supabase
      .from("bulk_message_jobs")
      .select(
        "id, status, filter_config, message_template, total_contacts, sent_count, failed_count, skipped_count, created_at, start_at, estimated_completion_at, completed_at",
      )
      .eq("rep_id", ctx.rep.id)
      .gte("created_at", new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString())
      .order("created_at", { ascending: false })
      .limit(limit);
    if (filterStatus !== "all") {
      query = query.eq("status", filterStatus);
    }
    const { data, error } = await query;
    if (error) {
      return { status: "error", message: `Falha: ${error.message}`, retryable: false };
    }
    return {
      status: "ok",
      data: (data || []).map((j) => {
        const fc = j.filter_config as Record<string, unknown> | null;
        const isMulti = fc && fc.type === "multi";
        const segments = isMulti
          ? ((fc.segments as Array<{ label: string; resolved_count: number }> | undefined) || [])
          : [];
        const strategy = isMulti ? (fc.delivery_strategy as Record<string, unknown> | undefined) : undefined;
        return {
          job_id: j.id,
          status: j.status,
          // V2 metadata (Pedro 2026-05-15)
          is_multi_segment: !!isMulti,
          segments: isMulti
            ? segments.map((s) => `${s.label}=${s.resolved_count}`)
            : undefined,
          delivery_strategy_type: strategy?.type || (isMulti ? "today" : undefined),
          // V1 legacy
          tag: !isMulti ? (fc as { tag?: string } | null)?.tag || null : null,
          template_preview: String(j.message_template).slice(0, 60),
          total: j.total_contacts,
          sent: j.sent_count,
          failed: j.failed_count,
          skipped: j.skipped_count,
          progress_percent:
            j.total_contacts > 0
              ? Math.round(((j.sent_count + j.failed_count + j.skipped_count) / j.total_contacts) * 100)
              : 0,
          created_at: j.created_at,
          start_at: j.start_at,
          eta_completion: j.estimated_completion_at,
          completed_at: j.completed_at,
        };
      }),
    };
  },
};

// =====================================================================
// Tool: get_bulk_job_progress (refatorada Pedro 2026-05-15)
// =====================================================================
const getBulkJobProgress: ToolEntry = {
  def: {
    name: "get_bulk_job_progress",
    description:
      "Detalhes + progresso de UM disparo em massa pelo job_id (use list_bulk_jobs pra obter o id). " +
      "Retorna breakdown POR SEGMENTO (multi-segment V2) e POR DIA + resumo formatado pronto pra bot exibir. " +
      "Use quando rep perguntar 'como tá o disparo?', 'quantos já receberam?', 'falta quanto?'.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string" },
      },
      required: ["job_id"],
    },
  },
  handler: async (ctx, args) => {
    const jobId = String(args.job_id || "");
    if (!jobId) return { status: "error", message: "job_id obrigatório", retryable: false };

    const supabase = createAdminClient();
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select("*")
      .eq("id", jobId)
      .eq("rep_id", ctx.rep.id) // segurança: só vê próprios
      .maybeSingle();
    if (!job) return { status: "not_found", message: "Job não encontrado" };

    // Conta sample failed pra mostrar errors
    const { data: failed } = await supabase
      .from("bulk_message_recipients")
      .select("contact_name, error_message")
      .eq("job_id", jobId)
      .eq("status", "failed")
      .limit(5);

    // Breakdown POR SEGMENT (V2 jobs têm segment_label; legacy é null)
    const { data: recipientsStats } = await supabase
      .from("bulk_message_recipients")
      .select("segment_label, status, scheduled_at")
      .eq("job_id", jobId);

    const segmentMap = new Map<string, { total: number; sent: number; pending: number; failed: number }>();
    const dailyMap = new Map<string, { sent: number; pending: number; failed: number }>();
    let nextScheduledAt: string | null = null;

    for (const r of recipientsStats || []) {
      const segLabel = r.segment_label || "(single)";
      const segStats = segmentMap.get(segLabel) || { total: 0, sent: 0, pending: 0, failed: 0 };
      segStats.total++;
      if (r.status === "sent") segStats.sent++;
      else if (r.status === "failed") segStats.failed++;
      else if (r.status === "pending" || r.status === "scheduled") segStats.pending++;
      segmentMap.set(segLabel, segStats);

      const day = (r.scheduled_at || "").slice(0, 10);
      if (day) {
        const dayStats = dailyMap.get(day) || { sent: 0, pending: 0, failed: 0 };
        if (r.status === "sent") dayStats.sent++;
        else if (r.status === "failed") dayStats.failed++;
        else if (r.status === "pending" || r.status === "scheduled") dayStats.pending++;
        dailyMap.set(day, dayStats);

        if (r.status === "pending" || r.status === "scheduled") {
          if (!nextScheduledAt || (r.scheduled_at || "") < nextScheduledAt) {
            nextScheduledAt = r.scheduled_at;
          }
        }
      }
    }

    const segmentsProgress = Array.from(segmentMap.entries()).map(([label, s]) => ({
      label,
      total: s.total,
      sent: s.sent,
      pending: s.pending,
      failed: s.failed,
    }));

    const dailyProgress = Array.from(dailyMap.entries())
      .sort()
      .map(([day, s]) => ({
        day: new Date(day + "T12:00:00Z").toLocaleDateString("pt-BR", {
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
        }),
        sent: s.sent,
        pending: s.pending,
        failed: s.failed,
      }));

    // Filter config V2 detect
    const fc = job.filter_config as Record<string, unknown> | null;
    const isMultiSegment = fc && fc.type === "multi";

    const totalRecipients = job.total_contacts;
    const sentCount = job.sent_count || 0;
    const failedCount = job.failed_count || 0;
    const skippedCount = job.skipped_count || 0;

    // Importa formatter dinamicamente (evita circular)
    const { formatProgressSummary } = await import("./bulk-summary-formatter");
    const progressSummary = formatProgressSummary({
      job_id: job.id,
      status: job.status,
      total: totalRecipients,
      sent: sentCount,
      failed: failedCount,
      skipped: skippedCount,
      pending: totalRecipients - sentCount - failedCount - skippedCount,
      segments_progress: segmentsProgress,
      daily_progress: dailyProgress,
      start_at: job.start_at,
      next_scheduled_at: nextScheduledAt || undefined,
      eta_completion: job.estimated_completion_at,
      delivery_strategy: isMultiSegment && fc
        ? (fc.delivery_strategy as never) || undefined
        : undefined,
    });

    return {
      status: "ok",
      data: {
        job_id: job.id,
        status: job.status,
        is_multi_segment: !!isMultiSegment,
        // Legacy V1 backward-compat
        tag: !isMultiSegment ? (fc as { tag?: string } | null)?.tag || null : null,
        message_template: job.message_template,
        variation_mode: job.variation_mode,
        interval_seconds: job.interval_seconds,
        jitter_seconds: job.jitter_seconds,
        delivery_channel: job.delivery_channel,
        total: totalRecipients,
        sent: sentCount,
        failed: failedCount,
        skipped: skippedCount,
        pending: totalRecipients - sentCount - failedCount - skippedCount,
        progress_percent:
          totalRecipients > 0
            ? Math.round(((sentCount + failedCount + skippedCount) / totalRecipients) * 100)
            : 0,
        created_at: job.created_at,
        start_at: job.start_at,
        next_scheduled_at: nextScheduledAt,
        eta_completion: job.estimated_completion_at,
        completed_at: job.completed_at,
        // Breakdown V2
        segments_progress: segmentsProgress,
        daily_progress: dailyProgress,
        failed_samples: (failed || []).map((f) => ({
          contact: f.contact_name,
          error: f.error_message,
        })),
        // Resumo formatado pro bot exibir
        progress_summary: progressSummary,
      },
    };
  },
};

// =====================================================================
// Tool: pause_bulk_job
// =====================================================================
const pauseBulkJob: ToolEntry = {
  def: {
    name: "pause_bulk_job",
    description:
      "Pausa um disparo em massa em andamento. Recipients pendentes ficam parados até resume_bulk_job.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  handler: async (ctx, args) => {
    const jobId = String(args.job_id || "");
    if (!jobId) return { status: "error", message: "job_id obrigatório", retryable: false };
    const supabase = createAdminClient();
    // Fix M2 (review 2026-05-16): RBAC location_id check pra evitar rep
    // multi-location pausar job de OUTRA location se conhecer UUID.
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select("id, status, rep_id, location_id")
      .eq("id", jobId)
      .eq("location_id", ctx.locationId)
      .maybeSingle();
    if (!job) return { status: "not_found", message: "Job não encontrado nesta location" };
    if (job.rep_id !== ctx.rep.id) {
      return { status: "error", message: "Job não pertence a você", retryable: false };
    }
    if (job.status !== "running") {
      return {
        status: "error",
        message: `Job está '${job.status}', só pode pausar 'running'`,
        retryable: false,
      };
    }
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "paused", paused_at: new Date().toISOString() })
      .eq("id", jobId);
    return { status: "ok", data: { job_id: jobId, status: "paused" } };
  },
};

// =====================================================================
// Tool: resume_bulk_job
// =====================================================================
const resumeBulkJob: ToolEntry = {
  def: {
    name: "resume_bulk_job",
    description:
      "Retoma um disparo em massa que estava pausado. Recipients pending continuam de onde pararam.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  handler: async (ctx, args) => {
    const jobId = String(args.job_id || "");
    if (!jobId) return { status: "error", message: "job_id obrigatório", retryable: false };
    const supabase = createAdminClient();
    // Fix M2 (review 2026-05-16): RBAC location_id check.
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select("id, status, rep_id, location_id")
      .eq("id", jobId)
      .eq("location_id", ctx.locationId)
      .maybeSingle();
    if (!job) return { status: "not_found", message: "Job não encontrado nesta location" };
    if (job.rep_id !== ctx.rep.id) {
      return { status: "error", message: "Job não pertence a você", retryable: false };
    }
    if (job.status !== "paused") {
      return {
        status: "error",
        message: `Job está '${job.status}', só pode retomar 'paused'`,
        retryable: false,
      };
    }
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "running", paused_at: null })
      .eq("id", jobId);
    return { status: "ok", data: { job_id: jobId, status: "running" } };
  },
};

// =====================================================================
// Tool: cancel_bulk_job
// =====================================================================
const cancelBulkJob: ToolEntry = {
  def: {
    name: "cancel_bulk_job",
    description:
      "⚠️ AÇÃO IRREVERSÍVEL: Cancela um disparo em massa. Recipients pending nunca serão enviados (já-enviadas ficam). Sempre confirma antes.",
    risk: "high",
    parameters: {
      type: "object",
      properties: { job_id: { type: "string" } },
      required: ["job_id"],
    },
  },
  handler: async (ctx, args) => {
    const jobId = String(args.job_id || "");
    if (!jobId) return { status: "error", message: "job_id obrigatório", retryable: false };
    const supabase = createAdminClient();
    // Fix M2 (review 2026-05-16): RBAC location_id check.
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select("id, status, rep_id, sent_count, location_id")
      .eq("id", jobId)
      .eq("location_id", ctx.locationId)
      .maybeSingle();
    if (!job) return { status: "not_found", message: "Job não encontrado nesta location" };
    if (job.rep_id !== ctx.rep.id) {
      return { status: "error", message: "Job não pertence a você", retryable: false };
    }
    if (job.status === "completed" || job.status === "cancelled") {
      return {
        status: "error",
        message: `Job já está '${job.status}'`,
        retryable: false,
      };
    }
    // Marca job cancelled + recipients pending como cancelled.
    // Faço 2 calls: 1) count pending atual; 2) update them. Não dá pra usar
    // .select("id", {count}) depois de .update no supabase-js v2.
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "cancelled", completed_at: new Date().toISOString() })
      .eq("id", jobId);
    const { count: pendingBefore } = await supabase
      .from("bulk_message_recipients")
      .select("id", { count: "exact", head: true })
      .eq("job_id", jobId)
      .eq("status", "pending");
    await supabase
      .from("bulk_message_recipients")
      .update({ status: "cancelled", error_message: "job cancelled by rep" })
      .eq("job_id", jobId)
      .eq("status", "pending");

    return {
      status: "ok",
      data: {
        job_id: jobId,
        status: "cancelled",
        already_sent: job.sent_count,
        pending_cancelled: pendingBefore ?? 0,
      },
    };
  },
};

export const BULK_MESSAGES_TOOLS: ToolEntry[] = [
  listBulkJobs,
  getBulkJobProgress,
  pauseBulkJob,
  resumeBulkJob,
  cancelBulkJob,
];
