/**
 * H116: reuniões do lead no histórico do prompt (caso Ricardo, Alves Cury 02/11/2026).
 * Rodar: npx tsx scripts/test-h116-reunioes.ts
 */
import { buildLeadHistorySection } from "@/lib/ai/sales-prompt-builder";
import { normalizeCrmStartTime } from "@/lib/ai/slot-guard";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra).slice(0, 500) : ""); }
};
const ET = "America/New_York";
const agora = Date.now();
const futura = new Date(agora + 4 * 3600_000).toISOString();
const passada = new Date(agora - 30 * 3600_000).toISOString();
const hist = (reunioes: Array<{ inicioIso: string; titulo?: string }>) => ({
  contact: { id: "c", name: "Ricardo", tags: [], customFields: [] },
  recent_messages: [], notes: [], opportunities: [],
  last_human_outbound_at: null, last_inbound_at: null, has_closed_opp: false, fetch_ms: 1,
  reunioes,
});
const base = { config: {} as never, contactName: "Ricardo", collectedData: {}, locationName: "Alves", currentDate: "x", timezone: ET };

console.log("\n1) Reunião futura e passada no histórico");
{
  const sec = buildLeadHistorySection({ ...base, leadHistory: hist([{ inicioIso: passada, titulo: "Zoom antigo" }, { inicioIso: futura, titulo: "Ricardo - planejamento de aposentadoria" }]) } as never);
  ok("seção aparece só com reunião", sec.includes("Reuniões deste lead no calendário"), sec);
  ok("futura com 'daqui a 4 horas'", /FUTURA, daqui a 4 horas: Ricardo - planejamento de aposentadoria/.test(sec), sec);
  ok("passada com 'há 30 horas'", /PASSADA, há 30 horas: Zoom antigo/.test(sec), sec);
  ok("regra de não oferecer outra", sec.includes("não ofereça outra e não pergunte se ele participou"));
  ok("sem reunião: sem seção", buildLeadHistorySection({ ...base, leadHistory: hist([]) } as never) === "");
}

console.log("\n2) Horário do CRM sem offset vira instante certo no fuso da conta");
{
  const iso = normalizeCrmStartTime("2026-11-02 20:00:00", ET);
  ok("2026-11-02 20:00 ET = 2026-11-03T01:00Z", new Date(iso).toISOString() === "2026-11-03T01:00:00.000Z", iso);
}

console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
