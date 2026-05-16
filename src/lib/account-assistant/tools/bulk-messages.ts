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
 * Tools (7):
 *   - preview_bulk_message  (safe) — calcula count + ETA + 2 exemplos variados
 *   - schedule_bulk_message (high) — cria o job de fato
 *   - list_bulk_jobs        (safe) — jobs do rep + status
 *   - get_bulk_job_progress (safe) — detalhes de 1 job
 *   - pause_bulk_job        (med)  — pausa execução
 *   - resume_bulk_job       (med)  — retoma de paused
 *   - cancel_bulk_job       (high) — cancela definitivamente
 *
 * Cap diário: agent_configs.daily_bulk_message_cap (default 100/dia/location).
 * Conta TODAS as recipients criadas nas últimas 24h pra location. Se exceder,
 * preview/schedule rejeitam.
 */

import type { ToolEntry } from "./types";
import { ghlErrorToResult, validateGhlId } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  generatePreviewVariations,
  interpolateTemplate,
} from "../proactive/bulk-message-variator";

interface ContactSummary {
  id: string;
  name: string | null;
  phone: string | null;
  tags: string[];
}

/**
 * Busca contatos da location ativa, paginando, e filtra client-side
 * por tag. GHL v2 não tem filtro server-side de tag confiável em
 * /contacts/ — fetch all + filter funciona pra locations < 1000 contatos
 * (típico do mercado SparkBot).
 *
 * Limite duro: 500 contatos lidos por chamada (5 pages * 100 limit).
 * Se a location tiver mais, retorna o que conseguiu — admin avisa rep.
 */
async function fetchContactsByTag(
  ghlClient: import("@/lib/ghl/client").GHLClient,
  locationId: string,
  tag: string,
): Promise<{ contacts: ContactSummary[]; truncated: boolean }> {
  const tagLower = tag.toLowerCase();
  const all: ContactSummary[] = [];
  const PER_PAGE = 100;
  const MAX_PAGES = 5;
  let truncated = false;

  for (let page = 1; page <= MAX_PAGES; page++) {
    const res = await ghlClient.get<{
      contacts?: Array<{
        id: string;
        firstName?: string;
        lastName?: string;
        name?: string;
        phone?: string;
        tags?: string[];
      }>;
    }>("/contacts/", {
      locationId,
      limit: String(PER_PAGE),
      page: String(page),
    });
    const contacts = res.contacts || [];
    if (contacts.length === 0) break;

    for (const c of contacts) {
      const tags = (c.tags || []).map((t) => String(t).toLowerCase());
      if (!tags.includes(tagLower)) continue;
      all.push({
        id: c.id,
        name:
          c.name ||
          [c.firstName, c.lastName].filter(Boolean).join(" ") ||
          null,
        phone: c.phone || null,
        tags: c.tags || [],
      });
    }

    // Se retornou menos que PER_PAGE, é a última página
    if (contacts.length < PER_PAGE) break;
    if (page === MAX_PAGES) truncated = true;
  }

  return { contacts: all, truncated };
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
 * @param locationId - location pra filtrar
 * @param windowDate - opcional ISO date (YYYY-MM-DD). Default: hoje em ET.
 */
export async function countRecipientsLast24h(
  locationId: string,
  windowDate?: Date | string,
): Promise<number> {
  const supabase = createAdminClient();

  // Resolve janela [dayStart, dayEnd) baseado no windowDate (default hoje ET).
  // Pra simplicidade usa UTC offset fixo do ET (-04:00 EDT, -05:00 EST) —
  // pode dar +1h de drift na transição DST mas não é crítico pro cap.
  const target = windowDate
    ? typeof windowDate === "string"
      ? new Date(windowDate)
      : windowDate
    : new Date();
  // ET é UTC-4 (verão) ou UTC-5 (inverno). Usa -4h como aproximação.
  // Pra cap diário, a precisão exata na borda da meia-noite não é crítica.
  const etOffsetMs = 4 * 60 * 60 * 1000;
  const targetEt = new Date(target.getTime() - etOffsetMs);
  const dayStr = targetEt.toISOString().slice(0, 10); // YYYY-MM-DD em ET
  const dayStartIso = new Date(dayStr + "T00:00:00-04:00").toISOString();
  const dayEndIso = new Date(dayStr + "T23:59:59-04:00").toISOString();

  // Fix Pedro 2026-05-15: exclui jobs cancelled (recipients que
  // NUNCA vão sair não devem contar pro cap diário).
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("location_id", locationId)
    .neq("status", "cancelled");
  if (!jobs || jobs.length === 0) return 0;
  const jobIds = jobs.map((j) => j.id);
  // Conta recipients com scheduled_at DENTRO do dia alvo + exclui cancelled/skipped.
  const { count } = await supabase
    .from("bulk_message_recipients")
    .select("id", { count: "exact", head: true })
    .in("job_id", jobIds)
    .not("status", "in", "(cancelled,skipped)")
    .gte("scheduled_at", dayStartIso)
    .lte("scheduled_at", dayEndIso);
  return count ?? 0;
}

export async function getDailyCap(agentId: string | null): Promise<number | null> {
  if (!agentId) return 100;
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("agent_configs")
    .select("daily_bulk_message_cap")
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!data) return 100;
  return data.daily_bulk_message_cap ?? null;
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
  segments_labels: string[];
  delivery_strategy_type: string;
  next_scheduled_at: string | null;
  estimated_completion_at: string | null;
  is_multi_segment: boolean;
}

export async function getActiveBulkJobs(
  repId: string,
  locationId: string,
): Promise<ActiveBulkJob[]> {
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select(
      "id, status, total_contacts, sent_count, filter_config, estimated_completion_at",
    )
    .eq("rep_id", repId)
    .eq("location_id", locationId)
    .in("status", ["running", "paused"])
    .order("created_at", { ascending: false });
  if (!jobs || jobs.length === 0) return [];

  // Pra cada job ativo, pega next_scheduled_at do recipient pending mais próximo
  const jobIds = jobs.map((j) => j.id);
  const { data: nextScheduled } = await supabase
    .from("bulk_message_recipients")
    .select("job_id, scheduled_at")
    .in("job_id", jobIds)
    .eq("status", "pending")
    .order("scheduled_at", { ascending: true });
  const nextByJob = new Map<string, string>();
  for (const r of nextScheduled || []) {
    if (!nextByJob.has(r.job_id)) {
      nextByJob.set(r.job_id, r.scheduled_at);
    }
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
    return {
      job_id: j.id,
      status: j.status as "running" | "paused",
      total_contacts: j.total_contacts,
      sent_count: j.sent_count || 0,
      pending_count: pending,
      segments_labels: segments,
      delivery_strategy_type: (strategy?.type as string) || "today",
      next_scheduled_at: nextByJob.get(j.id) || null,
      estimated_completion_at: j.estimated_completion_at,
      is_multi_segment: !!isMulti,
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
// Tool: preview_bulk_message
// =====================================================================
const previewBulkMessage: ToolEntry = {
  def: {
    name: "preview_bulk_message",
    description:
      "Calcula PREVIEW de um disparo em massa SEM criar nada: total de contatos com a tag, ETA total, 2 exemplos variados, cap restante. Use SEMPRE antes de schedule_bulk_message — bot mostra preview pro rep, rep confirma, AÍ chama schedule_bulk_message.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        filter_tag: {
          type: "string",
          description: "Tag exata pra filtrar contatos (ex: 'Direct Agent').",
        },
        message_template: {
          type: "string",
          description:
            "Texto base. Pode usar {first_name}, {name}, {full_name} pra interpolar.",
        },
        variation_mode: {
          type: "string",
          enum: ["none", "light", "medium"],
          description:
            "Modo de variação por contato. 'light' default = recomendado (sutilezas, evita ban). 'none' = exato igual.",
        },
        interval_seconds: {
          type: "number",
          description: "Segundos médios entre msgs. Default 90. Min 30, max 600.",
        },
        jitter_seconds: {
          type: "number",
          description: "Variação aleatória ± segundos. Default 30. Min 0, max 120.",
        },
      },
      required: ["filter_tag", "message_template"],
    },
  },
  handler: async (ctx, args) => {
    const filterTag = String(args.filter_tag || "").trim();
    const messageTemplate = String(args.message_template || "").trim();
    if (!filterTag) {
      return { status: "error", message: "filter_tag obrigatória", retryable: false };
    }
    if (!messageTemplate) {
      return { status: "error", message: "message_template obrigatória", retryable: false };
    }
    const variationMode = (
      ["none", "light", "medium"].includes(String(args.variation_mode))
        ? String(args.variation_mode)
        : "light"
    ) as "none" | "light" | "medium";
    const intervalSeconds = Math.min(600, Math.max(30, Number(args.interval_seconds) || 90));
    const jitterSeconds = Math.min(120, Math.max(0, Number(args.jitter_seconds) || 30));

    try {
      const { contacts, truncated } = await fetchContactsByTag(
        ctx.ghlClient,
        ctx.locationId,
        filterTag,
      );
      if (contacts.length === 0) {
        return {
          status: "not_found",
          message: `Nenhum contato com tag '${filterTag}' encontrado na location.`,
        };
      }

      const agentId = await resolveAgentId(ctx.locationId);
      const cap = await getDailyCap(agentId);
      const usedToday = await countRecipientsLast24h(ctx.locationId);
      const remaining = cap === null ? Infinity : Math.max(0, cap - usedToday);
      const willEnqueue = Math.min(contacts.length, remaining === Infinity ? contacts.length : remaining);

      // Estimativa de janela total (interval médio * count)
      const totalSeconds = willEnqueue * intervalSeconds;
      const eta = new Date(Date.now() + totalSeconds * 1000);

      // 2 exemplos variados pegando 2 contatos aleatórios
      const sampleNames = contacts
        .filter((c) => c.name)
        .slice(0, 4)
        .map((c) => c.name as string);
      const examples = await generatePreviewVariations(
        messageTemplate,
        variationMode,
        sampleNames,
        2,
      );

      return {
        status: "ok",
        data: {
          tag: filterTag,
          total_contacts_with_tag: contacts.length,
          will_enqueue: willEnqueue,
          truncated_search: truncated,
          daily_cap: cap,
          used_today: usedToday,
          remaining_cap: cap === null ? null : remaining,
          would_exceed_cap: cap !== null && contacts.length > remaining,
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          variation_mode: variationMode,
          estimated_total_minutes: Math.round(totalSeconds / 60),
          estimated_completion_at: eta.toISOString(),
          examples,
          sample_contacts: contacts.slice(0, 3).map((c) => ({
            id: c.id,
            name: c.name,
            phone: c.phone,
          })),
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "preview de disparo em massa");
    }
  },
};

// =====================================================================
// Tool: schedule_bulk_message
// =====================================================================
const scheduleBulkMessage: ToolEntry = {
  def: {
    name: "schedule_bulk_message",
    description:
      "Agenda disparo em massa pra contatos filtrados por tag, com drip mode (envio espaçado pra evitar ban WhatsApp) e variação leve por contato.\n\nFLUXO OBRIGATÓRIO: SEMPRE chame preview_bulk_message PRIMEIRO, mostre os números pro rep ('vou disparar pra X contatos, ETA Y, exemplos: ...'), pergunte 'Confirma?', e SÓ DEPOIS rechame esta tool com confirmed_by_rep:true.\n\nCanais:\n- 'whatsapp_web_sms' = via WhatsApp Web / SMS (Stevo/Evolution) — DEFAULT, suporta TODOS os contatos.\n- 'whatsapp_api' = WhatsApp API oficial (só funciona se rep tem WhatsApp Business API ativo).\n\nAnti-ban: drip 90s ± 30s (configurável), variação 'light' por contato (Haiku). Quiet_hours (ex: 22-7h) respeitadas — pausa e retoma.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        filter_tag: {
          type: "string",
          description: "Tag exata pra filtrar (ex: 'Direct Agent').",
        },
        message_template: {
          type: "string",
          description:
            "Texto base. Pode usar {first_name}, {name}, {full_name}.",
        },
        variation_mode: {
          type: "string",
          enum: ["none", "light", "medium"],
          description: "'light' default. 'none' = exato igual. 'medium' = parafraseia.",
        },
        interval_seconds: {
          type: "number",
          description: "Segundos médios entre msgs. Default 90. Min 30, max 600.",
        },
        jitter_seconds: {
          type: "number",
          description: "Variação aleatória ± segundos. Default 30. Min 0, max 120.",
        },
        delivery_channel: {
          type: "string",
          enum: ["whatsapp_web_sms", "whatsapp_api"],
          description: "Canal de envio. Default 'whatsapp_web_sms' (Stevo).",
        },
        start_at: {
          type: "string",
          description:
            "ISO 8601. Quando começar primeiro envio. Default = agora.",
        },
      },
      required: ["filter_tag", "message_template"],
    },
  },
  handler: async (ctx, args) => {
    const filterTag = String(args.filter_tag || "").trim();
    const messageTemplate = String(args.message_template || "").trim();
    if (!filterTag) {
      return { status: "error", message: "filter_tag obrigatória", retryable: false };
    }
    if (!messageTemplate) {
      return { status: "error", message: "message_template obrigatória", retryable: false };
    }
    const variationMode = (
      ["none", "light", "medium"].includes(String(args.variation_mode))
        ? String(args.variation_mode)
        : "light"
    ) as "none" | "light" | "medium";
    const intervalSeconds = Math.min(600, Math.max(30, Number(args.interval_seconds) || 90));
    const jitterSeconds = Math.min(120, Math.max(0, Number(args.jitter_seconds) || 30));
    const deliveryChannel = (
      ["whatsapp_web_sms", "whatsapp_api"].includes(String(args.delivery_channel))
        ? String(args.delivery_channel)
        : "whatsapp_web_sms"
    ) as "whatsapp_web_sms" | "whatsapp_api";
    const startAt = args.start_at ? new Date(String(args.start_at)) : new Date();
    if (isNaN(startAt.getTime())) {
      return { status: "error", message: "start_at inválido (use ISO 8601)", retryable: false };
    }

    try {
      // Fix Track 7 H1 (review 2026-05-05): include `truncated` no warning
      // pro rep saber que paginação cortou em 500 silenciosamente.
      const { contacts, truncated } = await fetchContactsByTag(
        ctx.ghlClient,
        ctx.locationId,
        filterTag,
      );
      if (contacts.length === 0) {
        return {
          status: "not_found",
          message: `Nenhum contato com tag '${filterTag}' encontrado.`,
        };
      }

      const agentId = await resolveAgentId(ctx.locationId);
      const cap = await getDailyCap(agentId);
      // Fix Pedro 2026-05-16: cap só conta recipients agendados pro DIA de envio
      // efetivo, não dia de criação. V1 usa start_at direto (sem strategy).
      const usedToday = await countRecipientsLast24h(ctx.locationId, startAt);
      const remaining = cap === null ? Infinity : Math.max(0, cap - usedToday);

      let willEnqueue = contacts.length;
      const noteParts: string[] = [];
      if (truncated) {
        noteParts.push(
          `⚠️ Lista truncada em ${contacts.length} contatos (paginação parou em 500 — pode haver mais com essa tag). Avise rep.`,
        );
      }
      if (cap !== null && contacts.length > remaining) {
        if (remaining === 0) {
          const dateStr = startAt.toLocaleDateString("pt-BR", {
            weekday: "short",
            day: "2-digit",
            month: "2-digit",
          });
          return {
            status: "error",
            message:
              `⚠️ Cap diário (${cap}) já atingido pra ${dateStr} — ` +
              `${usedToday} msgs já agendadas pra esse dia. Tente outro dia.`,
            retryable: false,
          };
        }
        willEnqueue = remaining;
        noteParts.push(
          `⚠️ Cap diário cortou em ${remaining} (pedidos: ${contacts.length}). ` +
          `${contacts.length - remaining} ficaram de fora porque o dia ${startAt.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} já tem ${usedToday}/${cap} agendados. ` +
          `Sugestão: agende os ${contacts.length - remaining} restantes pra outro dia.`,
        );
      }

      // Fix Track 7 C4 (review 2026-05-05): se job criado dentro de janela
      // quiet, deslocar start_at pro próximo quiet_end. Antes: recipients
      // ficavam pending, runner revertia em loop até quiet acabar, dispatch
      // de 100 msgs em rajada de 30s = ban WhatsApp. Agora: scheduled_at
      // começa fora do quiet — drip natural.
      const adjustedStartAt = await adjustStartAtForQuietHours(agentId, startAt);
      if (adjustedStartAt.getTime() !== startAt.getTime()) {
        noteParts.push(
          `Start ajustado pra ${adjustedStartAt.toISOString()} (quiet hours).`,
        );
      }
      // Fix re-validation 2026-05-05: cappedNote calculado APÓS quiet push
      // (antes era calculado entre cap e quiet, perdendo a quiet note).
      const cappedNote: string | null = noteParts.length > 0 ? noteParts.join(" ") : null;

      const selected = contacts.slice(0, willEnqueue);
      const supabase = createAdminClient();

      // Cria header job
      const { data: job, error: jobErr } = await supabase
        .from("bulk_message_jobs")
        .insert({
          rep_id: ctx.rep.id,
          location_id: ctx.locationId,
          agent_id: agentId,
          filter_config: { tag: filterTag },
          message_template: messageTemplate,
          variation_mode: variationMode,
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          delivery_channel: deliveryChannel,
          respect_quiet_hours: true,
          status: "running",
          total_contacts: willEnqueue,
          start_at: adjustedStartAt.toISOString(),
        })
        .select("id, start_at")
        .single();
      if (jobErr || !job) {
        return {
          status: "error",
          message: `Falha ao criar job: ${jobErr?.message || "unknown"}`,
          retryable: false,
        };
      }

      // Calcula scheduled_at de cada recipient
      const scheduleAts = computeScheduledAts(
        selected.length,
        adjustedStartAt,
        intervalSeconds,
        jitterSeconds,
      );

      const recipientRows = selected.map((c, i) => ({
        job_id: job.id,
        contact_id: c.id,
        contact_name: c.name,
        contact_phone: c.phone,
        scheduled_at: scheduleAts[i].toISOString(),
        status: "pending",
      }));

      // Insert batch (Supabase aceita até ~1000 rows por insert)
      const { error: recErr } = await supabase
        .from("bulk_message_recipients")
        .insert(recipientRows);
      if (recErr) {
        // Roll back: cancela job
        await supabase
          .from("bulk_message_jobs")
          .update({ status: "failed" })
          .eq("id", job.id);
        return {
          status: "error",
          message: `Falha ao criar recipients: ${recErr.message}`,
          retryable: false,
        };
      }

      // Atualiza estimated_completion_at
      const last = scheduleAts[scheduleAts.length - 1];
      await supabase
        .from("bulk_message_jobs")
        .update({ estimated_completion_at: last.toISOString() })
        .eq("id", job.id);

      return {
        status: "ok",
        data: {
          job_id: job.id,
          enqueued: willEnqueue,
          first_send_at: scheduleAts[0].toISOString(),
          last_send_at: last.toISOString(),
          interval_seconds: intervalSeconds,
          jitter_seconds: jitterSeconds,
          variation_mode: variationMode,
          delivery_channel: deliveryChannel,
          truncated_search: truncated,
          adjusted_start: adjustedStartAt.getTime() !== startAt.getTime()
            ? adjustedStartAt.toISOString()
            : null,
          notes: cappedNote,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "criação de disparo em massa");
    }
  },
};

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
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select("id, status, rep_id")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return { status: "not_found", message: "Job não encontrado" };
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
      .update({ status: "paused" })
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
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select("id, status, rep_id")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return { status: "not_found", message: "Job não encontrado" };
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
      .update({ status: "running" })
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
    const { data: job } = await supabase
      .from("bulk_message_jobs")
      .select("id, status, rep_id, sent_count")
      .eq("id", jobId)
      .maybeSingle();
    if (!job) return { status: "not_found", message: "Job não encontrado" };
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

// Helpers que usam validateGhlId apenas pra silenciar import
void validateGhlId;
void interpolateTemplate;

export const BULK_MESSAGES_TOOLS: ToolEntry[] = [
  previewBulkMessage,
  scheduleBulkMessage,
  listBulkJobs,
  getBulkJobProgress,
  pauseBulkJob,
  resumeBulkJob,
  cancelBulkJob,
];
