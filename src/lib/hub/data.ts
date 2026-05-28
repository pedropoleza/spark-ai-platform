/**
 * Loaders server-side do /hub (Fase B). Acesso direto ao DB via service role
 * (createAdminClient) SEMPRE escopado por location_id — server components não
 * carregam sessão supabase, então usamos admin + filtro explícito (mesmo padrão
 * do agent-platform.repo). Nada aqui roda no client.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listEntitlements, getAgentModuleInstances, listModules } from "@/lib/repositories/agent-platform.repo";
import { isEntitlementsEnforced } from "@/lib/agent-platform/entitlements";
import { DEFAULT_AGENT_MODULE_PRICE_USD, type AgentCapability } from "@/types/agent-platform";
import type { AgentConfig, CommunicationChannel } from "@/types/agent";
import type { AgentStatus, ChannelKey, HubAgentView, HubActivityItem } from "@/components/hub/types";
import { channelsFromDb } from "@/components/hub/types";

/* ─── mapeamentos type↔template↔capability ──────────────────────── */
export function typeToTemplateKey(type: string, templateKey?: string | null): string {
  if (templateKey) return templateKey;
  switch (type) {
    case "account_assistant":
      return "sparkbot";
    case "sales_agent":
      return "sales";
    case "recruitment_agent":
      return "recruitment";
    default:
      return "custom";
  }
}

export function templateCapability(templateKey: string): AgentCapability | null {
  if (templateKey === "sparkbot") return null;
  if (templateKey === "sales") return "sales_agent";
  if (templateKey === "recruitment") return "recruitment_agent";
  return "custom_agent";
}

function mapChannels(enabled?: CommunicationChannel[] | null): ChannelKey[] {
  // SMS = WhatsApp Web (Stevo), WhatsApp = WhatsApp API (Meta), Instagram = IG.
  return channelsFromDb(enabled as (string | null)[] | null);
}

function fmtSince(iso?: string | null): string | undefined {
  if (!iso) return undefined;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return undefined;
  return "desde " + new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short" }).format(d);
}

/* ─── Agentes da location → HubAgentView[] ──────────────────────── */
export async function loadHubAgents(locationId: string): Promise<HubAgentView[]> {
  const supabase = createAdminClient();

  const [{ data: agents }, entitlements] = await Promise.all([
    supabase.from("agents").select("*").eq("location_id", locationId).order("created_at"),
    listEntitlements(locationId),
  ]);

  const now = Date.now();
  const activeCaps = new Set(
    entitlements
      .filter((e) => e.status === "active" && (!e.expires_at || new Date(e.expires_at).getTime() > now))
      .map((e) => e.capability),
  );

  const rows = agents || [];
  const ids = rows.map((a) => a.id);
  const channelsByAgent = new Map<string, ChannelKey[]>();
  if (ids.length > 0) {
    const { data: configs } = await supabase
      .from("agent_configs")
      .select("agent_id, enabled_channels")
      .in("agent_id", ids);
    for (const c of configs || []) {
      channelsByAgent.set(c.agent_id as string, mapChannels(c.enabled_channels as CommunicationChannel[] | null));
    }
  }

  return rows.map((a): HubAgentView => {
    const templateKey = typeToTemplateKey(a.type, a.template_key);
    const audience = (a.audience as "rep" | "lead") || (templateKey === "sparkbot" ? "rep" : "lead");
    const included = templateKey === "sparkbot";
    const cap = templateCapability(templateKey);
    // Flag-aware: com AGENT_ENTITLEMENTS_ENFORCED OFF (default), nada é bloqueado
    // — não mostra "Bloqueado" pra agente usável (fix ultra-review 2026-05-26).
    const entitled = included || !isEntitlementsEnforced() || (cap ? activeCaps.has(cap) : false);

    let status: AgentStatus;
    if (!included && !entitled) status = "blocked";
    else status = a.status === "active" ? "active" : "paused";

    const channels = included ? (["whatsapp_web"] as ChannelKey[]) : channelsByAgent.get(a.id) || ["whatsapp_web"];

    return {
      id: a.id,
      name: a.name,
      template_key: templateKey,
      audience,
      status,
      channels,
      included,
      entitled,
      since: fmtSince(a.created_at),
      expires_at: a.expires_at ?? null,
    };
  });
}

/* ─── KPIs per-location (honestos) — reusa a lógica do /api/activity metrics ─ */
export interface HubMetrics {
  messagesSent30d: number;
  leadsQualified: number;
  appointmentsBooked: number;
  activeConversations: number;
  // Etapa F6 (Pedro 2026-05-28): visibility de prospecção na home.
  campaignsRunning: number;
  sequenceActive: number;
  recurringEnabled: number;
  optoutsTotal: number;
}

export async function loadHubMetrics(locationId: string): Promise<HubMetrics> {
  const supabase = createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [
    messagesRes,
    qualifiedRes,
    bookedRes,
    activeRes,
    campaignsRunningRes,
    sequenceActiveRes,
    recurringEnabledRes,
    optoutsTotalRes,
  ] = await Promise.all([
    supabase
      .from("execution_log")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("action_type", "send_message")
      .eq("success", true)
      .gte("created_at", thirtyDaysAgo),
    supabase
      .from("conversation_state")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("status", "qualified"),
    supabase
      .from("conversation_state")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("status", "booked"),
    supabase
      .from("conversation_state")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("status", "active"),
    // F6: prospecção counters per-location.
    supabase
      .from("bulk_message_jobs")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("status", "running"),
    supabase
      .from("bulk_message_sequence_state")
      .select("id, job_id, bulk_message_jobs!inner(location_id)", { count: "exact", head: true })
      .eq("status", "active")
      .eq("bulk_message_jobs.location_id", locationId),
    supabase
      .from("recurring_campaigns")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId)
      .eq("enabled", true),
    supabase
      .from("outreach_optouts")
      .select("id", { count: "exact", head: true })
      .eq("location_id", locationId),
  ]);

  return {
    messagesSent30d: messagesRes.count || 0,
    leadsQualified: qualifiedRes.count || 0,
    appointmentsBooked: bookedRes.count || 0,
    activeConversations: activeRes.count || 0,
    campaignsRunning: campaignsRunningRes.count || 0,
    sequenceActive: sequenceActiveRes.count || 0,
    recurringEnabled: recurringEnabledRes.count || 0,
    optoutsTotal: optoutsTotalRes.count || 0,
  };
}

/* ─── Feed de atividade (lead agents) ───────────────────────────── */
const ACTION_MAP: Record<string, { type: HubActivityItem["type"]; label: string }> = {
  send_message: { type: "msg", label: "Mensagem enviada" },
  book_appointment: { type: "scheduled", label: "Reunião agendada" },
  create_note: { type: "note", label: "Nota lançada" },
  create_task: { type: "task", label: "Tarefa criada" },
  qualify_lead: { type: "qualified", label: "Lead qualificado" },
};

// Limites das listas read do /hub (Pedro 2026-05-28). Exportados pras UIs
// mostrarem label honesto "Últimas N" quando a lista atinge o cap — antes era
// truncagem silenciosa (admin não sabia se tinha mais embaixo).
export const HUB_LIST_LIMITS = {
  activity: 40,
  paused_days: 30, // filtro de janela: últimos 30 dias
  paused: 200, // cap dentro da janela
  billing_activity: 15,
  entitlements: 2000,
  campaigns: 50, // últimas 50 campanhas
} as const;

/* ─── Campanhas (Etapa 4.1 — Prospecção 2.0) ─────────────────────── */
export interface HubCampaignRow {
  id: string;
  label: string;
  status: "running" | "paused" | "completed" | "cancelled" | "failed";
  agent_name: string;
  agent_id: string | null;
  sent_count: number;
  total_contacts: number;
  failed_count: number;
  skipped_count: number;
  delivery_channel: string;
  start_at: string; // ISO
  completed_at: string | null; // ISO
  estimated_completion_at: string | null; // ISO
  priority: number;
  message_preview: string; // primeiros 200 chars do template
}

/**
 * Lista campanhas de bulk-messages do location. Ordenada por start_at DESC.
 * Etapa 4.1.2 do plano de gaps — UI Campanhas no /hub.
 *
 * Resolve agent_name via batch query (igual loadHubActivity). Sem JOIN nativo
 * pra ficar consistente com o padrão dos outros loaders.
 */
export async function loadHubCampaigns(
  locationId: string,
  limit = HUB_LIST_LIMITS.campaigns,
): Promise<HubCampaignRow[]> {
  const supabase = createAdminClient();
  const { data: jobs } = await supabase
    .from("bulk_message_jobs")
    .select(
      "id, label, status, agent_id, sent_count, total_contacts, failed_count, skipped_count, delivery_channel, start_at, completed_at, estimated_completion_at, priority, message_template",
    )
    .eq("location_id", locationId)
    .order("start_at", { ascending: false })
    .limit(limit);

  const rows = jobs || [];
  const agentIds = Array.from(new Set(rows.map((r) => r.agent_id).filter((id): id is string => !!id)));
  let agentName: Record<string, string> = {};
  if (agentIds.length) {
    const { data: agents } = await supabase.from("agents").select("id, name").in("id", agentIds);
    agentName = Object.fromEntries((agents || []).map((a) => [a.id as string, (a.name as string) || "Agente"]));
  }

  return rows.map((r): HubCampaignRow => ({
    id: r.id as string,
    label: (r.label as string) || "Sem rótulo",
    status: r.status as HubCampaignRow["status"],
    agent_id: (r.agent_id as string) || null,
    agent_name: (r.agent_id && agentName[r.agent_id as string]) || "Agente",
    sent_count: Number(r.sent_count) || 0,
    total_contacts: Number(r.total_contacts) || 0,
    failed_count: Number(r.failed_count) || 0,
    skipped_count: Number(r.skipped_count) || 0,
    delivery_channel: (r.delivery_channel as string) || "whatsapp_web_sms",
    start_at: r.start_at as string,
    completed_at: (r.completed_at as string) || null,
    estimated_completion_at: (r.estimated_completion_at as string) || null,
    priority: Number(r.priority) || 0,
    message_preview: ((r.message_template as string) || "").slice(0, 200),
  }));
}

/* ─── Detail de campanha (Etapa 4.1 Commit C) ────────────────────── */
export interface HubCampaignSequenceStep {
  step_number: number;
  template: string;
  delay_days: number;
  pause_on_reply: boolean;
  sent_count: number;
  pending_count: number;
  cancelled_count: number;
}

export interface HubCampaignSequenceStats {
  active_states: number;
  paused_by_reply: number;
  completed: number;
}

export interface HubCampaignAbVariant {
  variant_id: number;
  letter: string; // "A", "B", ...
  template: string;
  weight: number;
  weight_pct: number; // % normalizado
  sent_count: number;
  pending_count: number;
  failed_count: number;
  total: number;
  // Etapa 4.7 final (Pedro 2026-05-28): reply tracking.
  reply_count: number;
  reply_rate: number; // 0-100 (% sobre sent_count)
}

export interface HubCampaignDetail extends HubCampaignRow {
  rep_id: string;
  filter_config: Record<string, unknown>;
  message_template: string; // full text (não truncado)
  variation_mode: string;
  interval_seconds: number;
  jitter_seconds: number;
  respect_quiet_hours: boolean;
  // Etapa 4.4: sequência multi-toque. Quando has_sequence=true, sequence_steps
  // tem N rows (1 por step). sequence_stats agrega state machine pra UI.
  has_sequence: boolean;
  sequence_steps?: HubCampaignSequenceStep[];
  sequence_stats?: HubCampaignSequenceStats;
  // Etapa 4.7: A/B variants + stats agregados por variant_id em recipients.
  ab_variants?: HubCampaignAbVariant[];
  // Etapa 4.7 final (Pedro 2026-05-28): reply rate global (válido pra single-shot
  // E pra A/B sumarizado). Calculado direto da tabela recipients (count replied_at).
  reply_count: number;
  reply_rate: number; // 0-100% sobre sent_count
}

/**
 * Detail completo de uma campanha. Inclui scope-check por location_id pra
 * impedir IDOR (admin de outra location não consegue ler/mudar campanha
 * alheia). Retorna null se não pertencer.
 */
export async function loadHubCampaignDetail(
  campaignId: string,
  locationId: string,
): Promise<HubCampaignDetail | null> {
  const supabase = createAdminClient();
  const { data: job } = await supabase
    .from("bulk_message_jobs")
    .select("*")
    .eq("id", campaignId)
    .eq("location_id", locationId)
    .maybeSingle();
  if (!job) return null;

  let agent_name = "Agente";
  if (job.agent_id) {
    const { data: agent } = await supabase.from("agents").select("name").eq("id", job.agent_id).maybeSingle();
    if (agent?.name) agent_name = String(agent.name);
  }

  // Etapa 4.7 final (Pedro 2026-05-28): reply rate global do job (single-shot
  // ou A/B sumarizado). Aproveita o COUNT que faríamos pra A/B abaixo se houver.
  const { count: globalRepliesRaw } = await supabase
    .from("bulk_message_recipients")
    .select("id", { count: "exact", head: true })
    .eq("job_id", job.id)
    .not("replied_at", "is", null);
  const globalReplyCount = globalRepliesRaw ?? 0;
  const globalSent = Number(job.sent_count) || 0;
  const globalReplyRate = globalSent > 0 ? Math.round((globalReplyCount / globalSent) * 1000) / 10 : 0;

  // Etapa 4.7: se tem ab_variants (JSONB), agrega stats por variant_id.
  let abVariantsStats: HubCampaignAbVariant[] | undefined;
  type AbVariant = { template: string; weight: number };
  const abVariantsRaw = (job.ab_variants as AbVariant[] | null) || null;
  if (Array.isArray(abVariantsRaw) && abVariantsRaw.length >= 2) {
    const totalWeight = abVariantsRaw.reduce((sum, v) => sum + Math.max(1, v.weight), 0);
    // Agrega counts em 1 query. Inclui replied_at pra reply rate por variant.
    const { data: variantCounts } = await supabase
      .from("bulk_message_recipients")
      .select("variant_id, status, replied_at")
      .eq("job_id", job.id)
      .not("variant_id", "is", null);
    const cMap = new Map<string, number>(); // "vid|status"
    const replyMap = new Map<number, number>(); // variant_id → reply count
    for (const r of (variantCounts || []) as Array<{ variant_id: number; status: string; replied_at: string | null }>) {
      const key = `${r.variant_id}|${r.status}`;
      cMap.set(key, (cMap.get(key) || 0) + 1);
      if (r.replied_at) {
        replyMap.set(r.variant_id, (replyMap.get(r.variant_id) || 0) + 1);
      }
    }
    abVariantsStats = abVariantsRaw.map((v, idx) => {
      const vid = idx + 1;
      const sent = cMap.get(`${vid}|sent`) || 0;
      const pending =
        (cMap.get(`${vid}|pending`) || 0) + (cMap.get(`${vid}|sending`) || 0);
      const failed =
        (cMap.get(`${vid}|failed`) || 0) +
        (cMap.get(`${vid}|cancelled`) || 0) +
        (cMap.get(`${vid}|skipped`) || 0);
      const replies = replyMap.get(vid) || 0;
      return {
        variant_id: vid,
        letter: String.fromCharCode(65 + idx),
        template: v.template,
        weight: v.weight,
        weight_pct: Math.round((Math.max(1, v.weight) / totalWeight) * 100),
        sent_count: sent,
        pending_count: pending,
        failed_count: failed,
        total: sent + pending + failed,
        reply_count: replies,
        reply_rate: sent > 0 ? Math.round((replies / sent) * 1000) / 10 : 0,
      };
    });
  }

  // Etapa 4.4: se has_sequence, hidrata steps + counts por step + agrega stats
  // de bulk_message_sequence_state (active/paused_by_reply/completed).
  const hasSequence = Boolean(job.has_sequence);
  let sequenceSteps: HubCampaignSequenceStep[] | undefined;
  let sequenceStats: HubCampaignSequenceStats | undefined;
  if (hasSequence) {
    const { data: steps } = await supabase
      .from("bulk_message_sequences")
      .select("step_number, template, delay_days, pause_on_reply")
      .eq("job_id", job.id)
      .order("step_number", { ascending: true });

    // Counts por step+status. 1 query agregação JS (não tem RPC GROUP BY simples
    // no PostgREST, mas dataset por job costuma ser <5k rows — aceitável).
    const { data: recipientStats } = await supabase
      .from("bulk_message_recipients")
      .select("sequence_step, status")
      .eq("job_id", job.id);
    const countMap = new Map<string, number>(); // key = "step|status"
    for (const r of (recipientStats || []) as Array<{ sequence_step: number | null; status: string }>) {
      const stp = r.sequence_step ?? 1; // jobs antigos sem sequence_step
      const key = `${stp}|${r.status}`;
      countMap.set(key, (countMap.get(key) || 0) + 1);
    }

    sequenceSteps = ((steps || []) as Array<{
      step_number: number;
      template: string;
      delay_days: number;
      pause_on_reply: boolean;
    }>).map((s) => ({
      step_number: s.step_number,
      template: s.template,
      delay_days: s.delay_days,
      pause_on_reply: s.pause_on_reply,
      sent_count: countMap.get(`${s.step_number}|sent`) || 0,
      pending_count:
        (countMap.get(`${s.step_number}|pending`) || 0) +
        (countMap.get(`${s.step_number}|sending`) || 0),
      cancelled_count:
        (countMap.get(`${s.step_number}|cancelled`) || 0) +
        (countMap.get(`${s.step_number}|skipped`) || 0) +
        (countMap.get(`${s.step_number}|failed`) || 0),
    }));

    // Stats globais da máquina de estado
    const { data: states } = await supabase
      .from("bulk_message_sequence_state")
      .select("status")
      .eq("job_id", job.id);
    const stMap = new Map<string, number>();
    for (const r of (states || []) as Array<{ status: string }>) {
      stMap.set(r.status, (stMap.get(r.status) || 0) + 1);
    }
    sequenceStats = {
      active_states: stMap.get("active") || 0,
      paused_by_reply: stMap.get("paused_by_reply") || 0,
      completed: stMap.get("completed") || 0,
    };
  }

  return {
    id: job.id as string,
    label: (job.label as string) || "Sem rótulo",
    status: job.status as HubCampaignDetail["status"],
    agent_id: (job.agent_id as string) || null,
    agent_name,
    sent_count: Number(job.sent_count) || 0,
    total_contacts: Number(job.total_contacts) || 0,
    failed_count: Number(job.failed_count) || 0,
    skipped_count: Number(job.skipped_count) || 0,
    delivery_channel: (job.delivery_channel as string) || "whatsapp_web_sms",
    start_at: job.start_at as string,
    completed_at: (job.completed_at as string) || null,
    estimated_completion_at: (job.estimated_completion_at as string) || null,
    priority: Number(job.priority) || 0,
    message_preview: ((job.message_template as string) || "").slice(0, 200),
    rep_id: job.rep_id as string,
    filter_config: (job.filter_config as Record<string, unknown>) || {},
    message_template: (job.message_template as string) || "",
    variation_mode: (job.variation_mode as string) || "none",
    interval_seconds: Number(job.interval_seconds) || 90,
    jitter_seconds: Number(job.jitter_seconds) || 30,
    respect_quiet_hours: Boolean(job.respect_quiet_hours),
    has_sequence: hasSequence,
    sequence_steps: sequenceSteps,
    sequence_stats: sequenceStats,
    ab_variants: abVariantsStats,
    reply_count: globalReplyCount,
    reply_rate: globalReplyRate,
  };
}

/* ─── Recorrências (Etapa 4.5) ──────────────────────────────────── */
export interface HubRecurringRow {
  id: string;
  label: string;
  agent_id: string;
  agent_name: string;
  cron_expression: string;
  timezone: string;
  enabled: boolean;
  last_run_at: string | null;
  next_run_at: string | null;
  tag: string | null;
  per_run_cap: number;
  delivery_channel: string;
}

export async function loadHubRecurringCampaigns(locationId: string): Promise<HubRecurringRow[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("recurring_campaigns")
    .select(
      "id, label, agent_id, cron_expression, timezone, enabled, last_run_at, next_run_at, filter_config, per_run_cap, delivery_channel",
    )
    .eq("location_id", locationId)
    .order("enabled", { ascending: false })
    .order("next_run_at", { ascending: true })
    .limit(50);
  const rows = (data || []) as Array<{
    id: string;
    label: string;
    agent_id: string;
    cron_expression: string;
    timezone: string;
    enabled: boolean;
    last_run_at: string | null;
    next_run_at: string | null;
    filter_config: { tag?: string } | null;
    per_run_cap: number;
    delivery_channel: string;
  }>;

  // Hidrata agent_name em batch
  const agentIds = Array.from(new Set(rows.map((r) => r.agent_id).filter(Boolean)));
  const agentMap = new Map<string, string>();
  if (agentIds.length > 0) {
    const { data: agents } = await supabase
      .from("agents")
      .select("id, name")
      .in("id", agentIds);
    for (const a of (agents || []) as Array<{ id: string; name: string }>) {
      agentMap.set(a.id, a.name || "Agente");
    }
  }

  return rows.map((r) => ({
    id: r.id,
    label: r.label,
    agent_id: r.agent_id,
    agent_name: agentMap.get(r.agent_id) || "Agente",
    cron_expression: r.cron_expression,
    timezone: r.timezone,
    enabled: r.enabled,
    last_run_at: r.last_run_at,
    next_run_at: r.next_run_at,
    tag: r.filter_config?.tag || null,
    per_run_cap: r.per_run_cap,
    delivery_channel: r.delivery_channel,
  }));
}

export async function loadHubActivity(locationId: string, limit = 40): Promise<HubActivityItem[]> {
  const supabase = createAdminClient();
  // Pedro 2026-05-28: include agent_id pra resolver agent_name real (antes era
  // "Agente" hardcoded). Channel segue "Spark Leads" como rótulo do CRM (não
  // mudou — é nome user-facing do GHL conforme CLAUDE.md, não literalmente
  // o canal técnico WhatsApp/SMS).
  const { data } = await supabase
    .from("execution_log")
    .select("id, action_type, contact_id, created_at, success, agent_id")
    .eq("location_id", locationId)
    .neq("action_type", "ai_processing") // rúido interno
    .order("created_at", { ascending: false })
    .limit(limit);

  const rows = data || [];
  // Lookup map de agent_id → name (1 query batched pra todos os IDs únicos).
  const agentIds = Array.from(new Set(rows.map((r) => r.agent_id).filter((id): id is string => !!id)));
  let agentName: Record<string, string> = {};
  if (agentIds.length) {
    const { data: agents } = await supabase.from("agents").select("id, name").in("id", agentIds);
    agentName = Object.fromEntries((agents || []).map((a) => [a.id as string, (a.name as string) || "Agente"]));
  }

  return rows.map((r): HubActivityItem => {
    const map = ACTION_MAP[r.action_type as string] || { type: "msg" as const, label: String(r.action_type) };
    const d = new Date(r.created_at as string);
    const t = isNaN(d.getTime())
      ? ""
      : new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(d);
    return {
      t,
      text: map.label + (r.success === false ? " (falhou)" : ""),
      agent: (r.agent_id && agentName[r.agent_id as string]) || "Agente",
      channel: "Spark Leads",
      type: map.type,
    };
  });
}

/* ─── Conversas pausadas / handoff (feedback Pedro 1c) ──────────── */
export interface PausedConversationRow {
  agent_id: string;
  agent_name: string;
  contact_id: string;
  contact_label: string; // nome/telefone quando conhecido, senão id curto
  status: string;
  reason: string | null;
  paused_at: string | null; // formatado pt-BR
}

function fmtDateTime(iso?: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
}

// Motivos vêm do runtime (ex: "opt_out:parar", "auto_pause:human_message",
// "handoff_message:...", "ai_parse_failure_loop"). Humaniza pro admin.
function humanizePauseReason(raw?: string | null): string {
  if (!raw) return "Pausada";
  const r = raw.toLowerCase();
  if (r.startsWith("opt_out")) return "Lead pediu pra parar";
  if (r.includes("human_message") || r.includes("human")) return "Atendente humano assumiu";
  if (r.includes("handoff")) return "Repassada pra equipe";
  if (r.includes("parse_failure") || r.includes("parse")) return "Pausada por erro técnico";
  return "Pausada";
}

/**
 * Conversas de lead em que a IA está PAUSADA pra um contato (ai_paused_at setado
 * — opt-out, handoff humano ou erro). Escopo por location. Nome do contato é
 * best-effort via followup_sequences; senão mostra id curto.
 */
export async function loadPausedConversations(locationId: string): Promise<PausedConversationRow[]> {
  const supabase = createAdminClient();
  // Pedro 2026-05-28: janela de 30 dias + cap 200. Antes era só top-200 sem
  // filtro de tempo, e pausadas de 6 meses atrás tampavam as recentes —
  // admin não conseguia investigar o que importa.
  const since = new Date();
  since.setDate(since.getDate() - HUB_LIST_LIMITS.paused_days);
  const { data: convs } = await supabase
    .from("conversation_state")
    .select("agent_id, contact_id, status, ai_paused_at, ai_paused_reason")
    .eq("location_id", locationId)
    .not("ai_paused_at", "is", null)
    .gte("ai_paused_at", since.toISOString())
    .order("ai_paused_at", { ascending: false })
    .limit(HUB_LIST_LIMITS.paused);
  const rows = (convs || []) as { agent_id: string; contact_id: string; status: string | null; ai_paused_at: string | null; ai_paused_reason: string | null }[];
  if (rows.length === 0) return [];

  const agentIds = [...new Set(rows.map((r) => r.agent_id))];
  const contactIds = [...new Set(rows.map((r) => r.contact_id))];
  const [agentsRes, seqRes] = await Promise.all([
    supabase.from("agents").select("id, name").in("id", agentIds),
    supabase.from("followup_sequences").select("contact_id, contact_name, contact_phone").eq("location_id", locationId).in("contact_id", contactIds),
  ]);
  const agentName = new Map((agentsRes.data || []).map((a) => [a.id as string, a.name as string]));
  const contactLabel = new Map<string, string>();
  for (const s of (seqRes.data || []) as { contact_id: string; contact_name: string | null; contact_phone: string | null }[]) {
    if (!contactLabel.has(s.contact_id)) {
      const lbl = s.contact_name || s.contact_phone;
      if (lbl) contactLabel.set(s.contact_id, lbl);
    }
  }

  return rows.map((r) => ({
    agent_id: r.agent_id,
    agent_name: agentName.get(r.agent_id) || "Agente",
    contact_id: r.contact_id,
    contact_label: contactLabel.get(r.contact_id) || ("Contato " + r.contact_id.slice(0, 8)),
    status: r.status || "handed_off",
    reason: humanizePauseReason(r.ai_paused_reason),
    paused_at: fmtDateTime(r.ai_paused_at),
  }));
}

/* ─── Detalhe de 1 agente (header + config + módulos ligados) ────── */
export interface HubAgentModuleRow {
  key: string;
  category: string;
  name: string;
  enabled: boolean;
}

export interface HubAgentDetail extends HubAgentView {
  config: AgentConfig | null;
  modules: HubAgentModuleRow[];
}

export async function loadHubAgentDetail(agentId: string, locationId: string): Promise<HubAgentDetail | null> {
  const supabase = createAdminClient();

  // Escopo por location_id também (não só id) — defesa contra IDOR entre contas.
  const { data: agent } = await supabase
    .from("agents")
    .select("*")
    .eq("id", agentId)
    .eq("location_id", locationId)
    .maybeSingle();
  if (!agent) return null;

  const [{ data: config }, instances, catalog, entitlements] = await Promise.all([
    supabase.from("agent_configs").select("*").eq("agent_id", agentId).maybeSingle(),
    getAgentModuleInstances(agentId),
    listModules(),
    listEntitlements(locationId),
  ]);

  const templateKey = typeToTemplateKey(agent.type, agent.template_key);
  const audience = (agent.audience as "rep" | "lead") || (templateKey === "sparkbot" ? "rep" : "lead");
  const included = templateKey === "sparkbot";
  const cap = templateCapability(templateKey);
  const now = Date.now();
  const activeCaps = new Set(
    entitlements
      .filter((e) => e.status === "active" && (!e.expires_at || new Date(e.expires_at).getTime() > now))
      .map((e) => e.capability),
  );
  const entitled = included || (cap ? activeCaps.has(cap) : false);

  let status: AgentStatus;
  if (!included && !entitled) status = "blocked";
  else status = agent.status === "active" ? "active" : "paused";

  const cfg = (config as AgentConfig | null) || null;
  const channels = included
    ? (["whatsapp_web"] as ChannelKey[])
    : mapChannels(cfg?.enabled_channels) || ["whatsapp_web"];

  // instances vêm enabled=true (getAgentModuleInstances filtra). Montamos a
  // lista a partir do CATÁLOGO filtrado por audiência, marcando o que está ligado
  // — assim a config mostra todos os módulos possíveis com seus toggles (igual v3).
  const enabledKeys = new Set(instances.map((i) => i.module_key));
  const audienceCatalog = catalog.filter(
    (m) => m.audience_scope === "both" || m.audience_scope === audience,
  );
  const modules: HubAgentModuleRow[] = audienceCatalog.map((m) => ({
    key: m.key,
    category: m.category as string,
    name: m.name,
    enabled: enabledKeys.has(m.key),
  }));

  return {
    id: agent.id,
    name: agent.name,
    template_key: templateKey,
    audience,
    status,
    channels,
    included,
    entitled,
    since: fmtSince(agent.created_at),
    expires_at: agent.expires_at ?? null,
    config: cfg,
    modules,
  };
}

/* ─── Grade de Acessos (admin) — escritórios × capacidade ───────── */
export type EntStatus = "active" | "revoked" | null;
export interface EntitlementGridRow {
  location_id: string;
  location_name: string;
  sales: EntStatus;
  recruitment: EntStatus;
  custom: EntStatus;
  price: number;
  since: string | null;
}

// Pedro 2026-05-28: statusFilter opcional ("active" | "revoked" | "none" | "all"
// default). Antes loadava todas as locations (até 2000), UI filtrava client-side
// — pra company com 500 sub-accounts, cargapesada e impossível paginar.
export type EntitlementsStatusFilter = "all" | "active" | "revoked" | "none";

export async function loadEntitlementsGrid(
  companyId: string,
  statusFilter: EntitlementsStatusFilter = "all",
): Promise<EntitlementGridRow[]> {
  const supabase = createAdminClient();
  const { data: locations } = await supabase
    .from("locations")
    .select("location_id, location_name")
    .eq("company_id", companyId)
    // C1-P2g (ultra-review 2026-05-26): NÃO filtra location_name IS NOT NULL —
    // antes escritórios sem nome sumiam silenciosamente da grade de Acessos.
    // A linha que monta a row já usa location_id como fallback de exibição.
    .order("location_name", { nullsFirst: false });
  const locs = locations || [];
  const ids = locs.map((l) => l.location_id);

  let ents: { location_id: string; capability: string; status: string; monthly_price_usd: number; granted_at: string }[] = [];
  if (ids.length) {
    const { data } = await supabase
      .from("agent_entitlements")
      .select("location_id, capability, status, monthly_price_usd, granted_at")
      .in("location_id", ids);
    ents = (data as typeof ents | null) || [];
  }

  const rows = new Map<string, EntitlementGridRow>();
  for (const l of locs) {
    rows.set(l.location_id, {
      location_id: l.location_id,
      location_name: (l.location_name as string) || l.location_id,
      sales: null,
      recruitment: null,
      custom: null,
      price: 50,
      since: null,
    });
  }
  for (const e of ents) {
    const r = rows.get(e.location_id);
    if (!r) continue;
    const status = (e.status === "active" ? "active" : "revoked") as EntStatus;
    if (e.capability === "sales_agent") r.sales = status;
    else if (e.capability === "recruitment_agent") r.recruitment = status;
    else if (e.capability === "custom_agent") r.custom = status;
    if (e.status === "active") {
      r.price = Number(e.monthly_price_usd) || 50;
      r.since = e.granted_at;
    }
  }
  const all = Array.from(rows.values());
  // Pedro 2026-05-28: filtro server-side. "active" = pelo menos 1 capability
  // ativa; "revoked" = pelo menos 1 capability revoked + nenhuma ativa;
  // "none" = sem nenhuma entitlement (sales/recruitment/custom todos null);
  // "all" = retorna tudo (default, retrocompat).
  if (statusFilter === "all") return all;
  return all.filter((r) => {
    const anyActive = r.sales === "active" || r.recruitment === "active" || r.custom === "active";
    const anyRevoked = r.sales === "revoked" || r.recruitment === "revoked" || r.custom === "revoked";
    if (statusFilter === "active") return anyActive;
    if (statusFilter === "revoked") return anyRevoked && !anyActive;
    /* statusFilter === "none" */ return !anyActive && !anyRevoked;
  });
}

/* ─── Faturamento (per-location) ─────────────────────────────────── */
export interface HubBilling {
  paidAgents: { id: string; name: string; template_key: string; price: number }[];
  subscriptionTotal: number;
  monthCharged: number;
  monthTokens: number;
  monthAudioSec: number;
  monthImages: number;
  monthInteractions: number;
  recent: { date: string; action: string; model: string; tokens: number; charge: number }[];
  // Etapa 3.3 (Pedro 2026-05-28): range efetivo carregado (pra UI mostrar).
  rangeLabel: string;
  rangeFromIso: string;
  rangeToIso: string;
}

export interface BillingRange {
  /** ISO start date (inclusive). Default: 1º dia do mês atual. */
  fromIso?: string;
  /** ISO end date (inclusive). Default: agora. */
  toIso?: string;
  /** Label pra UI ("Este mês", "Últimos 30d", etc). */
  label?: string;
}

export async function loadBilling(
  locationId: string,
  range?: BillingRange,
): Promise<HubBilling> {
  const supabase = createAdminClient();
  const LEAD = new Set(["sales_agent", "recruitment_agent", "custom_agent"]);

  const { data: agents } = await supabase
    .from("agents")
    .select("id, name, type, template_key, status")
    .eq("location_id", locationId);

  const paidAgents = (agents || [])
    .filter((a) => LEAD.has(a.type) && a.status === "active")
    .map((a) => ({
      id: a.id,
      name: a.name,
      template_key: typeToTemplateKey(a.type, a.template_key),
      price: DEFAULT_AGENT_MODULE_PRICE_USD,
    }));
  const subscriptionTotal = paidAgents.length * DEFAULT_AGENT_MODULE_PRICE_USD;

  // Etapa 3.3 (Pedro 2026-05-28): range customizável. Default: mês atual.
  let fromDate: Date;
  if (range?.fromIso) {
    fromDate = new Date(range.fromIso);
    if (isNaN(fromDate.getTime())) {
      fromDate = new Date();
      fromDate.setDate(1);
      fromDate.setHours(0, 0, 0, 0);
    }
  } else {
    fromDate = new Date();
    fromDate.setDate(1);
    fromDate.setHours(0, 0, 0, 0);
  }
  const toIso = range?.toIso || new Date().toISOString();

  const { data: usage } = await supabase
    .from("usage_records")
    .select("total_tokens, total_charge_usd, audio_seconds, image_count, action_type, ai_model, created_at")
    .eq("location_id", locationId)
    .gte("created_at", fromDate.toISOString())
    .lte("created_at", toIso)
    .order("created_at", { ascending: false })
    .limit(2000);

  const u = usage || [];
  const fmtT = (iso: string) => {
    const d = new Date(iso);
    return isNaN(d.getTime()) ? "" : new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(d);
  };
  // C1-P2d (ultra-review 2026-05-26): humaniza action_type/ai_model crus
  // (antes a tabela mostrava "ai_processing" / "claude-sonnet-4-6-..." direto).
  const ACTION_LABELS: Record<string, string> = {
    ai_processing: "Conversa (IA)",
    account_assistant_turn: "SparkBot",
    send_message: "Mensagem enviada",
    audio_transcription: "Transcrição de áudio",
    summary_note: "Resumo de conversa",
    history_compression: "Compressão de histórico",
    follow_up: "Follow-up",
  };
  const humanizeAction = (raw: string): string => {
    if (!raw) return "—";
    if (raw.startsWith("proactive:")) return "Proativo: " + raw.slice("proactive:".length);
    return ACTION_LABELS[raw] || raw;
  };
  const humanizeModel = (raw: string): string => {
    if (!raw) return "—";
    const r = raw.toLowerCase();
    if (r.includes("sonnet")) return "Claude Sonnet";
    if (r.includes("haiku")) return "Claude Haiku";
    if (r.includes("opus")) return "Claude Opus";
    if (r.includes("whisper")) return "Whisper";
    if (r.includes("gpt-4.1-nano")) return "GPT-4.1 nano";
    if (r.includes("gpt-4.1-mini")) return "GPT-4.1 mini";
    if (r.includes("gpt-4.1")) return "GPT-4.1";
    if (r.startsWith("gpt-")) return raw.toUpperCase();
    return raw;
  };

  return {
    paidAgents,
    subscriptionTotal,
    monthCharged: Math.round(u.reduce((s, r) => s + Number(r.total_charge_usd || 0), 0) * 100) / 100,
    monthTokens: u.reduce((s, r) => s + (r.total_tokens || 0), 0),
    monthAudioSec: u.reduce((s, r) => s + (Number(r.audio_seconds) || 0), 0),
    monthImages: u.reduce((s, r) => s + (Number(r.image_count) || 0), 0),
    monthInteractions: u.length,
    recent: u.slice(0, 15).map((r) => ({
      date: fmtT(r.created_at as string),
      action: humanizeAction(String(r.action_type || "")),
      model: humanizeModel(String(r.ai_model || "")),
      tokens: r.total_tokens || 0,
      charge: Number(r.total_charge_usd || 0),
    })),
    rangeLabel: range?.label || "Este mês",
    rangeFromIso: fromDate.toISOString(),
    rangeToIso: toIso,
  };
}

