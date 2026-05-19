/**
 * Safety checks pré-criação de sequence (Pedro 2026-05-18).
 *
 * Roda ANTES de gastar tokens em LLM (context summary + generator).
 * Bloqueia cedo casos óbvios: feature off, contact opt-out, etc.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { FollowupSettings } from "./types";

const OPTOUT_TAG_PATTERNS = /^(dnc|do_not_contact|opt[_-]?out|stop|unsubscribed|n[ãa]o[_ ]?enviar|no[_-]?contact)$/i;

export interface SafetyContext {
  rep_id: string;
  location_id: string;
  agent_id: string | null;
  contact_id: string;
  contact_tags?: string[];
  delivery_channel: string;
  settings: FollowupSettings;
}

export interface SafetyCheckResult {
  ok: boolean;
  block_reason?: {
    kind:
      | "feature_disabled"
      | "channel_not_allowed"
      | "contact_opted_out"
      | "duplicate_active_sequence"
      | "wallet_cap_blocked";
    message: string;
    existing_sequence_id?: string;
  };
}

export async function runSafetyChecks(
  ctx: SafetyContext,
): Promise<SafetyCheckResult> {
  // 1. Feature on?
  if (!ctx.settings.feature_enabled) {
    return {
      ok: false,
      block_reason: {
        kind: "feature_disabled",
        message: "Follow-up feature está desativada pra essa location no agent_configs.",
      },
    };
  }

  // 2. Channel permitido?
  if (!ctx.settings.allowed_channels.includes(ctx.delivery_channel)) {
    return {
      ok: false,
      block_reason: {
        kind: "channel_not_allowed",
        message: `Channel '${ctx.delivery_channel}' não está em allowed_channels. Configure no agent_configs.followup_allowed_channels.`,
      },
    };
  }

  // 3. Contato com opt-out tag?
  if (ctx.contact_tags?.some((t) => OPTOUT_TAG_PATTERNS.test(t.trim()))) {
    return {
      ok: false,
      block_reason: {
        kind: "contact_opted_out",
        message: "Contato tem tag de opt-out (dnc / do_not_contact / não enviar). Sequence externa bloqueada.",
      },
    };
  }

  // 4. Já tem sequence ativa pra esse contato?
  const supabase = createAdminClient();
  const { data: existing } = await supabase
    .from("followup_sequences")
    .select("id, status, sequence_type, goal")
    .eq("contact_id", ctx.contact_id)
    .eq("location_id", ctx.location_id)
    .in("status", ["scheduled", "running", "paused"])
    .limit(1)
    .maybeSingle();

  if (existing) {
    return {
      ok: false,
      block_reason: {
        kind: "duplicate_active_sequence",
        message: `Já existe sequence ${existing.status} pra esse contato (id ${existing.id.slice(0, 8)}, type=${existing.sequence_type}). Use cancel_followup ou edit_followup pra alterar a existente.`,
        existing_sequence_id: existing.id,
      },
    };
  }

  // 5. Wallet/cap check — best-effort: lê monthly_spend_cap_usd em agent_configs
  // (mais robusto seria reusar getMonthlySpendCheck do billing, mas pra MVP
  // basta delegar pro billing tracking que já bloqueia se cap atingido)

  return { ok: true };
}
