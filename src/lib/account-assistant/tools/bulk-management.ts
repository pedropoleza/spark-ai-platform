/**
 * Bulk Management Hub (Fase 2 do plano bulk-management-platform, H32).
 *
 * Pedro 2026-05-16: 7 tools novas pra rep gerenciar múltiplos disparos
 * via WhatsApp. Antes dependia de tools individuais (list_bulk_jobs +
 * pause_bulk_job × N + cancel_bulk_job × N) — agora bulk ops em 1 call.
 *
 * Tools:
 *   - bulk_dashboard            (safe)   — visão consolidada
 *   - bulk_pause_all            (medium) — pausa N jobs running
 *   - bulk_resume_all           (medium) — retoma N jobs paused
 *   - bulk_cancel_all           (high)   — cancela todos ativos
 *   - bulk_reschedule_job       (medium) — move 1 job pra outra data
 *   - bulk_edit_pending_job     (high)   — edita template/filter de pending
 *   - bulk_request_cap_override (high)   — eleva cap diário (audit table)
 *
 * Coexistem com V1/V2: estas tools NÃO criam jobs novos — só gerenciam.
 * Criação fica em preview_bulk_message_v2 + schedule_bulk_message_v2.
 */

import type { ToolEntry, ToolContext } from "./types";
import type { ToolResult } from "@/types/account-assistant";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  countRecipientsLast24h,
  getDailyCap,
  getEffectiveDailyCap,
  getActiveBulkJobs,
  resolveAgentId,
} from "./bulk-messages";

// =====================================================================
// Helpers
// =====================================================================

const MAX_OVERRIDE_MULTIPLIER = 3; // hard ceiling = 3x do cap base

function formatDateTimeET(iso: string | null | undefined): string {
  if (!iso) return "(n/d)";
  try {
    return new Date(iso).toLocaleString("pt-BR", {
      timeZone: "America/New_York",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

function formatDateET(d: Date): string {
  return d.toLocaleDateString("pt-BR", {
    timeZone: "America/New_York",
    weekday: "short",
    day: "2-digit",
    month: "2-digit",
  });
}

/**
 * Lê health do runner pra incluir no dashboard.
 */
async function getRunnerHealth(): Promise<{
  is_stale: boolean;
  seconds_since_tick: number;
  consecutive_errors: number;
  last_error: string | null;
}> {
  const supabase = createAdminClient();
  try {
    const { data } = await supabase
      .from("bulk_runner_health")
      .select("last_tick_at, consecutive_errors, last_error")
      .eq("id", 1)
      .maybeSingle();
    if (!data) {
      return { is_stale: true, seconds_since_tick: 9999, consecutive_errors: 0, last_error: null };
    }
    const ageSec = Math.floor((Date.now() - new Date(data.last_tick_at).getTime()) / 1000);
    return {
      is_stale: ageSec > 5 * 60,
      seconds_since_tick: ageSec,
      consecutive_errors: data.consecutive_errors ?? 0,
      last_error: data.last_error,
    };
  } catch {
    return { is_stale: false, seconds_since_tick: 0, consecutive_errors: 0, last_error: null };
  }
}

/**
 * Lê cap status pros próximos N dias (default 3).
 * Retorna [{date, base_cap, override_extra, effective_cap, used, remaining, pct}]
 */
async function getCapStatusNextDays(
  locationId: string,
  agentId: string | null,
  days: number = 3,
): Promise<
  Array<{
    date: string;
    date_label: string;
    base_cap: number | null;
    override_extra: number;
    effective_cap: number | null;
    used: number;
    remaining: number | null;
    pct: number;
  }>
> {
  const baseCap = await getDailyCap(agentId);
  const supabase = createAdminClient();
  const result: Array<{
    date: string;
    date_label: string;
    base_cap: number | null;
    override_extra: number;
    effective_cap: number | null;
    used: number;
    remaining: number | null;
    pct: number;
  }> = [];

  for (let i = 0; i < days; i++) {
    const d = new Date(Date.now() + i * 24 * 60 * 60 * 1000);
    const etOffsetMs = 4 * 60 * 60 * 1000;
    const dayStr = new Date(d.getTime() - etOffsetMs).toISOString().slice(0, 10);

    const { data: overrides } = await supabase
      .from("bulk_cap_overrides")
      .select("extra_granted")
      .eq("location_id", locationId)
      .eq("for_date", dayStr);
    const extra = (overrides || []).reduce((s, o) => s + (o.extra_granted ?? 0), 0);
    const effective = baseCap === null ? null : baseCap + extra;
    const used = await countRecipientsLast24h(locationId, d);
    const remaining = effective === null ? null : Math.max(0, effective - used);
    const pct = effective === null || effective === 0 ? 0 : Math.round((used / effective) * 100);

    result.push({
      date: dayStr,
      date_label: formatDateET(d),
      base_cap: baseCap,
      override_extra: extra,
      effective_cap: effective,
      used,
      remaining,
      pct,
    });
  }
  return result;
}

// =====================================================================
// F2.1 — bulk_dashboard
// =====================================================================

const bulkDashboard: ToolEntry = {
  def: {
    name: "bulk_dashboard",
    description:
      "📊 VISÃO CONSOLIDADA de TUDO sobre bulk messages numa única chamada. " +
      "Substitui chamar list_bulk_jobs + get_bulk_job_progress × N + checar cap manualmente. " +
      "Retorna:\n" +
      "  • active_jobs: running/paused com sent/pending/ETA/segments/cancel_command\n" +
      "  • recent_completed: últimos 5 completados/cancelados (7d)\n" +
      "  • alerts: runner stale, cap próximo (>80%), jobs travados\n" +
      "  • cap_status: cap usado/restante pros próximos 3 dias\n" +
      "  • dashboard_summary: TEXTO formatado em WhatsApp PRONTO pra exibir\n\n" +
      "Use quando rep falar:\n" +
      "  • 'meus disparos' / 'painel' / 'dashboard'\n" +
      "  • 'tá tudo bem com os disparos?' / 'tudo ok?'\n" +
      "  • 'quanto tá usado do cap?' / 'cap diário?'\n" +
      "  • Como ABERTURA quando rep mencionar bulk de qualquer forma — dá contexto pra decisão.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        include_completed: {
          type: "boolean",
          description: "Default true. False = só ativos.",
        },
        completed_lookback_days: {
          type: "number",
          description: "Default 7. Janela de completados a mostrar.",
        },
        cap_lookahead_days: {
          type: "number",
          description: "Default 3. Quantos dias futuros mostrar do cap.",
        },
      },
    },
  },
  handler: async (ctx) => {
    const supabase = createAdminClient();
    const agentId = await resolveAgentId(ctx.locationId);

    // Jobs ativos do rep
    const activeJobs = await getActiveBulkJobs(ctx.rep.id, ctx.locationId);

    // Recent completed
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: recentCompleted } = await supabase
      .from("bulk_message_jobs")
      .select("id, status, filter_config, sent_count, failed_count, total_contacts, created_at, completed_at, cancelled_reason")
      .eq("rep_id", ctx.rep.id)
      .eq("location_id", ctx.locationId)
      .in("status", ["completed", "cancelled", "failed"])
      .gte("created_at", cutoff)
      .order("created_at", { ascending: false })
      .limit(5);

    // Runner health
    const runnerHealth = await getRunnerHealth();

    // Cap status próximos 3 dias
    const capStatus = await getCapStatusNextDays(ctx.locationId, agentId, 3);

    // Alerts: jobs travados (running com pending overdue há >10min E sent_count parado >30min)
    const cutoffStale = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const cutoffOverdue = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const stalledJobs: Array<{ job_id: string; pending: number; sent: number; total: number }> = [];
    for (const j of activeJobs) {
      if (j.status !== "running") continue;
      const { data: jobRow } = await supabase
        .from("bulk_message_jobs")
        .select("updated_at")
        .eq("id", j.job_id)
        .maybeSingle();
      if (!jobRow || jobRow.updated_at > cutoffStale) continue;
      const { count: overdue } = await supabase
        .from("bulk_message_recipients")
        .select("id", { count: "exact", head: true })
        .eq("job_id", j.job_id)
        .eq("status", "pending")
        .lt("scheduled_at", cutoffOverdue);
      if ((overdue ?? 0) > 0) {
        stalledJobs.push({
          job_id: j.job_id,
          pending: overdue ?? 0,
          sent: j.sent_count,
          total: j.total_contacts,
        });
      }
    }

    // Build alerts list
    const alerts: Array<{ type: string; severity: string; message: string }> = [];
    if (runnerHealth.is_stale) {
      alerts.push({
        type: "runner_stale",
        severity: "high",
        message: `⚠️ Runner do bulk não bate heartbeat há ${Math.floor(runnerHealth.seconds_since_tick / 60)}min. Admin já foi notificado.`,
      });
    }
    if (runnerHealth.consecutive_errors >= 3) {
      alerts.push({
        type: "runner_errors",
        severity: "high",
        message: `⚠️ Runner com ${runnerHealth.consecutive_errors} erros consecutivos. Last: ${runnerHealth.last_error?.slice(0, 100)}`,
      });
    }
    for (const s of stalledJobs) {
      alerts.push({
        type: "job_stalled",
        severity: "high",
        message: `⚠️ Job ${s.job_id.slice(0, 8)} parece travado: ${s.pending} pendentes overdue, ${s.sent}/${s.total} enviados.`,
      });
    }
    for (const cs of capStatus) {
      if (cs.pct >= 80 && cs.effective_cap !== null) {
        alerts.push({
          type: "cap_approaching",
          severity: "medium",
          message: `⚠️ Cap diário ${cs.date_label} em ${cs.pct}% (${cs.used}/${cs.effective_cap}). Resta ${cs.remaining}.`,
        });
      }
    }

    // Build dashboard_summary text
    const lines: string[] = [];
    lines.push("📊 *DASHBOARD DE DISPAROS*");
    lines.push("");
    if (activeJobs.length === 0) {
      lines.push("🔭 Nenhum disparo ativo agora.");
    } else {
      lines.push(`🚀 *${activeJobs.length} disparo(s) ativo(s):*`);
      for (const j of activeJobs) {
        const segLabel = j.segments_labels.length > 0 ? j.segments_labels.join(", ") : "(legacy)";
        const statusEmoji = j.status === "paused" ? "⏸" : "🟢";
        const pct = j.total_contacts > 0
          ? Math.round((j.sent_count / j.total_contacts) * 100)
          : 0;
        lines.push(`  ${statusEmoji} *${segLabel}* — ${j.sent_count}/${j.total_contacts} (${pct}%)`);
        if (j.next_scheduled_at) {
          lines.push(`     ⏰ próx: ${formatDateTimeET(j.next_scheduled_at)}`);
        }
        if (j.estimated_completion_at) {
          lines.push(`     🏁 termina ~${formatDateTimeET(j.estimated_completion_at)}`);
        }
        lines.push(`     🆔 ${j.job_id.slice(0, 8)}`);
      }
    }

    lines.push("");
    lines.push("📅 *Cap diário (próx 3 dias):*");
    for (const cs of capStatus) {
      const overrideTxt = cs.override_extra > 0 ? ` (+${cs.override_extra} override)` : "";
      const bar = cs.effective_cap === null ? "ilimitado" :
        `${cs.used}/${cs.effective_cap}${overrideTxt} (${cs.pct}%)`;
      lines.push(`  • ${cs.date_label}: ${bar}`);
    }

    if (alerts.length > 0) {
      lines.push("");
      lines.push("🚨 *Alertas:*");
      for (const a of alerts) {
        lines.push(`  • ${a.message}`);
      }
    }

    if (recentCompleted && recentCompleted.length > 0) {
      lines.push("");
      lines.push("✅ *Últimos finalizados (7d):*");
      for (const r of recentCompleted.slice(0, 3)) {
        const fc = r.filter_config as Record<string, unknown> | null;
        const isMulti = fc && fc.type === "multi";
        const label = isMulti
          ? ((fc.segments as Array<{ label: string }> | undefined) || [])
              .map((s) => s.label)
              .join(", ") || "(multi)"
          : ((fc as { tag?: string } | null)?.tag || "(legacy)");
        const emoji = r.status === "completed" ? "✅" : r.status === "cancelled" ? "❌" : "⚠️";
        lines.push(`  ${emoji} ${label} — ${r.sent_count}/${r.total_contacts}`);
      }
    }

    if (activeJobs.length > 0) {
      lines.push("");
      lines.push("💡 *Comandos rápidos:*");
      lines.push("  • 'pausa todos' / 'cancela todos' — bulk ops");
      lines.push("  • 'pausa o XXXX' (id 8 chars) — pausa 1 específico");
      lines.push("  • 'progresso do XXXX' — detalhes 1 job");
      lines.push("  • 'preciso de mais cap' — pede override");
    }

    return {
      status: "ok",
      data: {
        active_jobs: activeJobs,
        recent_completed: (recentCompleted || []).map((r) => ({
          job_id: r.id,
          status: r.status,
          sent: r.sent_count,
          failed: r.failed_count,
          total: r.total_contacts,
          completed_at: r.completed_at,
          cancelled_reason: r.cancelled_reason,
        })),
        runner_health: runnerHealth,
        cap_status: capStatus,
        alerts,
        dashboard_summary: lines.join("\n"),
      },
    };
  },
};

// =====================================================================
// F2.2 — bulk_pause_all
// =====================================================================

const bulkPauseAll: ToolEntry = {
  def: {
    name: "bulk_pause_all",
    description:
      "⏸ Pausa TODOS os jobs running do rep nessa location de uma vez. " +
      "Recipients pending param em 'pending' (não saem mais até resume_all). " +
      "Use quando rep falar 'pausa todos', 'segura tudo', 'para tudo agora'.\n\n" +
      "Retorna lista dos jobs pausados + count. Idempotente — se nenhum running, retorna ok com 0 paused.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: async (ctx): Promise<ToolResult> => {
    const supabase = createAdminClient();
    const { data: jobs } = await supabase
      .from("bulk_message_jobs")
      .select("id, message_template, filter_config")
      .eq("rep_id", ctx.rep.id)
      .eq("location_id", ctx.locationId)
      .eq("status", "running");

    if (!jobs || jobs.length === 0) {
      return {
        status: "ok",
        data: {
          paused_count: 0,
          message: "Nenhum disparo running pra pausar.",
        },
      };
    }

    const ids = jobs.map((j) => j.id);
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "paused", paused_at: new Date().toISOString() })
      .in("id", ids);

    return {
      status: "ok",
      data: {
        paused_count: jobs.length,
        paused_jobs: jobs.map((j) => ({
          job_id: j.id,
          template_preview: String(j.message_template).slice(0, 50),
        })),
        message: `⏸ Pausei ${jobs.length} disparo(s). Use "retoma todos" pra continuar.`,
      },
    };
  },
};

// =====================================================================
// F2.3 — bulk_resume_all
// =====================================================================

const bulkResumeAll: ToolEntry = {
  def: {
    name: "bulk_resume_all",
    description:
      "▶️ Retoma TODOS os jobs paused do rep nessa location de uma vez. " +
      "Recipients pending voltam a sair conforme scheduled_at. " +
      "Use quando rep falar 'retoma todos', 'continua tudo', 'play em todos'.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {},
    },
  },
  handler: async (ctx): Promise<ToolResult> => {
    const supabase = createAdminClient();
    const { data: jobs } = await supabase
      .from("bulk_message_jobs")
      .select("id, message_template")
      .eq("rep_id", ctx.rep.id)
      .eq("location_id", ctx.locationId)
      .eq("status", "paused");

    if (!jobs || jobs.length === 0) {
      return {
        status: "ok",
        data: {
          resumed_count: 0,
          message: "Nenhum disparo paused pra retomar.",
        },
      };
    }

    const ids = jobs.map((j) => j.id);
    await supabase
      .from("bulk_message_jobs")
      .update({ status: "running", paused_at: null })
      .in("id", ids);

    return {
      status: "ok",
      data: {
        resumed_count: jobs.length,
        resumed_jobs: jobs.map((j) => ({
          job_id: j.id,
          template_preview: String(j.message_template).slice(0, 50),
        })),
        message: `▶️ Retomei ${jobs.length} disparo(s).`,
      },
    };
  },
};

// =====================================================================
// F2.4 — bulk_cancel_all
// =====================================================================

const bulkCancelAll: ToolEntry = {
  def: {
    name: "bulk_cancel_all",
    description:
      "❌ AÇÃO IRREVERSÍVEL: Cancela TODOS os jobs ativos (running + paused) do rep. " +
      "Recipients pending NUNCA serão enviados (já enviadas ficam intactas). " +
      "Use quando rep falar 'cancela todos', 'para tudo de vez', 'aborta tudo'.\n\n" +
      "⚠️ EXIGE confirmação explícita do rep (gate H8). Mostre PRIMEIRO o resumo com bulk_dashboard, " +
      "diga quantos jobs vão ser cancelados, pergunte 'Confirma cancelar tudo?', " +
      "DEPOIS chame com confirmed_by_rep:true.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Opcional — motivo do cancel (ex: 'mudei de ideia', 'erro no texto'). Vai pro audit.",
        },
      },
    },
  },
  handler: async (ctx, args): Promise<ToolResult> => {
    const supabase = createAdminClient();
    const reason = typeof args.reason === "string" ? args.reason : null;

    const { data: jobs } = await supabase
      .from("bulk_message_jobs")
      .select("id, sent_count, total_contacts, message_template")
      .eq("rep_id", ctx.rep.id)
      .eq("location_id", ctx.locationId)
      .in("status", ["running", "paused"]);

    if (!jobs || jobs.length === 0) {
      return {
        status: "ok",
        data: {
          cancelled_count: 0,
          message: "Nenhum disparo ativo pra cancelar.",
        },
      };
    }

    const ids = jobs.map((j) => j.id);
    const now = new Date().toISOString();
    await supabase
      .from("bulk_message_jobs")
      .update({
        status: "cancelled",
        completed_at: now,
        cancelled_reason: reason || "bulk_cancel_all by rep",
      })
      .in("id", ids);

    // Cancel pending recipients
    const { count: pendingCancelled } = await supabase
      .from("bulk_message_recipients")
      .select("id", { count: "exact", head: true })
      .in("job_id", ids)
      .eq("status", "pending");

    await supabase
      .from("bulk_message_recipients")
      .update({
        status: "cancelled",
        error_message: reason || "bulk_cancel_all by rep",
      })
      .in("job_id", ids)
      .eq("status", "pending");

    const totalSent = jobs.reduce((s, j) => s + (j.sent_count ?? 0), 0);

    return {
      status: "ok",
      data: {
        cancelled_count: jobs.length,
        recipients_cancelled: pendingCancelled ?? 0,
        already_sent: totalSent,
        cancelled_jobs: jobs.map((j) => ({
          job_id: j.id,
          template_preview: String(j.message_template).slice(0, 50),
          sent_before_cancel: j.sent_count ?? 0,
        })),
        message:
          `❌ Cancelei ${jobs.length} disparo(s). ` +
          `${pendingCancelled ?? 0} recipients pending cancelados. ` +
          `${totalSent} já tinham sido enviados antes (não dá pra desfazer).`,
      },
    };
  },
};

// =====================================================================
// F2.5 — bulk_reschedule_job
// =====================================================================

const bulkRescheduleJob: ToolEntry = {
  def: {
    name: "bulk_reschedule_job",
    description:
      "📅 Move UM job pendente pra outra data/hora. Recalcula scheduled_at de TODOS recipients pending mantendo espaçamento original (interval + jitter). Use quando rep falar 'adia o disparo XXXX pra terça', 'muda o horário do disparo X pra amanhã 9h'.\n\n" +
      "Bot precisa do job_id (8 chars) e do novo start ISO. Job DEVE estar running ou paused (não completed/cancelled).",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "ID do job (UUID ou 8 chars iniciais).",
        },
        new_start_at: {
          type: "string",
          description: "Novo start ISO 8601. Pode ser hoje futuro, amanhã, dias à frente.",
        },
      },
      required: ["job_id", "new_start_at"],
    },
  },
  handler: async (ctx, args): Promise<ToolResult> => {
    const supabase = createAdminClient();
    const jobIdRaw = String(args.job_id || "");
    const newStartStr = String(args.new_start_at || "");
    if (!jobIdRaw) return { status: "error", message: "job_id obrigatório", retryable: false };
    if (!newStartStr) return { status: "error", message: "new_start_at obrigatório", retryable: false };

    const newStart = new Date(newStartStr);
    if (isNaN(newStart.getTime())) {
      return { status: "error", message: "new_start_at inválido (use ISO 8601)", retryable: false };
    }
    if (newStart.getTime() < Date.now() - 60_000) {
      return { status: "error", message: "new_start_at não pode ser no passado", retryable: false };
    }

    // Resolve job (suporta 8-char prefix)
    let job: { id: string; status: string; start_at: string } | null = null;
    if (jobIdRaw.length === 36) {
      const { data } = await supabase
        .from("bulk_message_jobs")
        .select("id, status, start_at")
        .eq("id", jobIdRaw)
        .eq("rep_id", ctx.rep.id)
        .maybeSingle();
      job = data;
    } else {
      const { data } = await supabase
        .from("bulk_message_jobs")
        .select("id, status, start_at")
        .ilike("id", `${jobIdRaw}%`)
        .eq("rep_id", ctx.rep.id)
        .limit(2);
      if (data && data.length > 1) {
        return {
          status: "error",
          message: `Múltiplos jobs batem '${jobIdRaw}'. Use ID completo.`,
          retryable: false,
        };
      }
      job = data?.[0] || null;
    }
    if (!job) return { status: "not_found", message: `Job '${jobIdRaw}' não encontrado.` };
    if (!["running", "paused"].includes(job.status)) {
      return {
        status: "error",
        message: `Job está '${job.status}' — só reagenda running/paused.`,
        retryable: false,
      };
    }

    // Pega recipients pending, ordena por scheduled_at, calcula offset
    const { data: pending } = await supabase
      .from("bulk_message_recipients")
      .select("id, scheduled_at")
      .eq("job_id", job.id)
      .eq("status", "pending")
      .order("scheduled_at", { ascending: true });

    if (!pending || pending.length === 0) {
      return {
        status: "ok",
        data: {
          job_id: job.id,
          rescheduled: 0,
          message: "Nenhum recipient pending pra reagendar.",
        },
      };
    }

    const oldFirstSchedule = new Date(pending[0].scheduled_at).getTime();
    const offsetMs = newStart.getTime() - oldFirstSchedule;

    // Aplica offset em batch (PostgreSQL não tem UPDATE com expression cross-row em supabase-js;
    // fazemos 1 UPDATE por recipient. Pra jobs >100 isso fica lento — mas aceitável pra raros casos
    // de reschedule, geralmente <50 pending por reschedule.)
    let updated = 0;
    for (const r of pending) {
      const newScheduledAt = new Date(new Date(r.scheduled_at).getTime() + offsetMs);
      await supabase
        .from("bulk_message_recipients")
        .update({ scheduled_at: newScheduledAt.toISOString() })
        .eq("id", r.id);
      updated++;
    }

    // Atualiza job
    const lastNewScheduled = new Date(
      new Date(pending[pending.length - 1].scheduled_at).getTime() + offsetMs,
    );
    await supabase
      .from("bulk_message_jobs")
      .update({
        start_at: newStart.toISOString(),
        estimated_completion_at: lastNewScheduled.toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", job.id);

    return {
      status: "ok",
      data: {
        job_id: job.id,
        rescheduled: updated,
        new_first_send: newStart.toISOString(),
        new_last_send: lastNewScheduled.toISOString(),
        message:
          `📅 Reagendei ${updated} envios do disparo ${job.id.slice(0, 8)}. ` +
          `Primeiro: ${formatDateTimeET(newStart.toISOString())}. ` +
          `Último: ${formatDateTimeET(lastNewScheduled.toISOString())}.`,
      },
    };
  },
};

// =====================================================================
// F2.6 — bulk_edit_pending_job
// =====================================================================

const bulkEditPendingJob: ToolEntry = {
  def: {
    name: "bulk_edit_pending_job",
    description:
      "✏️ Edita um job que AINDA TEM recipients pending. Suporta:\n" +
      "  • new_template — atualiza message_template + reinterpola personalized_message dos pending\n" +
      "  • new_variation_mode — muda modo de variação (none/light/medium)\n" +
      "  • new_interval_seconds / new_jitter_seconds — ajusta espaçamento\n\n" +
      "Use quando rep falar 'muda o texto do disparo XXXX', 'aumenta o intervalo do XXXX pra 120s'.\n\n" +
      "⚠️ NÃO suporta mudar filtro/segments (cria job novo via schedule_bulk_message_v2 em vez disso). " +
      "Tools risk=high — pede confirmação.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "ID do job (UUID ou 8 chars)." },
        new_template: { type: "string", description: "Novo template. Suporta interpolação.", },
        new_variation_mode: { type: "string", enum: ["none", "light", "medium"] },
        new_interval_seconds: { type: "number", description: "30-600s" },
        new_jitter_seconds: { type: "number", description: "0-120s" },
      },
      required: ["job_id"],
    },
  },
  handler: async (ctx, args): Promise<ToolResult> => {
    const supabase = createAdminClient();
    const jobIdRaw = String(args.job_id || "");
    if (!jobIdRaw) return { status: "error", message: "job_id obrigatório", retryable: false };

    const newTemplate = typeof args.new_template === "string" ? args.new_template.trim() : null;
    const newVariation =
      ["none", "light", "medium"].includes(String(args.new_variation_mode))
        ? (String(args.new_variation_mode) as "none" | "light" | "medium")
        : null;
    const newInterval = typeof args.new_interval_seconds === "number"
      ? Math.min(600, Math.max(30, args.new_interval_seconds))
      : null;
    const newJitter = typeof args.new_jitter_seconds === "number"
      ? Math.min(120, Math.max(0, args.new_jitter_seconds))
      : null;

    if (!newTemplate && !newVariation && newInterval === null && newJitter === null) {
      return {
        status: "error",
        message: "Pelo menos 1 campo deve ser fornecido: new_template, new_variation_mode, new_interval_seconds ou new_jitter_seconds.",
        retryable: false,
      };
    }

    // Resolve job
    type EditJobRow = {
      id: string;
      status: string;
      filter_config: Record<string, unknown> | null;
      interval_seconds: number;
      jitter_seconds: number;
    };
    let job: EditJobRow | null = null;
    if (jobIdRaw.length === 36) {
      const { data } = await supabase
        .from("bulk_message_jobs")
        .select("id, status, filter_config, interval_seconds, jitter_seconds")
        .eq("id", jobIdRaw)
        .eq("rep_id", ctx.rep.id)
        .maybeSingle();
      job = (data as EditJobRow | null) ?? null;
    } else {
      const { data } = await supabase
        .from("bulk_message_jobs")
        .select("id, status, filter_config, interval_seconds, jitter_seconds")
        .ilike("id", `${jobIdRaw}%`)
        .eq("rep_id", ctx.rep.id)
        .limit(2);
      if (data && data.length > 1) {
        return { status: "error", message: `Múltiplos jobs batem '${jobIdRaw}'.`, retryable: false };
      }
      job = ((data?.[0] as EditJobRow | undefined) || null);
    }
    if (!job) return { status: "not_found", message: `Job '${jobIdRaw}' não encontrado.` };
    if (!["running", "paused"].includes(job.status)) {
      return { status: "error", message: `Job está '${job.status}' — só edita running/paused.`, retryable: false };
    }

    // Atualiza job-level fields
    const jobUpdates: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (newTemplate) jobUpdates.message_template = newTemplate;
    if (newVariation) jobUpdates.variation_mode = newVariation;
    if (newInterval !== null) jobUpdates.interval_seconds = newInterval;
    if (newJitter !== null) jobUpdates.jitter_seconds = newJitter;

    await supabase.from("bulk_message_jobs").update(jobUpdates).eq("id", job.id);

    // Re-interpolar personalized_message dos pending (se template mudou)
    let reinterpolated = 0;
    if (newTemplate) {
      const { data: pending } = await supabase
        .from("bulk_message_recipients")
        .select("id, contact_name, contact_phone")
        .eq("job_id", job.id)
        .eq("status", "pending");

      // Re-interpolação simples: substitui {first_name} / {name} / {phone}
      // (não suporta {custom.*} etc — pra isso teria que re-resolver custom_field_resolver).
      // Edit é caso simples; full re-interpolation seria cancel + schedule novo.
      for (const r of pending || []) {
        const firstName = (r.contact_name || "").split(" ")[0] || "Cliente";
        const personalized = newTemplate
          .replace(/\{first_name\}/g, firstName)
          .replace(/\{name\}/g, r.contact_name || "Cliente")
          .replace(/\{full_name\}/g, r.contact_name || "Cliente")
          .replace(/\{phone\}/g, r.contact_phone || "");
        await supabase
          .from("bulk_message_recipients")
          .update({ personalized_message: personalized })
          .eq("id", r.id);
        reinterpolated++;
      }
    }

    const changes: string[] = [];
    if (newTemplate) changes.push(`template (${reinterpolated} recipients reinterpolados)`);
    if (newVariation) changes.push(`variação=${newVariation}`);
    if (newInterval !== null) changes.push(`interval=${newInterval}s`);
    if (newJitter !== null) changes.push(`jitter=${newJitter}s`);

    return {
      status: "ok",
      data: {
        job_id: job.id,
        changes,
        recipients_reinterpolated: reinterpolated,
        message: `✏️ Editei disparo ${job.id.slice(0, 8)}: ${changes.join(", ")}.`,
      },
    };
  },
};

// =====================================================================
// F2.7 — bulk_request_cap_override
// =====================================================================

const bulkRequestCapOverride: ToolEntry = {
  def: {
    name: "bulk_request_cap_override",
    description:
      "📈 Eleva o cap diário pra um dia específico (com audit). Use quando rep falar:\n" +
      "  • 'preciso de mais cap hoje'\n" +
      "  • 'libera mais 100 pra amanhã'\n" +
      "  • 'ignora o cap pra esse disparo'\n\n" +
      "⚠️ HARD CEILING: cap_after máximo = base_cap × 3 (ex: base 100 → max 300). Bot DEVE alertar:\n" +
      "  ❌ 'Sei que vc quer +500, mas o teto absoluto é 300 (3x do base 100). Vou liberar 300?'\n\n" +
      "⚠️ Tool risk=high — pede confirmação. Mostre PRIMEIRO o estado atual (cap + usado + extra pedido), " +
      "pergunte 'Confirma liberar +N pra DDDD?', DEPOIS chame com confirmed_by_rep:true.\n\n" +
      "Após override criado, schedule_bulk_message_v2 já vê o novo cap automaticamente. " +
      "Audit fica em bulk_cap_overrides (admin vê uso/abuso).",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        for_date: {
          type: "string",
          description:
            "Dia do override (YYYY-MM-DD em ET) ou ISO 8601. Default = hoje. " +
            "Use 'today', 'tomorrow' como atalho (bot resolve).",
        },
        extra_count: {
          type: "number",
          description: "Quantos extras liberar (ex: 100 = +100 acima do cap base).",
        },
        reason: {
          type: "string",
          description: "Motivo do override (ex: 'campanha BF urgente', 'cliente especial M3'). Vai pro audit.",
        },
      },
      required: ["extra_count"],
    },
  },
  handler: async (ctx, args): Promise<ToolResult> => {
    const extra = Number(args.extra_count);
    if (!Number.isFinite(extra) || extra <= 0) {
      return { status: "error", message: "extra_count deve ser número positivo", retryable: false };
    }
    if (extra > 10000) {
      return { status: "error", message: "extra_count > 10000 não faz sentido", retryable: false };
    }

    // Resolve for_date
    let forDate = new Date();
    const fdInput = String(args.for_date || "").toLowerCase();
    if (fdInput === "tomorrow") {
      forDate = new Date(Date.now() + 24 * 60 * 60 * 1000);
    } else if (fdInput === "today" || fdInput === "") {
      forDate = new Date();
    } else {
      const parsed = new Date(fdInput);
      if (!isNaN(parsed.getTime())) forDate = parsed;
    }
    const etOffsetMs = 4 * 60 * 60 * 1000;
    const forDateStr = new Date(forDate.getTime() - etOffsetMs).toISOString().slice(0, 10);

    const agentId = await resolveAgentId(ctx.locationId);
    const baseCap = await getDailyCap(agentId);
    if (baseCap === null) {
      return {
        status: "error",
        message: "Esta location está com cap ILIMITADO (NULL). Override não faz sentido.",
        retryable: false,
      };
    }

    const maxAllowed = baseCap * MAX_OVERRIDE_MULTIPLIER;
    const existingExtra = await getEffectiveDailyCap(ctx.locationId, baseCap, forDate);
    const currentEffective = existingExtra ?? baseCap;
    const proposedEffective = currentEffective + extra;

    // Hard ceiling
    if (proposedEffective > maxAllowed) {
      const allowedExtra = Math.max(0, maxAllowed - currentEffective);
      return {
        status: "error",
        message:
          `❌ Hard ceiling: cap máximo é ${maxAllowed} (3x do base ${baseCap}). ` +
          `Hoje (${forDateStr}) já tá em ${currentEffective}. ` +
          `Máximo extra possível agora: ${allowedExtra}. ` +
          `Pedido ${extra} excede teto. Reduza pra ${allowedExtra} ou peça em outro dia.`,
        retryable: false,
      };
    }

    // Cria audit row
    const supabase = createAdminClient();
    const { data: created, error: insErr } = await supabase
      .from("bulk_cap_overrides")
      .insert({
        rep_identity_id: ctx.rep.id,
        location_id: ctx.locationId,
        agent_id: agentId,
        for_date: forDateStr,
        cap_before: currentEffective,
        cap_after: proposedEffective,
        extra_granted: extra,
        reason: typeof args.reason === "string" ? args.reason.slice(0, 500) : null,
        approved_by: "rep",
      })
      .select("id, created_at")
      .single();

    if (insErr || !created) {
      return { status: "error", message: `Falha ao criar override: ${insErr?.message || "unknown"}`, retryable: false };
    }

    return {
      status: "ok",
      data: {
        override_id: created.id,
        for_date: forDateStr,
        cap_before: currentEffective,
        cap_after: proposedEffective,
        extra_granted: extra,
        max_allowed: maxAllowed,
        message:
          `📈 Override aprovado pra ${forDateStr}: cap agora é ${proposedEffective} ` +
          `(antes ${currentEffective}, +${extra} liberado). ` +
          `Próximo schedule já vai usar esse cap.`,
      },
    };
  },
};

// =====================================================================
// Export
// =====================================================================

export const BULK_MANAGEMENT_TOOLS: ToolEntry[] = [
  bulkDashboard,
  bulkPauseAll,
  bulkResumeAll,
  bulkCancelAll,
  bulkRescheduleJob,
  bulkEditPendingJob,
  bulkRequestCapOverride,
];

// silence unused import (ToolContext) — usado só pra type-check
void (null as ToolContext | null);
