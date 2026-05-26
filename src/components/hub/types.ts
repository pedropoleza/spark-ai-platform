/**
 * View-models do /hub (camada de UI). Mapeados a partir das APIs reais
 * (catalog/agents/activity) na Fase B. Mantidos finos de propósito.
 */
import type { AgentAudience } from "@/types/agent-platform";

export type AgentStatus = "active" | "paused" | "blocked";

/**
 * Canais (Pedro 2026-05-26): 3 tipos. O "SMS" do GHL é o WhatsApp Web via Stevo
 * (SMS custom provider) — não é SMS de verdade. WhatsApp (GHL) = WhatsApp API/Meta.
 *  - whatsapp_web → DB "SMS"  (Stevo / WhatsApp Web)
 *  - whatsapp_api → DB "WhatsApp" (Meta API)
 *  - instagram    → DB "Instagram"
 */
export type ChannelKey = "whatsapp_web" | "whatsapp_api" | "instagram";

export const CHANNEL_DB_TO_UI: Record<string, ChannelKey> = {
  SMS: "whatsapp_web",
  WhatsApp: "whatsapp_api",
  Instagram: "instagram",
  // Legados/variações de casing (evita perder canal no round-trip do editor).
  sms: "whatsapp_web",
  whatsapp: "whatsapp_web", // legacy lowercase = WhatsApp Web (Stevo)
  instagram: "instagram",
};
/** Canais do DB que o /hub NÃO representa nos 3 tipos (ex: "Email") — preservados no save. */
export function nonUiChannels(enabled?: (string | null)[] | null): string[] {
  return (enabled || []).filter((c): c is string => !!c && !CHANNEL_DB_TO_UI[c]);
}
export const CHANNEL_UI_TO_DB: Record<ChannelKey, string> = {
  whatsapp_web: "SMS",
  whatsapp_api: "WhatsApp",
  instagram: "Instagram",
};
export const CHANNEL_LABEL: Record<ChannelKey, string> = {
  whatsapp_web: "WhatsApp Web/SMS",
  whatsapp_api: "WhatsApp API",
  instagram: "Instagram",
};

export function channelsFromDb(enabled?: (string | null)[] | null): ChannelKey[] {
  const set = new Set<ChannelKey>();
  for (const c of enabled || []) {
    const k = c ? CHANNEL_DB_TO_UI[c] : undefined;
    if (k) set.add(k);
  }
  return [...set];
}
export function channelsToDb(keys: ChannelKey[]): string[] {
  return keys.map((k) => CHANNEL_UI_TO_DB[k]).filter(Boolean);
}

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
