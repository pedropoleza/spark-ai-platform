/**
 * H112: agenda travada por etiqueta (regra do vídeo de 70% da Alves Cury).
 * Rodar: npx tsx scripts/test-booking-tag-gate.ts
 */
import { agendaLiberadaPorEtiqueta, etiquetasDoContato, lerTravaDeAgenda } from "@/lib/queue/booking-tag-gate";
import { buildRuntimeContext } from "@/lib/ai/sales-prompt-builder";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✅ ${nome}`); } else { fail++; console.log(`  ❌ ${nome}`); } };
const GATE = { requires_any: ["lp carreira - 70%", "lp carreira - video completo"], except_any: ["interesse-seguro"] };

console.log("\n1) Veredito");
ok("sem config: liberada (frota igual)", agendaLiberadaPorEtiqueta(null, []).liberada && agendaLiberadaPorEtiqueta({}, []).motivo === "sem_trava");
ok("config sem requires_any: sem trava", lerTravaDeAgenda({ requires_any: [], except_any: ["x"] }) === null);
ok("lead sem nada: travada", !agendaLiberadaPorEtiqueta(GATE, ["ads_recruit", "lp carreira - saudacao"]).liberada);
ok("começou e parou (5 min): travada", !agendaLiberadaPorEtiqueta(GATE, ["lp carreira", "lp carreira - 5 min"]).liberada);
ok("70%: liberada", agendaLiberadaPorEtiqueta(GATE, ["lp carreira - 70%"]).motivo === "tem_requisito");
ok("vídeo completo sem o 70% (lead antigo): liberada", agendaLiberadaPorEtiqueta(GATE, ["lp carreira - video completo"]).liberada);
ok("virada para cliente (interesse-seguro): liberada", agendaLiberadaPorEtiqueta(GATE, ["interesse-seguro"]).motivo === "tem_excecao");
ok("não leu as etiquetas: liberada (fail-open)", agendaLiberadaPorEtiqueta(GATE, null).motivo === "etiquetas_ilegiveis");
ok("caixa e espaço não decidem", agendaLiberadaPorEtiqueta(GATE, ["  LP Carreira - 70% "]).liberada);
ok("etiqueta parecida não vale", !agendaLiberadaPorEtiqueta(GATE, ["lp carreira - 70"]).liberada);

console.log("\n2) Formato das etiquetas do GET /contacts");
ok("string e {name}", JSON.stringify(etiquetasDoContato({ tags: ["a", { name: "b" }, { name: "" }] })) === '["a","b"]');
ok("contato sem tags: lista vazia", JSON.stringify(etiquetasDoContato({})) === "[]");
ok("sem contato: null (ilegível)", etiquetasDoContato(null) === null);

console.log("\n3) Runtime: travada esconde os horários");
const ctx = {
  config: { objective: "schedule_meeting", data_fields: [], personality: { name: "Bruno" } },
  agentType: "recruitment_agent", contactName: "Juan", collectedData: {}, locationName: "Alves Cury Financial",
  currentDate: "terça, 03/11/2026, 18:00", timezone: "America/New_York",
  availableSlots: "Thursday, November 5: 3:00 PM, 7:00 PM", slotsUnavailable: false, priorTurnCount: 3,
} as unknown as Parameters<typeof buildRuntimeContext>[0];
const livre = buildRuntimeContext(ctx);
const travada = buildRuntimeContext({ ...ctx, agendaTravada: true });
ok("liberada: mostra os horários", livre.includes("HORÁRIOS DISPONÍVEIS") && livre.includes("3:00 PM"));
ok("travada: aviso no lugar", travada.includes("AGENDA AINDA NÃO LIBERADA"));
ok("travada: nenhum horário no runtime", !travada.includes("HORÁRIOS DISPONÍVEIS") && !travada.includes("3:00 PM"));
ok("travada: proíbe book_appointment", /NÃO inclua action book_appointment/.test(travada));

console.log(`\n${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
