/**
 * H115: oferta de horário conferida contra a agenda real + fuso do lead.
 * Casos reais da Alves Cury (03/11/2026, Izolismaria, agenda TqJj9 da Bruna).
 * Rodar: npx tsx scripts/test-slot-offer-guard.ts
 */
import { conferirOfertasDeHorario, ofertaDeterministica } from "@/lib/queue/slot-offer-guard";
import {
  detectarFusoNoTexto,
  diferencaMinutos,
  fusoDoEstado,
  horarioCitadoComFuso,
} from "@/lib/queue/lead-timezone";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const ET = "America/New_York";
const CT = "America/Chicago";
// Agenda real da Bruna (free-slots de 04/11 00:30 BRT), em ET.
const AGENDA: Record<string, string[]> = {
  "2026-11-04": ["09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:30","21:00"],
  "2026-11-05": ["09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","16:00","16:30","17:00","17:30","18:00","20:00"],
  "2026-11-06": ["09:30","10:00","10:30","11:00","11:30","12:00","12:30","13:00","13:30","14:00","14:30","15:00","15:30","16:00"],
  "2026-11-09": ["09:30","10:00","10:30","11:00","13:00","14:30","15:00","15:30","16:00","16:30","17:00","17:30","18:00","18:30","19:00","19:30","20:00","20:30","21:00"],
};
// Novembro/2026 já é horário de inverno (EST, -05:00).
const SLOTS = Object.entries(AGENDA).flatMap(([d, hs]) => hs.map((h) => `${d}T${h}:00-05:00`));
const AGORA = new Date("2026-11-04T01:38:40Z"); // 20:38 ET de 03/11, o turno da Izolismaria

console.log("\n1) Izolismaria: datas +1 com o dia da semana certo → corrige a DATA");
{
  const r = conferirOfertasDeHorario(
    ["E ter um 401k ativo é um ótimo ponto de partida. Tem quarta, 05/11, às 3 da tarde ET ou quinta, 06/11, às 8 da noite ET. Qual funciona melhor para você?"],
    SLOTS, ET, { agora: AGORA },
  );
  ok("nenhuma oferta inválida", r.invalidas.length === 0, r);
  ok("quarta 05/11 → 04/11", r.messages[0].includes("quarta, 04/11, às 3 da tarde"), r.messages[0]);
  ok("quinta 06/11 → 05/11", r.messages[0].includes("quinta, 05/11, às 8 da noite"), r.messages[0]);
  ok("2 correções registradas", r.correcoes.length === 2, r.correcoes);
}

console.log("\n2) O texto que saiu (depois do conserto pelo nome do dia): os dois horários não existem");
{
  const r = conferirOfertasDeHorario(
    ["Tem quinta-feira, 05/11, às 3 da tarde ET ou sexta-feira, 06/11, às 8 da noite ET. Qual funciona melhor para você?"],
    SLOTS, ET, { agora: AGORA },
  );
  ok("2 ofertas inválidas", r.invalidas.length === 2, r.invalidas);
  ok("texto não foi mexido", r.messages[0].startsWith("Tem quinta-feira, 05/11"), r.messages[0]);
}

console.log("\n3) Negação não é oferta; 'até às 4 da tarde nesse dia' herda o dia");
{
  const r = conferirOfertasDeHorario(
    ["Sexta, 06/11, às 8 da noite ET não está disponível, mas tenho até às 4 da tarde nesse dia. Prefere sexta às 2 da tarde ET, ou segunda, 09/11, às 8 da noite ET?"],
    SLOTS, ET, { agora: AGORA },
  );
  ok("nenhuma inválida", r.invalidas.length === 0, r.invalidas);
  ok("3 conferidas (4 PM sexta, 2 PM sexta, 8 PM segunda)", r.conferidas === 3, r.conferidas);
}

console.log("\n4) Fuso do lead: 'no seu horário' (CT) e o ET entre parênteses");
{
  const r = conferirOfertasDeHorario(
    ["Tenho sexta, 06/11, às 1 da tarde no seu horário (2 PM ET). Pode ser?"],
    SLOTS, ET, { agora: AGORA, fusoLead: CT },
  );
  ok("válida nas duas leituras", r.invalidas.length === 0 && r.conferidas === 2, r);
  const r2 = conferirOfertasDeHorario(
    ["Tenho sexta, 06/11, às 4 da tarde no seu horário (5 PM ET)."],
    SLOTS, ET, { agora: AGORA, fusoLead: CT },
  );
  ok("4 PM CT = 5 PM ET de sexta não existe", r2.invalidas.length === 2, r2.invalidas);
}

console.log("\n5) Formatos de hora e dia");
{
  const r = conferirOfertasDeHorario(["Tenho quinta às 10h ou às 14h, qual prefere?"], SLOTS, ET, { agora: AGORA });
  ok("'às 14h' herda a quinta; as duas existem", r.invalidas.length === 0 && r.conferidas === 2, r);
  const r2 = conferirOfertasDeHorario(["Pode ser amanhã às 9:30 da manhã?"], SLOTS, ET, { agora: AGORA });
  ok("amanhã 9:30 (04/11) existe", r2.invalidas.length === 0 && r2.conferidas === 1, r2);
  const r3 = conferirOfertasDeHorario(["Tenho segunda, 09/11, às 12h."], SLOTS, ET, { agora: AGORA });
  ok("segunda 12h não existe (almoço bloqueado)", r3.invalidas.length === 1, r3);
}

console.log("\n6) Sem horário no turno (agenda travada): qualquer oferta é inválida");
{
  const r = conferirOfertasDeHorario(["Tenho quinta às 10h, pode ser?"], [], ET, { agora: AGORA });
  ok("1 inválida", r.invalidas.length === 1, r);
}

console.log("\n7) Números que não são horário não disparam nada");
{
  const r = conferirOfertasDeHorario(
    ["Você quer se aposentar em 10 a 20 anos, e uma conversa de 30 minutos já ajuda.", "Quinta foi corrido por aqui, mas me conta: você está em qual estado?"],
    SLOTS, ET, { agora: AGORA },
  );
  ok("nada conferido", r.conferidas === 0 && r.invalidas.length === 0, r);
}

console.log("\n7b) Pergunta sobre a rotina do lead não é oferta");
{
  const r = conferirOfertasDeHorario(["Você trabalha sexta às 7 da manhã?"], SLOTS, ET, { agora: AGORA });
  ok("sem pista de oferta: não confere", r.conferidas === 0, r);
  const r2 = conferirOfertasDeHorario(["Quinta às 3 da tarde ou sexta às 8 da noite, qual funciona melhor?"], SLOTS, ET, { agora: AGORA });
  ok("oferta sem 'tenho' mas com 'qual funciona': confere", r2.conferidas === 2, r2);
}

console.log("\n8) Oferta determinística");
{
  const o = ofertaDeterministica(SLOTS, ET, { agora: AGORA, preferirTardeNoite: true });
  ok("duas opções em dias diferentes, com ET", !!o && /quarta-feira, 04\/11, às 1 da tarde ET/.test(o) && /quinta-feira, 05\/11/.test(o), o);
  const o2 = ofertaDeterministica(SLOTS, ET, { agora: AGORA, preferirTardeNoite: true, fusoLead: CT });
  ok("com o fuso do lead: 'no seu horário (... ET)'", !!o2 && /às 12 da tarde no seu horário \(1 PM ET\)/.test(o2), o2);
  ok("sem horários: null", ofertaDeterministica([], ET, { agora: AGORA }) === null);
}

console.log("\n9) Fuso dito pelo lead");
{
  const h = horarioCitadoComFuso("Pode ser sexta\n2 PM\nDE AUSTIN");
  ok("'2 PM DE AUSTIN' → 14h CT", !!h && h.leituras.length === 1 && h.leituras[0] === 14 && h.fuso.tz === CT, h);
  const h2 = horarioCitadoComFuso("pode ser às 14h no horário do Texas");
  ok("'14h no horário do Texas' → 14h CT", !!h2 && h2.leituras.includes(14) && h2.fuso.tz === CT, h2);
  ok("hora sem fuso: null", horarioCitadoComFuso("sexta às 3 da tarde") === null);
  ok("idade não é hora", horarioCitadoComFuso("tenho 56 anos e moro em Austin") === null);
  ok("Orlando → ET", detectarFusoNoTexto("moro em Orlando")?.tz === ET);
  ok("'horário central' → CT", detectarFusoNoTexto("2 da tarde horário central")?.tz === CT);
  ok("texto comum: null", detectarFusoNoTexto("Me conta, você faz o quê hoje?") === null);
}

console.log("\n10) Estado coletado");
{
  ok("'Texas (Austin)' → CT", fusoDoEstado("Texas (Austin)")?.tz === CT);
  ok("'Flórida' → ET", fusoDoEstado("Flórida")?.tz === ET);
  ok("'FL' → ET", fusoDoEstado("FL")?.tz === ET);
  ok("'Massachussets' → ET", fusoDoEstado("Massachussets")?.tz === ET);
  ok("'Califórnia' → PT", fusoDoEstado("Califórnia")?.tz === "America/Los_Angeles");
  ok("'CT' no campo de estado → Connecticut (ET)", fusoDoEstado("CT")?.tz === ET);
  ok("ET → CT em novembro = -60 min", diferencaMinutos(ET, CT, AGORA) === -60, diferencaMinutos(ET, CT, AGORA));
}

console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
