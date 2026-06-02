/**
 * Formatter de resumos de bulk jobs (Pedro 2026-05-15).
 *
 * 3 momentos de uso:
 *   1. preview_bulk_message_v2 — pre-confirmation summary (rep decide)
 *   2. schedule_bulk_message_v2 — post-creation summary (job criado)
 *   3. get_bulk_job_progress — runtime progress summary (rep checa)
 *
 * Saída é texto formatado em WhatsApp (asteriscos pra negrito, quebras
 * naturais). Bot exibe quase verbatim — mantém consistência visual.
 *
 * Inputs vêm já normalizados pelos handlers; formatter é puro (sem I/O).
 */

import type { DeliveryOption, DeliveryStrategy } from "./bulk-delivery-strategy";

// ---------------------------------------------------------------------
// Tipos de input
// ---------------------------------------------------------------------

export interface PreviewSummaryInput {
  total_contacts: number;
  segments: Array<{
    label: string;
    count_after_dedup: number;
    template_placeholders?: string[];
  }>;
  list_temperature: "warm" | "cold" | "unknown";
  delivery_options: DeliveryOption[];
  disclaimers: Array<{ key: string; severity: string; text: string }>;
  daily_cap: number | null;
  used_today: number;
  would_exceed_cap: boolean;
  risk_level: string;
}

export interface ScheduleSummaryInput {
  job_id: string;
  total_enqueued: number;
  segments_summary: Array<{ label: string; count: number }>;
  delivery_strategy: DeliveryStrategy;
  start_at: string;          // ISO
  eta_minutes: number;
  delivery_channel: string;
  daily_breakdown?: Array<{ day: string; count: number }>;
}

export interface ProgressSummaryInput {
  job_id: string;
  status: string;            // running | paused | completed | cancelled
  total: number;
  sent: number;
  failed: number;
  skipped: number;
  pending: number;
  segments_progress: Array<{
    label: string;
    total: number;
    sent: number;
    pending: number;
    failed: number;
  }>;
  daily_progress: Array<{
    day: string;
    sent: number;
    pending: number;
    failed: number;
  }>;
  start_at?: string;
  next_scheduled_at?: string;
  eta_completion?: string;
  delivery_strategy?: DeliveryStrategy;
}

// ---------------------------------------------------------------------
// Pre-confirmation (preview)
// ---------------------------------------------------------------------

export function formatPreviewSummary(input: PreviewSummaryInput): string {
  const lines: string[] = [];

  lines.push(`📋 *RESUMO DO DISPARO*`);
  lines.push("");
  lines.push(`👥 *Total:* ${input.total_contacts} contatos`);
  if (input.segments.length > 1) {
    lines.push("");
    lines.push(`📦 *Segmentos:*`);
    for (const s of input.segments) {
      lines.push(`   • ${s.label}: ${s.count_after_dedup}`);
    }
  } else if (input.segments.length === 1) {
    const seg = input.segments[0];
    if (seg.label !== "Segment 1") {
      lines.push(`📦 Segmento: ${seg.label}`);
    }
  }

  // Lista quente/fria
  lines.push("");
  const tempLabel =
    input.list_temperature === "warm"
      ? "🔥 LISTA QUENTE"
      : input.list_temperature === "cold"
        ? "❄️ LISTA FRIA"
        : "❓ Lista (não confirmada)";
  lines.push(`🚦 ${tempLabel}`);
  lines.push("");

  // Delivery options menu
  lines.push(`📅 *Como prefere disparar?*`);
  for (const opt of input.delivery_options) {
    lines.push(`*${opt.id}.* ${opt.label}`);
    if (opt.daily_breakdown.length > 0) {
      const breakdown = opt.daily_breakdown.map((b) => `${b.day} = ${b.count}`).join(" | ");
      lines.push(`   ${breakdown}`);
    } else {
      lines.push(`   ${opt.description}`);
    }
    if (opt.warnings.length > 0) {
      for (const w of opt.warnings) lines.push(`   ${w}`);
    }
  }
  lines.push("");

  // Cap diário
  if (input.daily_cap !== null) {
    const cap = input.daily_cap;
    const remaining = cap - input.used_today;
    lines.push(`⚙️ Cap diário: ${input.used_today}/${cap} usado (resta ${remaining})`);
    if (input.would_exceed_cap) {
      lines.push(`   ⚠️ Volume excede cap diário — overflow automático pra próximo dia útil`);
    }
    lines.push("");
  }

  // Disclaimers pendentes
  if (input.disclaimers.length > 0) {
    lines.push(`⚠️ *Disclaimers pendentes (preciso de OK em cada):*`);
    for (const d of input.disclaimers) {
      const summary = d.text.slice(0, 100).replace(/\n/g, " ");
      lines.push(`   • ${summary}${d.text.length > 100 ? "..." : ""}`);
    }
    lines.push("");
  }

  lines.push(`Risk level: *${input.risk_level.toUpperCase()}*`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Post-creation (schedule)
// ---------------------------------------------------------------------

export function formatScheduleSummary(input: ScheduleSummaryInput): string {
  const lines: string[] = [];
  const strategy = input.delivery_strategy;

  lines.push(`✅ *DISPARO AGENDADO*`);
  lines.push("");
  lines.push(`🆔 *Job ID:* ${input.job_id.slice(0, 8)}... (use pra pausar/cancelar/checar progresso)`);
  lines.push("");
  lines.push(`👥 *${input.total_enqueued} contatos* enfileirados`);

  if (input.segments_summary.length > 1) {
    lines.push("");
    lines.push(`📦 *Por segmento:*`);
    for (const s of input.segments_summary) {
      lines.push(`   • ${s.label}: ${s.count}`);
    }
  }

  lines.push("");
  lines.push(`📅 *Cronograma:*`);
  switch (strategy.type) {
    case "today":
      lines.push(`   Tudo hoje — interval ${strategy.interval_seconds || 90}s ± ${strategy.jitter_seconds || 30}s`);
      lines.push(`   Primeiro envio: ${formatDateTime(input.start_at)}`);
      lines.push(`   ETA: ${input.eta_minutes} min`);
      break;
    case "spread_days":
      lines.push(`   Spread em ${strategy.days_count} dias úteis (skip sáb/dom)`);
      if (input.daily_breakdown) {
        for (const b of input.daily_breakdown) {
          lines.push(`   • ${b.day}: ${b.count} contatos`);
        }
      }
      lines.push(`   Por dia: ETA ${input.eta_minutes} min`);
      break;
    case "custom_window": {
      // F41 (Pedro 2026-06-02): mostra detalhes do pacing com unidade humana.
      // Ex: "12 contatos a cada 3min = 36min total, das 14:00 às 14:36"
      const interval = strategy.interval_seconds || 90;
      const intervalLabel = interval >= 60
        ? `${interval % 60 === 0 ? interval / 60 : (interval / 60).toFixed(1)}min`
        : `${interval}s`;
      const startMs = new Date(strategy.start_at).getTime();
      const endMs = new Date(strategy.end_at).getTime();
      const windowMin = Math.round((endMs - startMs) / 60000);
      lines.push(`   ⏱️  ${input.total_enqueued} contatos · *${intervalLabel}* entre cada · ${windowMin}min total`);
      lines.push(`   📅 ${formatDateTime(strategy.start_at)} → ${formatDateTime(strategy.end_at)}`);
      lines.push(`   ℹ️  Pacing salvo como tua preferência. Próxima campanha usa o mesmo se nada mudar — me avisa pra ajustar.`);
      break;
    }
  }

  lines.push("");
  lines.push(`📡 Canal: ${input.delivery_channel === "whatsapp_api" ? "WhatsApp API" : "WhatsApp Web"}`);
  lines.push("");
  lines.push(`💡 *Comandos disponíveis:*`);
  lines.push(`   "como tá o disparo?" — checa progresso`);
  lines.push(`   "pausa o disparo" — pausa envios pendentes`);
  lines.push(`   "cancela o disparo" — cancela tudo restante`);

  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Runtime progress
// ---------------------------------------------------------------------

export function formatProgressSummary(input: ProgressSummaryInput): string {
  const lines: string[] = [];

  const statusEmoji =
    input.status === "running" ? "🟢"
    : input.status === "paused" ? "⏸"
    : input.status === "completed" ? "✅"
    : input.status === "cancelled" ? "❌"
    : "⚠️";

  lines.push(`📊 *PROGRESSO DO DISPARO*`);
  lines.push("");
  lines.push(`${statusEmoji} Status: *${input.status}*`);
  lines.push(`🆔 ${input.job_id.slice(0, 8)}...`);
  lines.push("");

  const pct =
    input.total > 0
      ? Math.round(((input.sent + input.failed + input.skipped) / input.total) * 100)
      : 0;

  lines.push(`👥 *${input.sent}/${input.total} enviados* (${pct}%)`);
  if (input.failed > 0) lines.push(`   ❌ ${input.failed} falharam`);
  if (input.skipped > 0) lines.push(`   ⏭ ${input.skipped} skipados`);
  if (input.pending > 0) lines.push(`   ⏳ ${input.pending} pendentes`);

  if (input.segments_progress.length > 1) {
    lines.push("");
    lines.push(`📦 *Por segmento:*`);
    for (const s of input.segments_progress) {
      const segPct = s.total > 0 ? Math.round((s.sent / s.total) * 100) : 0;
      lines.push(`   • ${s.label}: ${s.sent}/${s.total} (${segPct}%)`);
    }
  }

  if (input.daily_progress.length > 0) {
    lines.push("");
    lines.push(`📅 *Por dia:*`);
    for (const d of input.daily_progress) {
      const parts: string[] = [];
      if (d.sent > 0) parts.push(`✓ ${d.sent} enviados`);
      if (d.pending > 0) parts.push(`⏳ ${d.pending} pendentes`);
      if (d.failed > 0) parts.push(`✗ ${d.failed} falharam`);
      lines.push(`   • ${d.day}: ${parts.join(" | ") || "(sem msgs)"}`);
    }
  }

  if (input.next_scheduled_at) {
    lines.push("");
    lines.push(`⏰ Próxima msg: ${formatDateTime(input.next_scheduled_at)}`);
  }
  if (input.eta_completion && input.status === "running") {
    lines.push(`🏁 ETA conclusão: ${formatDateTime(input.eta_completion)}`);
  }

  if (input.status === "running") {
    lines.push("");
    lines.push(`💡 "pausa" pra pausar, "cancela" pra cancelar.`);
  } else if (input.status === "paused") {
    lines.push("");
    lines.push(`💡 "retoma" pra continuar de onde parou, "cancela" pra cancelar.`);
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

function formatDateTime(iso: string): string {
  try {
    const d = new Date(iso);
    return d.toLocaleString("pt-BR", {
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
