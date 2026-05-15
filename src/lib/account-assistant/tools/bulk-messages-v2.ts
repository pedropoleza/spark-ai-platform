/**
 * Bulk Messages V2 — sobre Filter Engine (H28).
 *
 * Pedro 2026-05-15:
 *   "Foco em infraestrutura. Sistema de filtros robusto, depois bulk
 *    com condicionais de risco, disclaimer de segurança, personalização
 *    e listas múltiplas (mensagem diferente por lista)."
 *
 * Tools (2):
 *   - preview_bulk_message_v2  — preview multi-segment com disclaimers + count
 *   - schedule_bulk_message_v2 — schedule efetivo após disclaimers confirmados
 *
 * Diferenças vs V1 (schedule_bulk_message):
 *   - Filtros via FEL (qualquer combinação: tag + stage + custom field + ...)
 *   - Multi-segment: N filters × N templates num único job
 *   - Disclaimers obrigatórios: lista quente/fria + risk tier
 *   - Interpolação rica: {first_name}, {tags[0]}, {custom.slug}, {opportunity.stage_name}
 *   - Snapshot do texto final por recipient (audit)
 *   - Dedup entre segments por contact_id (default on)
 *
 * H28 (review 2026-05-15) — _planning/filter-engine-and-bulk-v2.md seção 5.
 */

import type { ToolEntry, ToolContext } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";
import type { FilterExpression } from "../filter-engine";
import {
  executeContactsFilter,
  computeDisclaimers,
  validateDisclaimerFlags,
  formatDisclaimersForWhatsApp,
  interpolate,
  parseTemplate,
  buildCustomFieldResolver,
  type ContactResult,
} from "../filter-engine";
import {
  countRecipientsLast24h,
  getDailyCap,
  adjustStartAtForQuietHours,
  resolveAgentId,
} from "./bulk-messages";
import { computeBatchedScheduledAts, computeDeliveryOptions } from "./bulk-delivery-strategy";
import {
  formatPreviewSummary,
  formatScheduleSummary,
} from "./bulk-summary-formatter";
import { generatePreviewVariations } from "../proactive/bulk-message-variator";
import { getRepGhlUserId } from "./types";

interface SegmentInput {
  label?: string;
  filter: FilterExpression;
  message_template: string;
  variation_mode?: "none" | "light" | "medium";
}

interface ResolvedSegment {
  label: string;
  filter: FilterExpression;
  message_template: string;
  variation_mode: "none" | "light" | "medium";
  contacts: ContactResult[];
  count_before_dedup: number;
  count_after_dedup: number;
  filter_explanation: string;
}

// =====================================================================
// Resolve segments (chama Filter Engine pra cada)
// =====================================================================

async function resolveSegments(
  segments: SegmentInput[],
  ctx: ToolContext,
  dedupAcrossSegments: boolean,
  cap: number,
): Promise<{ ok: true; segments: ResolvedSegment[]; total_after_dedup: number } | { ok: false; error: string }> {
  const repUserId = getRepGhlUserId(ctx);
  const engineCtx = {
    rep_id: ctx.rep.id,
    rep_phone: ctx.rep.phone,
    location_id: ctx.locationId,
    company_id: ctx.companyId,
    ghl_client: ctx.ghlClient,
    consumer_tool: "bulk_v2_resolve_segments",
    rep_aliases: {
      ...(ctx.rep.profile?.aliases || {}),
      ...(repUserId ? { __self_user_id: repUserId } : {}),
    },
  };

  const seen = new Set<string>();
  const resolved: ResolvedSegment[] = [];

  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const label = s.label || `Segment ${i + 1}`;
    const variation = (s.variation_mode || "light") as "none" | "light" | "medium";

    if (!s.message_template || s.message_template.trim().length === 0) {
      return { ok: false, error: `Segment "${label}" sem message_template.` };
    }

    const result = await executeContactsFilter(s.filter, engineCtx, {
      limit: cap,
    });
    if (result.status === "error") {
      return { ok: false, error: `Segment "${label}" filter falhou: ${result.message}` };
    }
    const items = result.items || [];
    const before = items.length;

    // Dedup cross-segments
    const filtered = dedupAcrossSegments
      ? items.filter((c) => {
          if (seen.has(c.id)) return false;
          seen.add(c.id);
          return true;
        })
      : items;

    const explanation = explainFilter(s.filter, result.applied_aliases || {});
    resolved.push({
      label,
      filter: s.filter,
      message_template: s.message_template,
      variation_mode: variation,
      contacts: filtered,
      count_before_dedup: before,
      count_after_dedup: filtered.length,
      filter_explanation: explanation,
    });
  }

  const total = resolved.reduce((a, s) => a + s.count_after_dedup, 0);
  return { ok: true, segments: resolved, total_after_dedup: total };
}

function explainFilter(
  filter: FilterExpression,
  applied: Record<string, string>,
): string {
  // Renderiza FEL como string human-readable
  // Ex: "tags contains 'M3' AND opportunity.stageName=M0 (resolved e1f57...)"
  function renderExpr(e: FilterExpression): string {
    if ("all" in e) return "(" + e.all.map(renderExpr).join(" AND ") + ")";
    if ("any" in e) return "(" + e.any.map(renderExpr).join(" OR ") + ")";
    if ("not" in e) return "NOT " + renderExpr(e.not);
    if ("field" in e) {
      const valStr = Array.isArray(e.value) ? `[${e.value.join(",")}]` : String(e.value);
      return `${e.field} ${e.op} ${valStr}`;
    }
    return JSON.stringify(e);
  }
  const base = renderExpr(filter);
  const aliasNote = Object.keys(applied).length > 0
    ? ` (aliases: ${Object.keys(applied).join(", ")})`
    : "";
  return base + aliasNote;
}

// =====================================================================
// preview_bulk_message_v2
// =====================================================================

const previewBulkMessageV2: ToolEntry = {
  def: {
    name: "preview_bulk_message_v2",
    description:
      "Preview de disparo em massa multi-segment via Filter Engine (H28). Aceita 1+ segmentos (cada um com filter FEL + message_template). Retorna count/segment + dedup + ETA + DISCLAIMERS + delivery_options PRÉ-COMPUTADAS (Pedro 2026-05-15).\n\n" +
      "💡 FLUXO INTUITIVO RECOMENDADO (Pedro 2026-05-15):\n" +
      "  1. Se rep já deu briefing claro do tom da mensagem ('texto curto humanizado', 'tom casual sobre X'), GERE o message_template direto — NÃO pergunte 'qual texto?' de novo.\n" +
      "  2. Chame preview_bulk_message_v2 com texto montado.\n" +
      "  3. Pegue `delivery_options[]` do retorno (3 opções pré-calculadas: hoje / spread N dias / custom window) e APRESENTE COMO MENU NUMERADO pro rep:\n" +
      "       Como quer distribuir o envio?\n" +
      "       1. Tudo hoje (~3h)\n" +
      "       2. Spread em 2 dias (~60/dia)\n" +
      "       3. Janela específica (você define)\n" +
      "  4. Coleta disclaimer flags TODOS, daí schedule_bulk_message_v2 com delivery_strategy escolhida.\n\n" +
      "EXEMPLO MULTI-SEGMENT:\n" +
      "  segments=[\n" +
      "    { label:'M0', filter:{field:'opportunity.stageName',op:'eq',value:'M0'}, message_template:'Bem-vindo {first_name}!' },\n" +
      "    { label:'Prova Agendada', filter:{field:'opportunity.stageName',op:'eq',value:'Prova Agendada'}, message_template:'Oi {first_name}, último dia do ingresso...' }\n" +
      "  ]\n\n" +
      "INTERPOLAÇÃO: {first_name} {last_name} {full_name} {email} {phone} {tags[0]} {custom.slug} {opportunity.stage_name} {opportunity.value} {opportunity.customField.slug}\n\n" +
      "⚠️ Sempre PRIMEIRO preview → exibe disclaimers + delivery_options → rep escolhe → schedule_bulk_message_v2 com delivery_strategy + flags.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        segments: {
          type: "array",
          description: "Array de segmentos. Mínimo 1, máximo 10.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Nome descritivo do segmento (opcional, ex: 'M0')." },
              filter: { type: "object", description: "FEL — ver get_contacts_filtered docs." },
              message_template: { type: "string", description: "Template do texto. Suporta {first_name}, {tags[0]}, {custom.slug}, etc." },
              variation_mode: {
                type: "string",
                enum: ["none", "light", "medium"],
                description: "Variação por contato. Default 'light'.",
              },
            },
            required: ["filter", "message_template"],
          },
        },
        list_temperature: {
          type: "string",
          enum: ["warm", "cold", "unknown"],
          description:
            "Qual a temperatura da lista? 'warm' = pessoas que JÁ INTERAGIRAM no WhatsApp. 'cold' = números coletados sem interação prévia (RISCO ALTO de ban). Bot SEMPRE deve perguntar antes de preview.",
        },
        interval_seconds: { type: "number", description: "Default 90. Min 30, max 600." },
        jitter_seconds: { type: "number", description: "Default 30." },
        dedup_across_segments: { type: "boolean", description: "Default true. False = contato em N segments recebe N msgs." },
        interleave_segments: { type: "boolean", description: "Default false (sequencial). True = intercala envios entre segments." },
      },
      required: ["segments"],
    },
  },
  handler: async (ctx, args) => {
    const segmentsInput = Array.isArray(args.segments) ? args.segments as SegmentInput[] : [];
    if (segmentsInput.length === 0) {
      return { status: "error", message: "Mínimo 1 segmento.", retryable: false };
    }
    if (segmentsInput.length > 10) {
      return { status: "error", message: "Máximo 10 segmentos por job.", retryable: false };
    }

    const listTemp = (args.list_temperature === "warm" || args.list_temperature === "cold"
      ? args.list_temperature
      : "unknown") as "warm" | "cold" | "unknown";
    const intervalSeconds = Math.min(600, Math.max(30, Number(args.interval_seconds) || 90));
    const jitterSeconds = Math.min(120, Math.max(0, Number(args.jitter_seconds) || 30));
    const dedup = args.dedup_across_segments !== false;
    const interleave = args.interleave_segments === true;

    // Resolve segments
    const resolveRes = await resolveSegments(segmentsInput, ctx, dedup, 5000);
    if (!resolveRes.ok) {
      return { status: "error", message: resolveRes.error, retryable: false };
    }

    // Disclaimers
    const total = resolveRes.total_after_dedup;
    const disclaimers = computeDisclaimers({
      total_contacts: total,
      list_temperature: listTemp,
    });

    // Cap diário
    const agentId = await resolveAgentId(ctx.locationId);
    const cap = await getDailyCap(agentId);
    const usedToday = await countRecipientsLast24h(ctx.locationId);
    const remaining = cap === null ? Infinity : Math.max(0, cap - usedToday);

    // Build custom field resolver pra interpolation
    const cfResolver = await buildCustomFieldResolver(ctx.ghlClient, ctx.locationId).catch(() => undefined);

    // Examples: 1 por segmento (1º contato)
    const examples: Array<{ segment: string; example: string; warnings: string[] }> = [];
    for (const seg of resolveRes.segments) {
      if (seg.contacts.length === 0) continue;
      const sample = seg.contacts[0];
      const sampleName = sample.firstName || (sample.name?.split(" ")[0] || "Cliente");
      const interp = interpolate(seg.message_template, { contact: sample, custom_field_resolver: cfResolver }, { fallback: "placeholder" });
      // Aplica variação leve (preview only 1)
      let variant = interp.text;
      try {
        const v = await generatePreviewVariations(seg.message_template, seg.variation_mode, [sampleName], 1);
        if (v && v.length > 0) variant = v[0];
      } catch {
        // ignore — usa texto interpolado direto
      }
      examples.push({
        segment: seg.label,
        example: variant,
        warnings: interp.missing.map((m) => `placeholder não-resolvido em alguns contatos: {${m}}`),
      });
    }

    const eta_minutes = Math.ceil((total * intervalSeconds) / 60);
    const wouldExceed = cap !== null && total > remaining;
    const riskLevel =
      total > 100 || (listTemp === "cold" && total > 10) ? "high"
      : total > 50 || (listTemp === "cold" && total > 5) ? "medium"
      : "low";

    // Pedro 2026-05-15: computa OPÇÕES de delivery automaticamente pro bot
    // apresentar como menu numerado (em vez de pergunta aberta).
    const deliveryOptions = computeDeliveryOptions({
      total_contacts: total,
      daily_cap: cap,
      used_today: usedToday,
      default_interval_seconds: intervalSeconds,
      default_jitter_seconds: jitterSeconds,
      list_temperature: listTemp,
    });

    // Resumo formatado pro bot exibir pré-confirmação.
    const previewSegments = resolveRes.segments.map((s) => ({
      label: s.label,
      count_after_dedup: s.count_after_dedup,
      template_placeholders: parseTemplate(s.message_template),
    }));
    const confirmationSummary = formatPreviewSummary({
      total_contacts: total,
      segments: previewSegments,
      list_temperature: listTemp,
      delivery_options: deliveryOptions,
      disclaimers: disclaimers.map((d) => ({
        key: d.key,
        severity: d.severity,
        text: d.text,
      })),
      daily_cap: cap,
      used_today: usedToday,
      would_exceed_cap: wouldExceed,
      risk_level: riskLevel,
    });

    return {
      status: "ok",
      data: {
        segments: resolveRes.segments.map((s) => ({
          label: s.label,
          count_before_dedup: s.count_before_dedup,
          count_after_dedup: s.count_after_dedup,
          filter_explanation: s.filter_explanation,
          variation_mode: s.variation_mode,
          template_placeholders: parseTemplate(s.message_template),
        })),
        total_contacts: total,
        deduped: dedup,
        list_temperature: listTemp,
        interval_seconds: intervalSeconds,
        jitter_seconds: jitterSeconds,
        eta_minutes,
        daily_cap: cap,
        used_today: usedToday,
        remaining_cap: cap === null ? null : remaining,
        would_exceed_cap: wouldExceed,
        risk_level: riskLevel,
        disclaimers: disclaimers.map((d) => ({
          key: d.key,
          severity: d.severity,
          required_flag: d.required_flag,
          text: d.text,
        })),
        disclaimers_for_whatsapp: formatDisclaimersForWhatsApp(disclaimers),
        examples,
        interleave_segments: interleave,
        // Pedro 2026-05-15: opções pré-calculadas pro bot apresentar como menu
        delivery_options: deliveryOptions,
        // Resumo formatado pro bot exibir pré-confirmação (Pedro 2026-05-15)
        confirmation_summary: confirmationSummary,
      },
    };
  },
};

// =====================================================================
// schedule_bulk_message_v2
// =====================================================================

const scheduleBulkMessageV2: ToolEntry = {
  def: {
    name: "schedule_bulk_message_v2",
    description:
      "Cria job de disparo em massa multi-segment (H28). EXIGE que rep tenha confirmado TODOS os disclaimers do preview previamente. Tool aceita N segmentos, cada com filter FEL + template próprios, gera job único + N recipients no DB, runner dispara espaçado respeitando quiet_hours.\n\n" +
      "⚠️ FLUXO OBRIGATÓRIO:\n" +
      "  1. `preview_bulk_message_v2` primeiro — mostra disclaimers + counts.\n" +
      "  2. Bot exibe CADA disclaimer pro rep separadamente, colhe confirmação textual de CADA.\n" +
      "  3. Bot chama `schedule_bulk_message_v2` com `confirmed_by_rep:true` + as flags de aceite (confirmed_warm_list, confirmed_risk_cold/volume, etc).\n\n" +
      "Sem os flags corretos, tool retorna erro listando quais faltam.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        segments: {
          type: "array",
          description: "Mesmo schema do preview. Min 1, max 10.",
          items: {
            type: "object",
            properties: {
              label: { type: "string" },
              filter: { type: "object" },
              message_template: { type: "string" },
              variation_mode: { type: "string", enum: ["none", "light", "medium"] },
            },
            required: ["filter", "message_template"],
          },
        },
        list_temperature: { type: "string", enum: ["warm", "cold"] },
        interval_seconds: { type: "number" },
        jitter_seconds: { type: "number" },
        dedup_across_segments: { type: "boolean" },
        interleave_segments: { type: "boolean" },
        start_at: { type: "string", description: "ISO 8601. Default agora. IGNORADO se delivery_strategy passado." },
        delivery_channel: { type: "string", enum: ["whatsapp_web_sms", "whatsapp_api"], description: "Default whatsapp_web_sms." },
        // Pedro 2026-05-15: delivery_strategy substitui start_at quando rep
        // escolhe opção do menu apresentado por preview_bulk_message_v2.
        delivery_strategy: {
          type: "object",
          description:
            "Como distribuir o disparo no tempo. Vem das delivery_options do preview. " +
            "type='today' (tudo hoje), 'spread_days' (N dias úteis), 'custom_window' (start_at+end_at). " +
            "Se omitido, usa default 'today' com interval 90s.",
          properties: {
            type: { type: "string", enum: ["today", "spread_days", "custom_window"] },
            days_count: { type: "number", description: "Só pra spread_days. Min 2, max 7." },
            start_at: { type: "string", description: "Só pra custom_window. ISO 8601." },
            end_at: { type: "string", description: "Só pra custom_window. ISO 8601." },
            interval_seconds: { type: "number" },
            jitter_seconds: { type: "number" },
          },
        },
        // Disclaimer aceites — bot preenche após coletar confirmações
        confirmed_warm_list: { type: "boolean" },
        confirmed_risk_cold: { type: "boolean" },
        confirmed_risk_volume: { type: "boolean" },
        confirmed_first_bulk: { type: "boolean" },
      },
      required: ["segments", "list_temperature"],
    },
  },
  handler: async (ctx, args) => {
    const segmentsInput = Array.isArray(args.segments) ? args.segments as SegmentInput[] : [];
    if (segmentsInput.length === 0) {
      return { status: "error", message: "Mínimo 1 segmento.", retryable: false };
    }
    if (segmentsInput.length > 10) {
      return { status: "error", message: "Máximo 10 segmentos.", retryable: false };
    }

    const listTemp = (args.list_temperature === "cold" ? "cold" : "warm") as "warm" | "cold";
    const intervalSeconds = Math.min(600, Math.max(30, Number(args.interval_seconds) || 90));
    const jitterSeconds = Math.min(120, Math.max(0, Number(args.jitter_seconds) || 30));
    const dedup = args.dedup_across_segments !== false;
    const interleave = args.interleave_segments === true;
    const deliveryChannel = (args.delivery_channel === "whatsapp_api"
      ? "whatsapp_api"
      : "whatsapp_web_sms") as "whatsapp_web_sms" | "whatsapp_api";

    const flags: Record<string, boolean> = {
      confirmed_warm_list: args.confirmed_warm_list === true,
      confirmed_risk_cold: args.confirmed_risk_cold === true,
      confirmed_risk_volume: args.confirmed_risk_volume === true,
      confirmed_first_bulk: args.confirmed_first_bulk === true,
    };

    // Re-resolve segments (não confiar em snapshot do preview — contatos podem ter mudado)
    const resolveRes = await resolveSegments(segmentsInput, ctx, dedup, 5000);
    if (!resolveRes.ok) {
      return { status: "error", message: resolveRes.error, retryable: false };
    }

    const total = resolveRes.total_after_dedup;
    if (total === 0) {
      return { status: "not_found", message: "Nenhum contato bate os filtros após dedup." };
    }

    // Computa disclaimers requeridos com base no estado atual
    const disclaimers = computeDisclaimers({
      total_contacts: total,
      list_temperature: listTemp,
    });
    const missing = validateDisclaimerFlags(disclaimers, flags);
    if (missing.length > 0) {
      const required = disclaimers.find((d) => missing.includes(d.required_flag));
      return {
        status: "error",
        message:
          `Faltam aceites de disclaimers: ${missing.join(", ")}. ` +
          `Bot deve exibir cada disclaimer pro rep ANTES e colher confirmação textual. ` +
          `Disclaimer faltante mais crítico:\n${required?.text || ""}`,
        retryable: false,
      };
    }

    // Cap diário
    const agentId = await resolveAgentId(ctx.locationId);
    const cap = await getDailyCap(agentId);
    const usedToday = await countRecipientsLast24h(ctx.locationId);
    const remaining = cap === null ? Infinity : Math.max(0, cap - usedToday);
    if (cap !== null && total > remaining) {
      if (remaining === 0) {
        return {
          status: "error",
          message: `Cap diário (${cap}) atingido — ${usedToday} já enfileiradas/enviadas nas últimas 24h. Tente amanhã.`,
          retryable: false,
        };
      }
      // Trim segments proporcionalmente até total ≤ remaining
      let toRemove = total - remaining;
      for (let i = resolveRes.segments.length - 1; i >= 0 && toRemove > 0; i--) {
        const seg = resolveRes.segments[i];
        const take = Math.min(seg.contacts.length, toRemove);
        seg.contacts = seg.contacts.slice(0, seg.contacts.length - take);
        toRemove -= take;
      }
    }

    // Custom field resolver pra interpolação
    const cfResolver = await buildCustomFieldResolver(ctx.ghlClient, ctx.locationId).catch(() => undefined);

    // start_at + delivery_strategy
    const rawDeliveryStrategy = args.delivery_strategy as
      | { type?: string; days_count?: number; start_at?: string; end_at?: string; interval_seconds?: number; jitter_seconds?: number }
      | undefined;
    const startAt = args.start_at ? new Date(String(args.start_at)) : new Date();
    if (isNaN(startAt.getTime())) {
      return { status: "error", message: "start_at inválido.", retryable: false };
    }
    const adjustedStartAt = await adjustStartAtForQuietHours(agentId, startAt);

    // Pedro 2026-05-15: resolve delivery strategy. Default = single-day burst.
    let deliveryStrategy: import("./bulk-delivery-strategy").DeliveryStrategy = {
      type: "today",
      interval_seconds: intervalSeconds,
      jitter_seconds: jitterSeconds,
    };
    if (rawDeliveryStrategy?.type === "spread_days") {
      const days = Math.min(Math.max(Number(rawDeliveryStrategy.days_count) || 2, 2), 7);
      deliveryStrategy = {
        type: "spread_days",
        days_count: days,
        interval_seconds: intervalSeconds,
        jitter_seconds: jitterSeconds,
      };
    } else if (rawDeliveryStrategy?.type === "custom_window") {
      const sa = rawDeliveryStrategy.start_at;
      const ea = rawDeliveryStrategy.end_at;
      if (!sa || !ea) {
        return {
          status: "error",
          message: "delivery_strategy.type='custom_window' exige start_at e end_at (ISO 8601).",
          retryable: false,
        };
      }
      deliveryStrategy = {
        type: "custom_window",
        start_at: sa,
        end_at: ea,
        interval_seconds: intervalSeconds,
        jitter_seconds: jitterSeconds,
      };
    }

    // Cria job
    const supabase = createAdminClient();
    const totalEnqueued = resolveRes.segments.reduce((a, s) => a + s.contacts.length, 0);
    const filterConfigSerialized = {
      type: "multi" as const,
      version: 2,
      segments: resolveRes.segments.map((s) => ({
        label: s.label,
        filter: s.filter,
        message_template: s.message_template,
        variation_mode: s.variation_mode,
        resolved_count: s.contacts.length,
      })),
      list_temperature: listTemp,
      dedup_across_segments: dedup,
      interleave_segments: interleave,
      // Pedro 2026-05-15 (E2E test): guardar delivery_strategy pra
      // list_bulk_jobs/get_bulk_job_progress mostrarem corretamente.
      delivery_strategy: deliveryStrategy,
    };

    const { data: job, error: jobErr } = await supabase
      .from("bulk_message_jobs")
      .insert({
        rep_id: ctx.rep.id,
        location_id: ctx.locationId,
        agent_id: agentId,
        filter_config: filterConfigSerialized,
        message_template: resolveRes.segments[0].message_template, // 1º segment as default
        variation_mode: resolveRes.segments[0].variation_mode,
        interval_seconds: intervalSeconds,
        jitter_seconds: jitterSeconds,
        delivery_channel: deliveryChannel,
        respect_quiet_hours: true,
        status: "running",
        total_contacts: totalEnqueued,
        start_at: adjustedStartAt.toISOString(),
      })
      .select("id, start_at")
      .single();
    if (jobErr || !job) {
      return { status: "error", message: `Falha ao criar job: ${jobErr?.message || "unknown"}`, retryable: false };
    }

    // Gera recipients — ou sequencial (todos do seg 1, depois seg 2) ou interleave
    type RecipientRow = {
      job_id: string;
      contact_id: string;
      contact_name: string | null;
      contact_phone: string | null;
      scheduled_at: string;
      segment_label: string;
      personalized_message: string;
      status: "pending";
    };
    const ordered: Array<{
      contact: ContactResult;
      segment: ResolvedSegment;
    }> = [];

    if (interleave) {
      // Round-robin: pega 1 de cada segment em loop
      const cursors = resolveRes.segments.map(() => 0);
      while (true) {
        let added = false;
        for (let i = 0; i < resolveRes.segments.length; i++) {
          const seg = resolveRes.segments[i];
          if (cursors[i] < seg.contacts.length) {
            ordered.push({ contact: seg.contacts[cursors[i]], segment: seg });
            cursors[i]++;
            added = true;
          }
        }
        if (!added) break;
      }
    } else {
      // Sequencial: todos do seg 1, depois seg 2, etc
      for (const seg of resolveRes.segments) {
        for (const c of seg.contacts) {
          ordered.push({ contact: c, segment: seg });
        }
      }
    }

    // Pedro 2026-05-15: usa delivery_strategy (today/spread_days/custom_window)
    // pra calcular scheduled_at. computeBatchedScheduledAts respeita
    // espaçamento + spread multi-dia + cap diário.
    const scheduleAts = computeBatchedScheduledAts({
      total_recipients: ordered.length,
      strategy: deliveryStrategy,
      base_start: adjustedStartAt,
      daily_cap: cap,
    });
    const recipientRows: RecipientRow[] = ordered.map((o, i) => {
      const interp = interpolate(
        o.segment.message_template,
        { contact: o.contact, custom_field_resolver: cfResolver },
        { fallback: "placeholder" },
      );
      return {
        job_id: job.id,
        contact_id: o.contact.id,
        contact_name: o.contact.name,
        contact_phone: o.contact.phone,
        scheduled_at: scheduleAts[i].toISOString(),
        segment_label: o.segment.label,
        personalized_message: interp.text,
        status: "pending",
      };
    });

    // Insert em batch
    if (recipientRows.length > 0) {
      const { error: insErr } = await supabase
        .from("bulk_message_recipients")
        .insert(recipientRows);
      if (insErr) {
        // Rollback job
        await supabase.from("bulk_message_jobs").update({ status: "cancelled", error: insErr.message }).eq("id", job.id);
        return { status: "error", message: `Falha ao enfileirar: ${insErr.message}`, retryable: false };
      }
    }

    const eta = Math.ceil((recipientRows.length * intervalSeconds) / 60);

    // Daily breakdown pro summary (agrupa scheduled_at por dia)
    const dailyMap = new Map<string, number>();
    for (const r of recipientRows) {
      const day = r.scheduled_at.slice(0, 10); // YYYY-MM-DD
      dailyMap.set(day, (dailyMap.get(day) || 0) + 1);
    }
    const dailyBreakdown = Array.from(dailyMap.entries())
      .sort()
      .map(([day, count]) => ({
        day: new Date(day + "T12:00:00Z").toLocaleDateString("pt-BR", {
          weekday: "short",
          day: "2-digit",
          month: "2-digit",
        }),
        count,
      }));

    const segmentsSummary = resolveRes.segments.map((s) => ({
      label: s.label,
      count: s.contacts.length,
    }));

    const scheduleSummary = formatScheduleSummary({
      job_id: job.id,
      total_enqueued: recipientRows.length,
      segments_summary: segmentsSummary,
      delivery_strategy: deliveryStrategy,
      start_at: adjustedStartAt.toISOString(),
      eta_minutes: eta,
      delivery_channel: deliveryChannel,
      daily_breakdown: dailyBreakdown,
    });

    return {
      status: "ok",
      data: {
        job_id: job.id,
        total_enqueued: recipientRows.length,
        segments_summary: segmentsSummary,
        start_at: adjustedStartAt.toISOString(),
        eta_minutes: eta,
        delivery_channel: deliveryChannel,
        delivery_strategy: deliveryStrategy,
        daily_breakdown: dailyBreakdown,
        // Resumo formatado pro bot exibir confirmação (Pedro 2026-05-15)
        schedule_summary: scheduleSummary,
        message: `Job ${job.id.slice(0, 8)} enfileirado: ${recipientRows.length} msgs em ${resolveRes.segments.length} segments. Runner dispara em ~${eta}min com intervalo ${intervalSeconds}s ± ${jitterSeconds}s.`,
      },
    };
  },
};

// =====================================================================
// Export
// =====================================================================

export const BULK_MESSAGES_V2_TOOLS: ToolEntry[] = [
  previewBulkMessageV2,
  scheduleBulkMessageV2,
];
