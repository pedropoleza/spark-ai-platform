/**
 * Seed das regras pré-configuradas (system rules) num agent Sparkbot.
 *
 * Idempotente: se a regra já existe (matched por name + agent_id + source='system'),
 * pula. Se não existe, cria. Não toca em regras 'custom' criadas pelo admin.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { SYSTEM_RULES } from "./system-rules";

export interface SeedResult {
  agent_id: string;
  inserted: number;
  skipped: number;
  total_system_rules: number;
}

export async function seedSystemRules(agentId: string): Promise<SeedResult> {
  const supabase = createAdminClient();

  // Lê regras system existentes pra esse agent
  const { data: existing } = await supabase
    .from("assistant_proactive_rules")
    .select("name")
    .eq("agent_id", agentId)
    .eq("source", "system");

  const existingNames = new Set((existing || []).map((r) => r.name));

  let inserted = 0;
  let skipped = 0;

  for (const seed of SYSTEM_RULES) {
    if (existingNames.has(seed.name)) {
      skipped++;
      continue;
    }
    const { error } = await supabase.from("assistant_proactive_rules").insert({
      agent_id: agentId,
      rule_type: seed.rule_type,
      name: seed.name,
      description: seed.description,
      enabled: true,
      trigger_config: seed.trigger_config,
      prompt_instruction: seed.prompt_instruction,
      tools_allowed: seed.tools_allowed,
      cooldown_minutes: seed.cooldown_minutes,
      ai_model: seed.ai_model || "claude-haiku-4-5-20251001",
      source: "system",
    });
    if (error) {
      console.error(`[seed] failed to insert "${seed.name}":`, error.message);
    } else {
      inserted++;
    }
  }

  return {
    agent_id: agentId,
    inserted,
    skipped,
    total_system_rules: SYSTEM_RULES.length,
  };
}
