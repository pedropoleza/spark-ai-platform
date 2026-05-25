/**
 * View-models do /hub (camada de UI). Mapeados a partir das APIs reais
 * (catalog/agents/activity) na Fase B. Mantidos finos de propósito.
 */
import type { AgentAudience } from "@/types/agent-platform";

export type AgentStatus = "active" | "paused" | "blocked";
export type ChannelKey = "whatsapp" | "instagram";

/** Agente como a UI do hub consome. */
export interface HubAgentView {
  id: string;
  name: string;
  template_key: string; // sparkbot | sales | recruitment | custom
  audience: AgentAudience;
  status: AgentStatus;
  channels: ChannelKey[];
  included: boolean; // SparkBot → incluso (sem cobrança)
  entitled: boolean; // lead-facing liberado p/ a location?
  since?: string;
  expires_at?: string | null;
  stats?: { msgs24h?: number; responseRate?: number };
}

/** Item do feed de atividade. */
export interface HubActivityItem {
  t: string; // hora "14:02"
  text: string;
  agent: string;
  channel: string;
  type: "qualified" | "scheduled" | "task" | "note" | "msg";
}
