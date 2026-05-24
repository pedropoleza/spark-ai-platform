// Teste de PARIDADE do motor unificado pro LEAD-FACING (venda/recrutamento).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-sales-parity.ts
//
// Garante que montar o prompt de venda/recrut pelo ASSEMBLER é IDÊNTICO ao
// builder legado (buildSystemPrompt do sales-prompt-builder). Enquanto delega
// (Fase 2) é trivial — mas vira o guard rail pra qualquer decomposição futura.

import { buildSystemPrompt, type PromptContext } from "@/lib/ai/sales-prompt-builder";
import { assembleSystemPrompt, templateKeyForAgentType } from "@/lib/agent-platform/assembler";
import type { AgentConfig } from "@/types/agent";

function cfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    objective: "qualification_and_booking",
    data_fields: [],
    tone_creativity: 50,
    tone_formality: 50,
    tone_naturalness: 50,
    tone_aggressiveness: 50,
    ...overrides,
  } as unknown as AgentConfig;
}

function ctx(agentType: "sales_agent" | "recruitment_agent", config: AgentConfig): PromptContext {
  return {
    config,
    agentType,
    contactName: "Maria Teste",
    collectedData: {},
    locationName: "Brazillionaires",
    currentDate: "segunda, 14:00",
    timezone: "America/New_York",
  };
}

const variants: Array<{ name: string; agentType: "sales_agent" | "recruitment_agent"; config: AgentConfig }> = [
  { name: "sales default", agentType: "sales_agent", config: cfg() },
  { name: "recruitment default", agentType: "recruitment_agent", config: cfg() },
  { name: "sales c/ override", agentType: "sales_agent", config: cfg({ system_prompt_override: "Seja super direto." } as Partial<AgentConfig>) },
  { name: "sales booking_only", agentType: "sales_agent", config: cfg({ objective: "booking_only" } as Partial<AgentConfig>) },
  { name: "sales custom instructions", agentType: "sales_agent", config: cfg({ custom_instructions: "Mencione o webinar de quinta." } as Partial<AgentConfig>) },
];

let pass = 0;
let fail = 0;
for (const v of variants) {
  const c = ctx(v.agentType, v.config);
  const legacy = buildSystemPrompt(c);
  const viaMotor = assembleSystemPrompt({
    templateKey: templateKeyForAgentType(v.agentType),
    audience: "lead",
    leadArgs: c,
  });
  if (legacy === viaMotor) {
    pass++;
    console.log(`✅ paridade: ${v.name}  (${legacy.length} chars)`);
  } else {
    fail++;
    let i = 0;
    while (i < Math.min(legacy.length, viaMotor.length) && legacy[i] === viaMotor[i]) i++;
    console.log(`❌ DRIFT: ${v.name} — diverge no char ${i}`);
    console.log(`   legacy: …${JSON.stringify(legacy.slice(Math.max(0, i - 25), i + 25))}`);
    console.log(`   motor : …${JSON.stringify(viaMotor.slice(Math.max(0, i - 25), i + 25))}`);
  }
}

console.log(`\nTOTAL: ${pass}/${variants.length} idênticos${fail > 0 ? ` — ${fail} COM DRIFT` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
