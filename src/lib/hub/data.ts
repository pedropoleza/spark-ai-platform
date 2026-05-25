/**
 * Loaders server-side do /hub (Fase B). Acesso direto ao DB via service role
 * (createAdminClient) SEMPRE escopado por location_id — server components não
 * carregam sessão supabase, então usamos admin + filtro explícito (mesmo padrão
 * do agent-platform.repo). Nada aqui roda no client.
 */
import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { listEntitlements, getAgentModuleInstances, listModules } from "@/lib/repositories/agent-platform.repo";
import type { AgentCapability } from "@/types/agent-platform";
import type { AgentConfig, CommunicationChannel } from "@/types/agent";
import type { AgentStatus, ChannelKey, HubAgentView, HubActivityItem } from "@/components/hub/types";

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
  const set = new Set<ChannelKey>();
  for (const c of enabled || []) {
    if (c === "WhatsApp" || c === "SMS") set.add("whatsapp"); // SMS roteia p/ WhatsApp (Stevo)
    else if (c === "Instagram") set.add("instagram");
  }
  return [...set];
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
    const entitled = included || (cap ? activeCaps.has(cap) : false);

    let status: AgentStatus;
    if (!included && !entitled) status = "blocked";
    else status = a.status === "active" ? "active" : "paused";

    const channels = included ? (["whatsapp"] as ChannelKey[]) : channelsByAgent.get(a.id) || ["whatsapp"];

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
}

export async function loadHubMetrics(locationId: string): Promise<HubMetrics> {
  const supabase = createAdminClient();
  const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const [messagesRes, qualifiedRes, bookedRes, activeRes] = await Promise.all([
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
  ]);

  return {
    messagesSent30d: messagesRes.count || 0,
    leadsQualified: qualifiedRes.count || 0,
    appointmentsBooked: bookedRes.count || 0,
    activeConversations: activeRes.count || 0,
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

export async function loadHubActivity(locationId: string, limit = 40): Promise<HubActivityItem[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("execution_log")
    .select("id, action_type, contact_id, created_at, success")
    .eq("location_id", locationId)
    .neq("action_type", "ai_processing") // rúido interno
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data || []).map((r): HubActivityItem => {
    const map = ACTION_MAP[r.action_type as string] || { type: "msg" as const, label: String(r.action_type) };
    const d = new Date(r.created_at as string);
    const t = isNaN(d.getTime())
      ? ""
      : new Intl.DateTimeFormat("pt-BR", { hour: "2-digit", minute: "2-digit" }).format(d);
    return {
      t,
      text: map.label + (r.success === false ? " (falhou)" : ""),
      agent: "Agente",
      channel: "Spark Leads",
      type: map.type,
    };
  });
}

/* ─── Detalhe de 1 agente (header + config + módulos ligados) ────── */
export interface HubAgentModuleRow {
  key: string;
  category: string;
  name: string;
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
    ? (["whatsapp"] as ChannelKey[])
    : mapChannels(cfg?.enabled_channels) || ["whatsapp"];

  const catalogByKey = new Map(catalog.map((m) => [m.key, m]));
  const modules: HubAgentModuleRow[] = instances.map((inst) => {
    const cat = catalogByKey.get(inst.module_key);
    return {
      key: inst.module_key,
      category: (cat?.category as string) || inst.module_key,
      name: cat?.name || inst.module_key,
    };
  });

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
