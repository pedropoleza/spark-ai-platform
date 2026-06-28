/**
 * Campanhas em GRUPOS de WhatsApp V2 — multitool do SparkBot (H46, 2026-06-28).
 *
 * MODELO (correção do H40): um grupo É um CONTATO no Spark Leads/GHL (email = JID
 * @g.us, nome termina "GRUPO"). O disparo vai pela MESMA rota de contato
 * (/conversations/messages) — sem Stevo direto, sem instância dedicada. O
 * contact_id do contato-grupo É o endereço de envio. Descoberta/cache em
 * `group-contacts/` (detector + sync). Ver _planning/group-campaigns-v2-contatos/.
 *
 * DUAS tools (gate H8/test-mode por-tool):
 *  - `group_campaign_info` (risk:safe) — read-only: list_groups, preview, list_campaigns.
 *  - `group_campaign` (risk:high) — write: schedule, pause, resume, cancel.
 *
 * Reuso do motor Bulk V2: job target_type='groups' (RÓTULO de telemetria) + N
 * recipients (1 por grupo, contact_id = ID GHL real, is_group=true). O runner
 * entrega via a rota de contato normal (sem ramo Stevo) e pula opt-out/DND/assign
 * por is_group. Variação anti-ban: variation_mode='light' ou textos explícitos.
 *
 * Gates: (1) flag GROUP_CAMPAIGNS_V2 (registro), (2) Terms & Segurança PARTE 2
 * (consentimento; o número é o do DM — ban derruba os dois, ver Termos ponto 3),
 * (3) spam advisor (bloqueio duro só em score extremo).
 *
 * Regra inviolável: strings user-facing dizem "Spark Leads"/"SparkBot".
 */

import type { ToolContext, ToolEntry } from "./types";
import type { ToolResult } from "@/types/account-assistant";
import { createAdminClient } from "@/lib/supabase/admin";
import { markGroupCampaignTermsPending } from "@/lib/account-assistant/identity";
import { GROUP_CAMPAIGN_TERMS_TEXT } from "@/lib/account-assistant/terms";
import { scoreSpamRisk } from "@/lib/account-assistant/group-campaigns/spam-advisor";
import {
  GROUP_INTERVAL_SECONDS_DEFAULT,
  GROUP_INTERVAL_FLOOR_SECONDS,
  GROUP_JITTER_SECONDS_DEFAULT,
  GROUP_MAX_GROUPS_PER_CAMPAIGN,
  GROUP_MAX_VARIATIONS,
  clampGroupInterval,
  dailyTimeToCron,
} from "@/lib/account-assistant/group-campaigns/config";
import {
  getGroupContacts,
  resolveGroupTargets,
  type GroupTarget,
} from "@/lib/account-assistant/group-contacts/sync";
import { checkGroupDailyCaps } from "@/lib/account-assistant/group-campaigns/caps";
import { computeBatchedScheduledAts } from "./bulk-delivery-strategy";

// ---------------------------------------------------------------------------
// Helpers de gate
// ---------------------------------------------------------------------------

/**
 * Gate de Terms PARTE 2. Se o rep ainda não aceitou (e não é internal), marca
 * pending e devolve o texto dos termos (o processor captura accept/reject no
 * próximo turno, determinístico). Retorna null se já pode prosseguir.
 */
async function checkGroupTermsGate(ctx: ToolContext): Promise<ToolResult | null> {
  if (ctx.rep.is_internal) return null;
  if (ctx.rep.group_campaign_terms_accepted_at) return null;
  await markGroupCampaignTermsPending(ctx.rep.id);
  return {
    status: "error",
    retryable: false,
    code: "group_terms_required",
    message:
      GROUP_CAMPAIGN_TERMS_TEXT +
      '\n\n_Responda *"aceito"* pra liberar campanhas em grupo, ou *"não"* se preferir não usar agora._',
  };
}

/** Mensagem quando não há contato-grupo cadastrado na location. */
const NO_GROUPS_MESSAGE =
  "Não achei nenhum grupo cadastrado como contato aqui. Os grupos aparecem no Spark Leads " +
  "como contatos (nome termina em \"GRUPO\", e-mail é o ID do grupo) quando a integração do " +
  "WhatsApp sincroniza. Se você acabou de criar/entrar num grupo, me dá um instante e tenta de novo.";

function asStringArray(v: unknown): string[] {
  if (Array.isArray(v)) return v.map((x) => String(x)).filter((s) => s.trim().length > 0);
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

// ---------------------------------------------------------------------------
// group_campaign_info (risk:safe) — read-only
// ---------------------------------------------------------------------------

const groupCampaignInfo: ToolEntry = {
  def: {
    name: "group_campaign_info",
    description:
      "📋 Consulta (read-only) de campanhas em GRUPOS de WhatsApp. action:\n" +
      "• 'list_groups' — lista seus grupos de WhatsApp (aparecem como contato no Spark Leads; o nome termina em 'GRUPO').\n" +
      "• 'preview' — simula uma campanha ANTES de agendar: grupos-alvo, prévia da mensagem, aviso de spam e tempo estimado. NÃO envia. Passe groups[] + message.\n" +
      "• 'list_campaigns' — campanhas de grupo ativas/recentes do rep.\n" +
      "Use SEMPRE list_groups/preview antes de chamar group_campaign action:'schedule'.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list_groups", "preview", "list_campaigns"],
          description: "Qual consulta fazer.",
        },
        groups: {
          type: "array",
          items: { type: "string" },
          description: "Nomes dos grupos-alvo, ou ['all'] (preview).",
        },
        message: { type: "string", description: "Texto da campanha (preview)." },
        interval_seconds: {
          type: "number",
          description: `Espaçamento entre grupos (s). Default ${GROUP_INTERVAL_SECONDS_DEFAULT}, piso ${GROUP_INTERVAL_FLOOR_SECONDS}.`,
        },
      },
      required: ["action"],
    },
  },
  handler: async (ctx, args): Promise<ToolResult> => {
    const action = String(args.action || "");

    if (action === "list_campaigns") return listGroupCampaigns(ctx);

    // Descobre os grupos da location: cache group_contacts (sync se stale).
    const groups = await getGroupContacts(ctx);
    if (groups.length === 0) {
      return { status: "ok", data: { groups: [], message: NO_GROUPS_MESSAGE } };
    }

    if (action === "list_groups") {
      return {
        status: "ok",
        data: {
          count: groups.length,
          groups: groups.map((g) => ({
            name: g.group_name || g.jid,
            contact_id: g.contact_id,
            jid: g.jid,
          })),
          message: `Você tem ${groups.length} grupo(s). Me diz qual(is) e o que postar.`,
        },
      };
    }

    if (action === "preview") return previewGroupCampaign(ctx, args);

    return {
      status: "error",
      retryable: false,
      message: `action desconhecida: ${action} (use list_groups, preview ou list_campaigns).`,
    };
  },
};

// ---------------------------------------------------------------------------
// group_campaign (risk:high) — write
// ---------------------------------------------------------------------------

const groupCampaign: ToolEntry = {
  def: {
    name: "group_campaign",
    description:
      "📣 AÇÃO em campanhas de GRUPO de WhatsApp (exige confirmação). action:\n" +
      "• 'schedule' — agenda o disparo. Passe groups[] (nomes dos grupos ou ['all']) + message. Opcional: variations[] (textos alternativos anti-spam), recurrence {daily_time:'07:30'} ou {cron} pra repetir todo dia, start_at (ISO) pra one-shot futuro, interval_seconds.\n" +
      "• 'pause' / 'resume' / 'cancel' — controla as campanhas de grupo do rep (pause/cancel também seguram as recorrentes).\n" +
      "REGRAS: exige aceite dos Termos de campanha de grupo; as campanhas saem pelo MESMO número que você usa comigo (um bloqueio derruba os dois — por isso eu limito e espaço os envios e vario o texto). Sempre faça preview antes.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["schedule", "pause", "resume", "cancel"],
          description: "O que fazer.",
        },
        groups: {
          type: "array",
          items: { type: "string" },
          description: "Nomes dos grupos-alvo, ou ['all'] (schedule).",
        },
        message: { type: "string", description: "Texto do post (schedule)." },
        variations: {
          type: "array",
          items: { type: "string" },
          description: `Textos alternativos do MESMO post (anti-spam, round-robin). Máx ${GROUP_MAX_VARIATIONS}. Se vazio, eu vario sozinho.`,
        },
        recurrence: {
          type: "object",
          description: "Pra repetir todo dia. { daily_time:'07:30' } OU { cron:'30 7 * * *' }. Omita pra one-shot.",
          properties: {
            daily_time: { type: "string", description: "Horário diário 'HH:MM'." },
            cron: { type: "string", description: "Cron de 5 campos (avançado)." },
            timezone: { type: "string", description: "IANA tz (default: fuso do rep)." },
          },
        },
        start_at: { type: "string", description: "ISO 8601 — quando começar o one-shot (default: agora)." },
        interval_seconds: {
          type: "number",
          description: `Espaçamento entre grupos (s). Default ${GROUP_INTERVAL_SECONDS_DEFAULT}, piso ${GROUP_INTERVAL_FLOOR_SECONDS}.`,
        },
      },
      required: ["action"],
    },
  },
  handler: async (ctx, args): Promise<ToolResult> => {
    const action = String(args.action || "");
    if (action === "pause") return pauseGroupCampaigns(ctx);
    if (action === "resume") return resumeGroupCampaigns(ctx);
    if (action === "cancel") return cancelGroupCampaigns(ctx);
    if (action === "schedule") return scheduleGroupCampaign(ctx, args);
    return { status: "error", retryable: false, message: `action desconhecida: ${action}` };
  },
};

// ---------------------------------------------------------------------------
// Implementações
// ---------------------------------------------------------------------------

async function previewGroupCampaign(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const groupsInput = asStringArray(args.groups);
  const message = String(args.message || "").trim();
  if (groupsInput.length === 0 || !message) {
    return {
      status: "error",
      retryable: false,
      message: "Pra preview eu preciso de groups[] (nomes dos grupos ou ['all']) e message.",
    };
  }
  const { targets, notFound } = await resolveGroupTargets(ctx, groupsInput);
  if (targets.length === 0) {
    return {
      status: "not_found",
      message: `Não casei nenhum grupo com ${JSON.stringify(groupsInput)}. Use list_groups pros nomes exatos.`,
    };
  }
  const capped = targets.slice(0, GROUP_MAX_GROUPS_PER_CAMPAIGN);
  const interval = clampGroupInterval(args.interval_seconds);
  const spam = scoreSpamRisk(message);
  const etaMin = Math.round(((capped.length - 1) * interval) / 60);

  return {
    status: "ok",
    data: {
      groups: capped.map((g) => ({ name: g.name })),
      group_count: capped.length,
      dropped_over_cap: targets.length > capped.length ? targets.length - capped.length : 0,
      not_found: notFound,
      message_preview: message,
      interval_seconds: interval,
      eta_minutes: etaMin,
      spam_level: spam.level,
      spam_hits: spam.hits,
      spam_block: spam.block,
      message:
        `Prévia: vou postar em ${capped.length} grupo(s), 1 a cada ~${Math.round(interval / 60)}min ` +
        `(termina em ~${etaMin}min).` +
        (spam.block ? " ⛔ O texto tem risco ALTO de bloqueio — preciso que reescreva antes." : "") +
        (!spam.block && spam.level !== "low" ? " ⚠️ O texto tem alguns gatilhos de spam — considere suavizar." : "") +
        (notFound.length > 0 ? ` (Não achei: ${notFound.join(", ")}.)` : ""),
    },
  };
}

async function scheduleGroupCampaign(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // Gate 1: Termos PARTE 2.
  const termsGate = await checkGroupTermsGate(ctx);
  if (termsGate) return termsGate;

  // Inputs.
  const groupsInput = asStringArray(args.groups);
  const message = String(args.message || "").trim();
  if (groupsInput.length === 0 || !message) {
    return {
      status: "error",
      retryable: false,
      message: "Pra agendar eu preciso de groups[] (nomes dos grupos ou ['all']) e message.",
    };
  }
  const variations = asStringArray(args.variations).slice(0, GROUP_MAX_VARIATIONS);
  const interval = clampGroupInterval(args.interval_seconds);

  // Gate 2: spam advisor (bloqueio duro só em extremo).
  for (const t of [message, ...variations]) {
    if (scoreSpamRisk(t).block) {
      return {
        status: "error",
        retryable: false,
        code: "group_spam_blocked",
        message:
          "🚫 Não consigo agendar esse texto: ele combina promessa de retorno garantido com urgência e link — " +
          "exatamente o padrão que derruba número no WhatsApp. Reescreve sem a promessa de ganho garantido e a gente segue.",
      };
    }
  }

  // Resolve grupos → contatos REAIS (contact_id GHL, não JID).
  const { targets, notFound } = await resolveGroupTargets(ctx, groupsInput);
  if (targets.length === 0) {
    return {
      status: "not_found",
      message:
        notFound.length > 0
          ? `Não casei nenhum grupo com ${JSON.stringify(notFound)}. Use group_campaign_info list_groups.`
          : NO_GROUPS_MESSAGE,
    };
  }
  const capped = targets.slice(0, GROUP_MAX_GROUPS_PER_CAMPAIGN);

  // Gate 3: caps anti-ban ENFORÇADOS (decisão Pedro #1: número de grupo = o do DM →
  // ban derruba o copiloto; os caps diários são a mitigação real, não decorativos).
  const capCheck = await checkGroupDailyCaps(
    createAdminClient(),
    ctx.locationId,
    capped.map((t) => t.contact_id),
  );
  if (!capCheck.ok) {
    return { status: "error", retryable: false, code: `group_cap_${capCheck.reason}`, message: capCheck.message };
  }

  const recurrence = (args.recurrence as Record<string, unknown> | undefined) || undefined;
  const isRecurring =
    !!recurrence && (typeof recurrence.daily_time === "string" || typeof recurrence.cron === "string");

  if (isRecurring) {
    return scheduleRecurringGroup(ctx, capped, message, recurrence!, { notFound });
  }
  return scheduleOneShotGroup(ctx, capped, message, variations, interval, args, { notFound });
}

async function scheduleOneShotGroup(
  ctx: ToolContext,
  groups: GroupTarget[],
  message: string,
  variations: string[],
  interval: number,
  args: Record<string, unknown>,
  warn: { notFound: string[] },
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const baseStart = args.start_at ? new Date(String(args.start_at)) : new Date();
  if (isNaN(baseStart.getTime())) {
    return { status: "error", retryable: false, message: `start_at inválido: ${String(args.start_at)}` };
  }
  const useExplicit = variations.length > 0;
  const pool = useExplicit ? [message, ...variations] : [message];

  const scheduledAts = computeBatchedScheduledAts({
    total_recipients: groups.length,
    strategy: { type: "today", interval_seconds: interval, jitter_seconds: GROUP_JITTER_SECONDS_DEFAULT },
    base_start: baseStart,
    daily_cap: 100000, // grupos não têm cap diário no MVP; pacing é o controle
  });

  const label = `Grupos — ${new Date().toISOString().slice(0, 16).replace("T", " ")}`;
  const { data: job, error: jobErr } = await supabase
    .from("bulk_message_jobs")
    .insert({
      rep_id: ctx.rep.id,
      location_id: ctx.locationId,
      agent_id: null,
      filter_config: { type: "groups", version: 2, group_count: groups.length },
      message_template: message,
      variation_mode: useExplicit ? "none" : "light",
      interval_seconds: interval,
      jitter_seconds: GROUP_JITTER_SECONDS_DEFAULT,
      delivery_channel: "whatsapp_web_sms",
      target_type: "groups",
      respect_quiet_hours: false,
      status: "running",
      total_contacts: groups.length,
      start_at: baseStart.toISOString(),
      label,
      priority: 50,
    })
    .select("id")
    .single();
  if (jobErr || !job) {
    return { status: "error", retryable: true, message: `Não consegui criar a campanha (${jobErr?.message || "sem id"}).` };
  }

  const rows = groups.map((g, i) => ({
    job_id: job.id,
    contact_id: g.contact_id, // ID GHL REAL do contato-grupo (endereço /conversations/messages)
    contact_name: g.name,
    contact_phone: null,
    is_group: true, // runner pula opt-out/DND/assign por isto (não pelo target_type)
    target_jid: g.jid, // só audit/diagnóstico
    group_name: g.name,
    scheduled_at: scheduledAts[i].toISOString(),
    personalized_message: useExplicit ? pool[i % pool.length] : null,
    status: "pending",
  }));
  const { error: recErr } = await supabase.from("bulk_message_recipients").insert(rows);
  if (recErr) {
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "failed", cancelled_reason: `recipients insert: ${recErr.message.slice(0, 200)}` })
      .eq("id", job.id);
    return { status: "error", retryable: true, message: `Não consegui montar os destinatários (${recErr.message.slice(0, 120)}).` };
  }

  const etaMin = Math.round(((groups.length - 1) * interval) / 60);
  return {
    status: "ok",
    data: {
      job_id: job.id,
      group_count: groups.length,
      interval_seconds: interval,
      eta_minutes: etaMin,
      not_found: warn.notFound,
      message:
        `✅ Agendado! Vou postar em ${groups.length} grupo(s), 1 a cada ~${Math.round(interval / 60)}min ` +
        `(termina em ~${etaMin}min)` +
        (useExplicit ? ` com ${variations.length} variação(ões) alternando.` : ` variando o texto automaticamente.`) +
        (warn.notFound.length > 0 ? ` (Não achei: ${warn.notFound.join(", ")}.)` : "") +
        ` Pode pausar/cancelar quando quiser.`,
    },
  };
}

async function scheduleRecurringGroup(
  ctx: ToolContext,
  groups: GroupTarget[],
  message: string,
  recurrence: Record<string, unknown>,
  warn: { notFound: string[] },
): Promise<ToolResult> {
  const supabase = createAdminClient();
  const cron =
    typeof recurrence.cron === "string" && recurrence.cron.trim()
      ? recurrence.cron.trim()
      : dailyTimeToCron(String(recurrence.daily_time || ""));
  if (!cron) {
    return {
      status: "error",
      retryable: false,
      message: `Horário de recorrência inválido. Use recurrence: { daily_time: "07:30" }.`,
    };
  }
  const tz = String(recurrence.timezone || ctx.rep.timezone || "America/New_York");

  // Próximo disparo (no fuso do rep). Reusa o avaliador de cron da recorrência.
  let nextRunAt: string | null = null;
  try {
    const { computeNextRunAt } = await import("@/lib/account-assistant/proactive/cron-evaluator");
    const next = computeNextRunAt(cron, tz, new Date());
    nextRunAt = next ? next.toISOString() : null;
  } catch {
    nextRunAt = null;
  }
  if (!nextRunAt) {
    return { status: "error", retryable: false, message: `Não consegui interpretar o horário (${cron}).` };
  }

  const label = `Grupos (diário ${String(recurrence.daily_time || cron)})`;
  const { data: camp, error: campErr } = await supabase
    .from("recurring_campaigns")
    .insert({
      rep_id: ctx.rep.id,
      location_id: ctx.locationId,
      agent_id: null,
      label,
      cron_expression: cron,
      timezone: tz,
      filter_config: { type: "groups" },
      message_template: message,
      delivery_channel: "whatsapp_web_sms",
      refresh_segment_on_run: false,
      enabled: true,
      per_run_cap: groups.length,
      target_type: "groups",
      // H46: contact_id REAL (não JID) — o recurring-runner monta recipients por contato.
      group_targets: groups.map((g) => ({ contact_id: g.contact_id, name: g.name, jid: g.jid })),
      next_run_at: nextRunAt,
    })
    .select("id")
    .single();
  if (campErr || !camp) {
    return { status: "error", retryable: true, message: `Não consegui criar a recorrência (${campErr?.message || "sem id"}).` };
  }

  return {
    status: "ok",
    data: {
      recurring_campaign_id: camp.id,
      group_count: groups.length,
      cron,
      timezone: tz,
      next_run_at: nextRunAt,
      not_found: warn.notFound,
      message:
        `✅ Recorrência criada! Vou postar em ${groups.length} grupo(s) todo dia (${String(recurrence.daily_time || cron)}), ` +
        `espaçando os envios pra reduzir risco de bloqueio.` +
        (warn.notFound.length > 0 ? ` (Não achei: ${warn.notFound.join(", ")}.)` : "") +
        ` Pra parar, é só pedir "pausa as campanhas de grupo".`,
    },
  };
}

async function listGroupCampaigns(ctx: ToolContext): Promise<ToolResult> {
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id, label, status, total_contacts, sent_count, failed_count, created_at")
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .order("created_at", { ascending: false })
    .limit(15);
  const { data: recurring } = await supabase
    .from("recurring_campaigns")
    .select("id, label, cron_expression, enabled, next_run_at")
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .order("created_at", { ascending: false })
    .limit(15);
  return {
    status: "ok",
    data: {
      one_shot: (jobs || []).map((j) => ({
        job_id: j.id,
        label: j.label,
        status: j.status,
        sent: j.sent_count,
        failed: j.failed_count,
        total: j.total_contacts,
      })),
      recurring: (recurring || []).map((r) => ({
        id: r.id,
        label: r.label,
        cron: r.cron_expression,
        enabled: r.enabled,
        next_run_at: r.next_run_at,
      })),
    },
  };
}

// --- Tripé pausa/retoma/cancela (group-scoped) -----------------------------

async function pauseGroupCampaigns(ctx: ToolContext): Promise<ToolResult> {
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .eq("status", "running");
  const jobIds = (jobs || []).map((j) => j.id);
  if (jobIds.length > 0) {
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "paused", paused_at: new Date().toISOString() })
      .in("id", jobIds);
  }
  // Recorrentes: desabilita (não dispara novas ocorrências enquanto pausado).
  const { data: rec } = await supabase
    .from("recurring_campaigns")
    .update({ enabled: false })
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .eq("enabled", true)
    .select("id");
  const recCount = (rec || []).length;
  return {
    status: "ok",
    data: {
      paused_jobs: jobIds.length,
      paused_recurring: recCount,
      message:
        jobIds.length + recCount === 0
          ? "Não tinha campanha de grupo ativa pra pausar."
          : `⏸ Pausei ${jobIds.length} disparo(s) e ${recCount} recorrência(s) de grupo. "retoma" pra continuar.`,
    },
  };
}

async function resumeGroupCampaigns(ctx: ToolContext): Promise<ToolResult> {
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .eq("status", "paused");
  const jobIds = (jobs || []).map((j) => j.id);
  if (jobIds.length > 0) {
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "running", paused_at: null })
      .in("id", jobIds);
  }
  // Recorrentes: re-habilita + recomputa next_run_at de cada uma.
  const { data: recs } = await supabase
    .from("recurring_campaigns")
    .select("id, cron_expression, timezone")
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .eq("enabled", false);
  let recCount = 0;
  if (recs && recs.length > 0) {
    let computeNextRunAt: ((c: string, tz: string, from: Date) => Date | null) | null = null;
    try {
      ({ computeNextRunAt } = await import("@/lib/account-assistant/proactive/cron-evaluator"));
    } catch {
      computeNextRunAt = null;
    }
    for (const r of recs) {
      const next = computeNextRunAt
        ? computeNextRunAt(r.cron_expression, r.timezone || "America/New_York", new Date())
        : null;
      await supabase
        .from("recurring_campaigns")
        .update({ enabled: true, next_run_at: next ? next.toISOString() : null })
        .eq("id", r.id);
      recCount++;
    }
  }
  return {
    status: "ok",
    data: {
      resumed_jobs: jobIds.length,
      resumed_recurring: recCount,
      message:
        jobIds.length + recCount === 0
          ? "Não tinha campanha de grupo pausada."
          : `▶️ Retomei ${jobIds.length} disparo(s) e ${recCount} recorrência(s) de grupo.`,
    },
  };
}

async function cancelGroupCampaigns(ctx: ToolContext): Promise<ToolResult> {
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select("id")
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .in("status", ["running", "paused"]);
  const jobIds = (jobs || []).map((j) => j.id);
  if (jobIds.length > 0) {
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "cancelled", completed_at: new Date().toISOString(), cancelled_reason: "group_campaign cancel by rep" })
      .in("id", jobIds);
    await supabase
      .from("bulk_message_recipients")
      .update({ status: "cancelled", error_message: "campanha cancelada" })
      .in("job_id", jobIds)
      .eq("status", "pending");
  }
  // Recorrentes: desabilita de vez (cancelar = parar de repetir).
  const { data: rec } = await supabase
    .from("recurring_campaigns")
    .update({ enabled: false })
    .eq("rep_id", ctx.rep.id)
    .eq("location_id", ctx.locationId)
    .eq("target_type", "groups")
    .eq("enabled", true)
    .select("id");
  const recCount = (rec || []).length;
  return {
    status: "ok",
    data: {
      cancelled_jobs: jobIds.length,
      cancelled_recurring: recCount,
      message:
        jobIds.length + recCount === 0
          ? "Não tinha campanha de grupo ativa pra cancelar."
          : `❌ Cancelei ${jobIds.length} disparo(s) e ${recCount} recorrência(s) de grupo. (Já enviadas ficam.)`,
    },
  };
}

export const GROUP_CAMPAIGN_TOOLS: ToolEntry[] = [groupCampaignInfo, groupCampaign];
