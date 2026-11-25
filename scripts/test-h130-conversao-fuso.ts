/**
 * H130: "X no seu horário (Y ET)" conferido pelo código (chamado 548, Alves Cury,
 * 23/11/2026). Textos reais da frota, sem nome de lead.
 * Rodar: npx tsx scripts/test-h130-conversao-fuso.ts
 */
import { conferirConversaoDeFuso, noEstiloDe } from "@/lib/queue/conversao-fuso-guard";
import { aplicarGuardasDeAgenda } from "@/lib/queue/agenda-guard";
import { fusoNaFalaDoLead, horarioCitadoComFuso } from "@/lib/queue/lead-timezone";
import type { AIResponse } from "@/types/ai";

let pass = 0, fail = 0;
const eq = (nome: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}\n     veio:   ${JSON.stringify(got)}\n     queria: ${JSON.stringify(want)}`); }
};
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const ET = "America/New_York", CT = "America/Chicago", MT = "America/Denver", PT = "America/Los_Angeles", HI = "Pacific/Honolulu", AZ = "America/Phoenix";
const NOV23 = new Date("2026-11-23T17:11:00Z"); // 12:11 ET, o turno do caso
const dia = (d: string, hs: string[], off = "-05:00") => hs.map((h) => `${d}T${h}:00${off}`);
const H = ["09:30", "10:00", "10:30", "11:00", "12:00", "13:00", "14:00", "15:00", "16:00", "17:00", "18:00", "19:00", "20:00", "21:00"];
const SLOTS = [...dia("2026-11-24", H), ...dia("2026-11-25", H), ...dia("2026-11-27", ["09:30", "10:00", "10:30", "11:00", "13:00", "14:00", "14:30", "15:00", "15:30", "16:00"])];
const c = (t: string, fusoLead: string | null, o: { agora?: Date; slots?: string[]; lista?: string } = {}) =>
  conferirConversaoDeFuso([t], { fusoLista: o.lista ?? ET, fusoLead, slotsIso: o.slots ?? SLOTS, agora: o.agora ?? NOV23 });
const t = (nome: string, texto: string, fusoLead: string | null, queria: string, o: Parameters<typeof c>[2] = {}) => eq(nome, c(texto, fusoLead, o).messages[0], queria);
const intacto = (nome: string, texto: string, fusoLead: string | null, o: Parameters<typeof c>[2] = {}) => {
  const r = c(texto, fusoLead, o); ok(`intacto: ${nome}`, r.messages[0] === texto && r.correcoes.length === 0, r);
};

console.log("\n1) O que saiu errado em produção");
t("Utah (MT, 2 h): caso do chamado, 23/11",
  "Sexta tem sim! Tenho às 9h30 da manhã ou às 2 da tarde no seu horário (10:30 AM ET ou 3 PM ET).", MT,
  "Sexta tem sim! Tenho às 8h30 da manhã ou às 1 da tarde no seu horário (10:30 AM ET ou 3 PM ET).");
t("Utah, 18/11: um par errado e um certo na mesma mensagem",
  "Tem quarta, 18/11, às 7 da noite no seu horário (8 PM ET) ou quinta, 19/11, às 2 da tarde no seu horário (4 PM ET). Qual fica melhor?", MT,
  "Tem quarta, 18/11, às 6 da noite no seu horário (8 PM ET) ou quinta, 19/11, às 2 da tarde no seu horário (4 PM ET). Qual fica melhor?",
  { agora: new Date("2026-11-18T06:16:00Z"), slots: [...dia("2026-11-18", H), ...dia("2026-11-19", H)] });
t("Havaí, 05/11: o 1º do par era 4 PM ET = 11 da manhã",
  "Hoje (quinta, 05/11): 1 da tarde ou 2 da tarde no seu horário do Havaí (4:00 PM ou 7:00 PM ET)", HI,
  "Hoje (quinta, 05/11): 11 da manhã ou 2 da tarde no seu horário do Havaí (4:00 PM ou 7:00 PM ET)",
  { agora: new Date("2026-11-05T17:41:00Z"), slots: dia("2026-11-05", H) });

console.log("\n2) O que saiu certo em produção não muda");
intacto("CT", "Tem segunda, 09/11, às 4 da tarde no seu horário (5 PM ET) ou terça, 10/11, às 7 da noite no seu horário (8 PM ET). Qual fica melhor?", CT, { agora: new Date("2026-11-08T18:42:00Z") });
intacto("PT, AM/PM", "Tenho quarta-feira, 04/11, às 2:00 PM no seu horário (5:00 PM ET) ou amanhã, quinta, às 10:00 AM no seu horário (1:00 PM ET). Qual funciona melhor?", PT, { agora: new Date("2026-11-04T16:22:00Z") });
intacto("Havaí", "Tenho segunda-feira, 16/11, às 2 da tarde no seu horário (7 PM ET) ou terça-feira, 17/11, às 8 da manhã no seu horário (1 PM ET).", HI, { agora: new Date("2026-11-16T21:12:00Z") });
intacto("meio-dia", "quinta (19/11) às 10 da manhã no seu horário (11:00 AM ET) ou sexta (20/11) ao meio-dia no seu horário (1:00 PM ET).", CT, { agora: new Date("2026-11-18T22:36:00Z") });
intacto("confirmação", "Fechado: sexta-feira, 27/11, às 1 da tarde no seu horário (3 PM ET). A confirmação chega por aqui 😊", MT);
intacto("rótulo do fuso no lugar de 'seu horário'", "Confirmo: sexta-feira, 27/11, às 1 da tarde CT (2 PM ET).", CT);
intacto("ET na frente", "Perfeito, 8pm ET (5pm no seu horário). Te espero!", PT);
intacto("ET na frente com estado", "a próxima sexta é 28/08 às 8pm ET (7pm Texas) 🙌", CT, { agora: new Date("2026-08-26T16:00:00Z") });
intacto("'que seria'", "A próxima quinta seria às 8pm ET (que seria 5pm no seu horário da Califórnia)", PT);
intacto("'ET = no seu horário'", "Então 8pm ET = 5pm no seu horário de Las Vegas 🙂", PT);
intacto("só um relógio", "Tem quinta, 26/11, às 5 da tarde ou sexta, 27/11, às 2 da tarde (horário do leste). Qual fica melhor?", null);
intacto("mesma hora duas vezes, sem rótulo", "Fechado: terça às 5 (17h ET).", MT);
intacto("parêntese que não é hora", "Tem terça (24/11) às 7 da noite no seu horário, pode ser?", MT);
intacto("sem agenda no turno, par certo", "Sexta às 1 da tarde no seu horário (3 PM ET).", MT, { slots: [] });

intacto("rótulo da hora de fora escrito dentro do parêntese", "um horário na segunda, dia 23, às 11 AM (horário do Texas, seria 12 PM ET).", null);

intacto("horário do Brasil certo", "Fechado: terça às 5 da tarde no horário do Brasil (3 PM ET).", ET);
intacto("lugar que não sabemos ler: não mexe", "Seria às 8 da noite no horário de Portugal (3 PM ET).", ET);

console.log("\n3) Qual das duas horas vale");
t("a da conta existe na agenda: corrige a do lead", "Tenho sexta às 2 da tarde no seu horário (3 PM ET).", MT, "Tenho sexta às 1 da tarde no seu horário (3 PM ET).");
t("a da conta não existe e a do lead sim: corrige a da conta", "Tenho sexta às 1 da tarde no seu horário (5 PM ET).", MT, "Tenho sexta às 1 da tarde no seu horário (3 PM ET).");
t("nenhuma existe: o par fica coerente e o guarda de oferta decide", "Tenho sexta às 7 da noite no seu horário (8 PM ET).", MT, "Tenho sexta às 6 da noite no seu horário (8 PM ET).");
t("sem lista de horários: vale a da conta", "Tenho sexta às 2 da tarde no seu horário (3 PM ET).", MT, "Tenho sexta às 1 da tarde no seu horário (3 PM ET).", { slots: [] });
t("ET na frente: corrige a do lead", "Perfeito, 8pm ET (6pm no seu horário).", PT, "Perfeito, 8pm ET (5pm no seu horário).");
t("'=': corrige a do lead", "Então 8pm ET = 6pm no seu horário de Las Vegas 🙂", PT, "Então 8pm ET = 5pm no seu horário de Las Vegas 🙂");
t("fuso dito no texto vale mais que o cadastro", "Confirmo: sexta às 2 da tarde CT (2 PM ET).", null, "Confirmo: sexta às 1 da tarde CT (2 PM ET).");
t("conta em outro fuso", "Tem terça, 24/11, às 5 da tarde no seu horário (3 PM CT).", ET, "Tem terça, 24/11, às 4 da tarde no seu horário (3 PM CT).", { lista: CT, slots: dia("2026-11-24", H, "-06:00") });
t("Arizona não muda no verão (3 h do ET em julho)", "Tenho terça às 2 da tarde no seu horário (4 PM ET).", AZ, "Tenho terça às 1 da tarde no seu horário (4 PM ET).", { agora: new Date("2026-07-20T16:00:00Z"), slots: dia("2026-07-21", H, "-04:00") });
t("a diferença é a do dia da reunião: depois da virada, Arizona fica a 2 h", "Tenho terça, 03/11, às 1 da tarde no seu horário (4 PM ET).", AZ, "Tenho terça, 03/11, às 2 da tarde no seu horário (4 PM ET).", { agora: new Date("2026-10-30T16:00:00Z"), slots: dia("2026-11-03", H) });

t("horário do Brasil errado", "Fechado: terça às 4 da tarde no horário do Brasil (3 PM ET).", ET, "Fechado: terça às 5 da tarde no horário do Brasil (3 PM ET).");
t("'ao meio-dia' vira 'às'", "Que tal amanhã, ao meio-dia (1:00 PM ET) ou às 4:00 PM ET?", ET, "Que tal amanhã, às 1 da tarde (1:00 PM ET) ou às 4:00 PM ET?");

console.log("\n4) Sem saber o fuso do lead, não se afirma conversão");
t("o mesmo texto do chamado, sem o estado",
  "Sexta tem sim! Tenho às 9h30 da manhã ou às 2 da tarde no seu horário (10:30 AM ET ou 3 PM ET).", null,
  "Sexta tem sim! Tenho às 10h30 da manhã ou às 3 da tarde, horário do leste (ET).");
t("um par só", "Tenho sexta, às 1 da tarde no seu horário (2 PM ET). Pode ser?", null, "Tenho sexta, às 2 da tarde, horário do leste (ET). Pode ser?");
t("ET na frente: o parêntese sai", "Perfeito, 8pm ET (5pm no seu horário). Te espero!", null, "Perfeito, 8pm ET. Te espero!");
t("'no seu horário' solto com hora da lista", "Tenho sexta às 2 da tarde no seu horário, pode ser?", null, "Tenho sexta às 2 da tarde, horário do leste (ET), pode ser?");
intacto("'seu horário' que não é fuso", "Qual seu horário preferido? Tenho terça às 7 da noite.", null);
intacto("'no seu horário de almoço'", "Posso te chamar às 12h no seu horário de almoço?", null);
intacto("'no seu horário' sem hora", "Aqui você trabalha do celular, no seu horário, sem patrão.", null);
t("lead no mesmo fuso da conta com a conta errada", "Tenho sexta às 2 da tarde no seu horário (3 PM ET).", ET, "Tenho sexta às 3 da tarde no seu horário (3 PM ET).");

console.log("\n5) Estilo da hora");
eq("9h30 da manhã → 8h30 da manhã", noEstiloDe("às 9h30 da manhã", { h: 8, min: 30 }), "às 8h30 da manhã");
eq("14h → 13h", noEstiloDe("às 14h", { h: 13, min: 0 }), "às 13h");
eq("2:00 PM → 1:00 PM", noEstiloDe("2:00 PM", { h: 13, min: 0 }), "1:00 PM");
eq("5pm → 6pm", noEstiloDe("5pm", { h: 18, min: 0 }), "6pm");
eq("2 da tarde → 10:30 da manhã", noEstiloDe("2 da tarde", { h: 10, min: 30 }), "10:30 da manhã");

console.log("\n6) Fuso pelo que o lead escreveu: 'CT' solto é Connecticut (frota, jun a nov)");
for (const m of ["CT", "Moro em CT", "Moramos em CT", "Danbury CT", "Moramos em Stamford CT", "No estado de CT", "Jan 01- 2000 CT", "10 Main St Apt 1 Danbury,CT,00000", "Estado CT", "Fulana, 01/31/1980. CT . Não fumante"]) {
  eq(`"${m.slice(0, 30)}" é ET`, fusoNaFalaDoLead(m)?.tz, ET);
}
eq("'2 PM CT' é o central", fusoNaFalaDoLead("pode ser sexta 2 PM CT")?.tz, CT);
eq("'5 da tarde CT' é o central", fusoNaFalaDoLead("5 da tarde CT")?.tz, CT);
eq("'dia 29 5pm PT' é o pacífico", fusoNaFalaDoLead("reunião será dia 29 5pm PT")?.tz, PT);
eq("'às 11am PST'", fusoNaFalaDoLead("Posso falar no dia 5 de Outubro às 11am PST")?.tz, PT);
eq("'às 8:00 ET'", fusoNaFalaDoLead("Terça-feira 29 às 8:00 ET")?.tz, ET);
eq("'Vcs estão no PST?'", fusoNaFalaDoLead("Vcs estão no PST?")?.tz, PT);
eq("Mato Grosso não é fuso da montanha", fusoNaFalaDoLead("Barra do Garças - MT"), null);
eq("'O que é ET?' não diz o fuso dele", fusoNaFalaDoLead("O que é ET?"), null);
eq("Austin segue valendo", fusoNaFalaDoLead("sexta 2 PM DE AUSTIN")?.tz, CT);
eq("Utah segue valendo", fusoNaFalaDoLead("Oi! Em Utah")?.tz, MT);
eq("'moro em CT, pode ser 2 da tarde' não pede hora no fuso central", horarioCitadoComFuso("Moro em CT, pode ser às 2 da tarde")?.fuso.tz, ET);

async function main() {
  console.log("\n7) Na guarda de agenda do turno");
  const resp = (message: string[]): AIResponse => ({ message, should_send_message: true, actions: [], internal_notes: "", collected_data: {}, conversation_status: "active" });
  const caso = ["Sexta tem sim! Tenho às 9h30 da manhã ou às 2 da tarde no seu horário (10:30 AM ET ou 3 PM ET).", "Qual fica melhor para você?"];
  const r = await aplicarGuardasDeAgenda({
    resposta: resp(caso), slotsIso: SLOTS, fusoLista: ET, fusoLead: MT, mensagemDoLead: "", pularOferta: false, agora: NOV23,
    regenerar: async () => { throw new Error("não devia refazer"); },
  });
  ok("corrige sem refazer o turno e deixa nota", !r.regenerou && r.notas.length === 2 && r.notas.every((n) => n.startsWith("fuso: ")), r.notas);
  ok("o texto sai com a conta certa", (r.resposta.message as string[])[0].includes("às 8h30 da manhã ou às 1 da tarde no seu horário (10:30 AM ET ou 3 PM ET)"), r.resposta.message);
  const b = await aplicarGuardasDeAgenda({
    resposta: resp(["Sua reunião é sexta às 2 da tarde no seu horário (3 PM ET)."]), slotsIso: undefined, fusoLista: ET, fusoLead: MT, mensagemDoLead: "", pularOferta: true, agora: NOV23,
    regenerar: async () => null,
  });
  ok("vale também em conversa já agendada e sem lista", (b.resposta.message as string[])[0].includes("às 1 da tarde"), b.resposta.message);
  const conflito = await aplicarGuardasDeAgenda({
    resposta: resp(["Tenho sexta às 1 da tarde no seu horário (3 PM ET)."]), slotsIso: SLOTS, fusoLista: ET, fusoLead: ET, mensagemDoLead: "Eu moro em Utah", pularOferta: false, agora: NOV23,
    regenerar: async () => { throw new Error("não devia refazer"); },
  });
  ok("cadastro diz um estado e o lead cita outro: fica só a hora da conta", (conflito.resposta.message as string[])[0] === "Tenho sexta às 3 da tarde, horário do leste (ET).", conflito.resposta.message);
  const semConflito = await aplicarGuardasDeAgenda({
    resposta: resp(["Fechado: sexta, 27/11, às 1 da tarde no seu horário (3 PM ET)."]), slotsIso: SLOTS, fusoLista: ET, fusoLead: MT, mensagemDoLead: "3 pm ET é perfeito", pularOferta: false, agora: NOV23,
    regenerar: async () => { throw new Error("não devia refazer"); },
  });
  ok("lead que fala a hora em ET não põe o fuso dele em dúvida", semConflito.notas.length === 0, semConflito.notas);
  console.log(`\n${pass} ok · ${fail} falhas`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
