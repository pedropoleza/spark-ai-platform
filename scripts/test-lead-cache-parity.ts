// Teste da otimização de CACHE lead-facing (2026-07). Roda:
//   npx tsx -r tsconfig-paths/register scripts/test-lead-cache-parity.ts
//
// Prova 3 propriedades da Fase 1 (reposicionar o volátil pro runtime):
//   A) Flag OFF = comportamento de hoje (lead history + carrier RAG no system).
//   B) Flag ON = system BYTE-ESTÁVEL mesmo mudando o volátil (o buster foi-se).
//   C) Nada se perde: o conteúdo movido pro runtime é o MESMO (só troca de lugar).
//
// Não chama LLM nem banco — puro determinístico sobre os builders.

import { buildSystemPrompt, buildRuntimeContext, type PromptContext, type KnowledgeBaseItem } from "@/lib/ai/sales-prompt-builder";
import type { AgentConfig } from "@/types/agent";

const CARRIER = "CARRIER_CHUNK_MARKER_zzz";
const HIST = "HIST_MSG_MARKER_zzz";

function cfg(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    objective: "qualification_and_booking",
    data_fields: [{ key: "nome", label: "Nome", type: "text", required: true }],
    tone_creativity: 50, tone_formality: 50, tone_naturalness: 50, tone_aggressiveness: 50,
    ...overrides,
  } as unknown as AgentConfig;
}

// LeadContext mínimo (só o que buildLeadHistorySection lê). Cast p/ evitar fricção de tipo.
function leadHistory(msg: string): PromptContext["leadHistory"] {
  return {
    contact: { tags: ["cliente-vip"] },
    opportunities: [],
    notes: [],
    recent_messages: [{ body: msg, dateAdded: "2026-06-01T10:00:00Z", direction: "inbound" }],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

function baseCtx(over: Partial<PromptContext> = {}): PromptContext {
  return {
    config: cfg(),
    agentType: "sales_agent",
    contactName: "Maria Teste",
    collectedData: {},
    locationName: "Brazillionaires",
    currentDate: "segunda, 14:00",
    timezone: "America/New_York",
    ...over,
  };
}

const carrierItem: KnowledgeBaseItem = { title: "Carrier X", type: "text", content: CARRIER };

let pass = 0, fail = 0;
const ok = (name: string, cond: boolean) => { if (cond) { pass++; console.log(`✅ ${name}`); } else { fail++; console.log(`❌ ${name}`); } };

// ---- A) Flag OFF = comportamento de hoje (volátil NO system) ----
const off = baseCtx({ cacheOptimized: false, knowledgeBase: [carrierItem], leadHistory: leadHistory(HIST) });
const sysOff = buildSystemPrompt(off);
const rtOff = buildRuntimeContext(off);
ok("A1: OFF — lead history fica no SYSTEM", sysOff.includes(HIST));
ok("A2: OFF — carrier (na KB) fica no SYSTEM", sysOff.includes(CARRIER));
ok("A3: OFF — runtime NÃO tem o volátil movido", !rtOff.includes(HIST) && !rtOff.includes(CARRIER));

// ---- B) Flag ON = SYSTEM byte-estável mesmo variando o volátil ----
const on1 = baseCtx({
  cacheOptimized: true, knowledgeBase: [], retrievedKnowledge: [{ title: "Carrier A", type: "text", content: "CHUNK_A" }],
  leadHistory: leadHistory("HIST_A"), currentDate: "segunda, 14:00", collectedData: {},
});
const on2 = baseCtx({
  cacheOptimized: true, knowledgeBase: [], retrievedKnowledge: [{ title: "Carrier B", type: "text", content: "CHUNK_B" }],
  leadHistory: leadHistory("HIST_B"), currentDate: "terça, 09:30", collectedData: { nome: "João" },
});
const sysOn1 = buildSystemPrompt(on1);
const sysOn2 = buildSystemPrompt(on2);
ok("B1: ON — SYSTEM idêntico apesar de carrier/hist/data/hora diferentes (buster eliminado)", sysOn1 === sysOn2);
ok("B2: ON — SYSTEM não contém o carrier por-mensagem", !sysOn1.includes("CHUNK_A") && !sysOn1.includes("CHUNK_B"));
ok("B3: ON — SYSTEM não contém o lead history", !sysOn1.includes("HIST_A") && !sysOn1.includes("HIST_B"));
const rtOn1 = buildRuntimeContext(on1);
const rtOn2 = buildRuntimeContext(on2);
ok("B4: ON — RUNTIME carrega o volátil (difere entre turnos)", rtOn1 !== rtOn2 && rtOn1.includes("CHUNK_A") && rtOn1.includes("HIST_A"));

// ---- C) Nada se perde: conteúdo movido, não sumido ----
const onC = baseCtx({ cacheOptimized: true, knowledgeBase: [], retrievedKnowledge: [carrierItem], leadHistory: leadHistory(HIST) });
const allOff = sysOff + "\n" + rtOff;
const allOn = buildSystemPrompt(onC) + "\n" + buildRuntimeContext(onC);
ok("C1: OFF continha carrier + hist (baseline)", allOff.includes(CARRIER) && allOff.includes(HIST));
ok("C2: ON PRESERVA carrier + hist (só mudou de lugar)", allOn.includes(CARRIER) && allOn.includes(HIST));
ok("C3: ON — carrier + hist saíram do system e foram pro runtime", !buildSystemPrompt(onC).includes(CARRIER) && buildRuntimeContext(onC).includes(CARRIER) && buildRuntimeContext(onC).includes(HIST));

console.log(`\nTOTAL: ${pass}/${pass + fail} ok${fail > 0 ? ` — ${fail} FALHOU` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
