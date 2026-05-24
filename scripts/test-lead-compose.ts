// Teste da COMPOSIÇÃO lead-facing a partir de módulos (Plataforma Modular, Fase 2).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-lead-compose.ts
//
// Prova que um agente CUSTOM monta o prompt a partir do subset/ordem de módulos
// que ligou: cada módulo escolhido entra (na ordem), os não-escolhidos ficam de
// fora, e a instrução-meta sempre abre. (Não há paridade aqui — custom = novo.)

import {
  LEAD_MODULE_FRAGMENTS,
  buildLeadMetaInstruction,
  leadModuleKeys,
  type PromptContext,
} from "@/lib/ai/sales-prompt-builder";
import { assembleLeadFromModules } from "@/lib/agent-platform/assembler";
import type { AgentConfig } from "@/types/agent";

const ctx: PromptContext = {
  config: {
    objective: "qualification_and_booking",
    data_fields: [{ key: "full_name", label: "Nome", required: true }],
    tone_creativity: 50,
    tone_formality: 50,
    tone_naturalness: 60,
    tone_aggressiveness: 30,
  } as unknown as AgentConfig,
  agentType: "sales_agent",
  contactName: "Maria Teste",
  collectedData: {},
  locationName: "Brazillionaires",
  currentDate: "segunda, 14:00",
  timezone: "America/New_York",
};

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

const meta = buildLeadMetaInstruction();
const behaviorFrag = LEAD_MODULE_FRAGMENTS.behavior(ctx);
const qualFrag = LEAD_MODULE_FRAGMENTS.qualification(ctx);
const schedFrag = LEAD_MODULE_FRAGMENTS.scheduling(ctx);

// meta sempre abre
const subset = assembleLeadFromModules(["behavior", "qualification"], ctx);
check("meta abre o prompt", subset.startsWith(meta));
check("módulo escolhido (behavior) entra", subset.includes(behaviorFrag));
check("módulo escolhido (qualification) entra", subset.includes(qualFrag));
check("módulo NÃO escolhido (scheduling) fica de fora", !subset.includes(schedFrag) && schedFrag.length > 0);

// ordem preservada (behavior antes de qualification, como pedido)
check(
  "ordem dos módulos preservada",
  subset.indexOf(behaviorFrag) < subset.indexOf(qualFrag),
);

// ordem inversa também respeitada
const inverse = assembleLeadFromModules(["qualification", "behavior"], ctx);
check("ordem inversa respeitada", inverse.indexOf(qualFrag) < inverse.indexOf(behaviorFrag));

// full > subset
const full = assembleLeadFromModules(leadModuleKeys(), ctx);
check("full tem mais conteúdo que subset", full.length > subset.length);

// lista vazia → só meta
check("sem módulos → só a meta", assembleLeadFromModules([], ctx) === meta);

// módulo inexistente é ignorado (não quebra)
check(
  "módulo desconhecido ignorado",
  assembleLeadFromModules(["behavior", "modulo_que_nao_existe"], ctx).includes(behaviorFrag),
);

console.log(`\nTOTAL: ${pass}/${pass + fail} passaram${fail > 0 ? ` — ${fail} FALHARAM` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
