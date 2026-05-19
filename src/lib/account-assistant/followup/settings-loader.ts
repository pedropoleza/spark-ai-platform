/**
 * Carrega configurações de follow-up do agent_configs (Pedro 2026-05-18).
 *
 * Defaults sensatos quando agent não tem config explícita.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { FollowupSettings, ApprovalMode } from "./types";

const DEFAULTS: FollowupSettings = {
  feature_enabled: true,
  approval_mode: "adaptive",
  default_sequence_length: 2,
  max_sequence_length: 3,
  default_interval_hours: 48,
  max_messages_without_response: 2,
  allow_conversation_context: true,
  allowed_channels: ["whatsapp_web_sms"],
  stage_triggers: null,
};

export async function loadFollowupSettings(
  agentId: string | null,
): Promise<FollowupSettings> {
  if (!agentId) return DEFAULTS;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("agent_configs")
    .select(
      "followup_feature_enabled, followup_approval_mode, followup_default_sequence_length, followup_max_sequence_length, followup_default_interval_hours, followup_max_messages_without_response, followup_allow_conversation_context, followup_allowed_channels, followup_stage_triggers",
    )
    .eq("agent_id", agentId)
    .maybeSingle();

  if (error || !data) {
    console.warn(
      `[followup-settings] sem config pro agent ${agentId} — usando defaults`,
    );
    return DEFAULTS;
  }

  return {
    feature_enabled: data.followup_feature_enabled ?? DEFAULTS.feature_enabled,
    approval_mode:
      (data.followup_approval_mode as ApprovalMode) ?? DEFAULTS.approval_mode,
    default_sequence_length:
      data.followup_default_sequence_length ?? DEFAULTS.default_sequence_length,
    max_sequence_length:
      data.followup_max_sequence_length ?? DEFAULTS.max_sequence_length,
    default_interval_hours:
      data.followup_default_interval_hours ?? DEFAULTS.default_interval_hours,
    max_messages_without_response:
      data.followup_max_messages_without_response ??
      DEFAULTS.max_messages_without_response,
    allow_conversation_context:
      data.followup_allow_conversation_context ??
      DEFAULTS.allow_conversation_context,
    allowed_channels: Array.isArray(data.followup_allowed_channels)
      ? (data.followup_allowed_channels as string[])
      : DEFAULTS.allowed_channels,
    stage_triggers:
      (data.followup_stage_triggers as Record<string, unknown> | null) ?? null,
  };
}

export { DEFAULTS as DEFAULT_FOLLOWUP_SETTINGS };
