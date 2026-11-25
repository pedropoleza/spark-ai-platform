/**
 * H127: data por extenso no texto do lead (chamado 492, Alves Cury, 06/11/2026).
 * Entradas copiadas de mensagens reais da frota (sem nome de lead).
 * Rodar: npx tsx scripts/test-h127-data-por-extenso.ts
 */
import { escreverDatasPorExtenso, idiomaDoTexto, lerDatas, diaEMes } from "@/lib/queue/datas-lead";
import { aplicarGuardaDeDataLead, aplicarGuardaDeRecapAgendado, corrigirDiaPelaData, rotuloDoSlot } from "@/lib/queue/lead-day-guard";
import { conferirOfertasDeHorario, ofertaDeterministica } from "@/lib/queue/slot-offer-guard";

let pass = 0, fail = 0;
const eq = (nome: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}\n     veio:   ${JSON.stringify(got)}\n     queria: ${JSON.stringify(want)}`); }
};
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const ET = "America/New_York";
const NOV6 = new Date("2026-11-06T14:55:40Z"); // 09:55 ET, o turno do chamado
const AGO1 = new Date("2026-08-01T16:00:00Z");
const ext = (t: string, quando = NOV6) => escreverDatasPorExtenso(t, ET, quando);

console.log("\n1) O que saiu em produção");
eq(
  "a oferta do chamado (06/11 09:55)",
  ext("Tem terça, 10/11, às 7 da noite ET ou quinta, 12/11, às 6 da tarde ET. Algum desses funciona depois que você voltar?"),
  "Tem terça, 10 de novembro, às 7 da noite ET ou quinta, 12 de novembro, às 6 da tarde ET. Algum desses funciona depois que você voltar?",
);
eq("parêntese", ext("Segunda (09/11), sempre às 8pm ET"), "Segunda (9 de novembro), sempre às 8pm ET");
eq("dia colado sem vírgula", ext("Tem sexta 13/11 às 2 da tarde"), "Tem sexta, 13 de novembro às 2 da tarde");
eq("forma curta", ext("amanhã, qui 05/11, às 8pm ET"), "amanhã, qui, 5 de novembro, às 8pm ET");
eq("'dia 14/11'", ext("no sábado dia 14/11"), "no sábado dia 14 de novembro");
eq("sem dia da semana, dois dígitos", ext("Ela tem 10/11 ou 12/11, às 8pm"), "Ela tem 10 de novembro ou 12 de novembro, às 8pm");
eq("primeiro do mês", ext("terça, 01/12, às 3 da tarde"), "terça, 1º de dezembro, às 3 da tarde");
eq("um dígito com âncora", ext("domingo, 8/11, às 3"), "domingo, 8 de novembro, às 3");
eq("data antes do dia", ext("10/11 (terça) às 7"), "10 de novembro (terça) às 7");
eq("negrito", ext("*terça* 10/11 às 7"), "*terça*, 10 de novembro às 7");

console.log("\n2) Formato americano escrito pelo modelo (frota, agosto) deixa de ser ambíguo");
eq("quinta, 07/30 é 30 de julho", ext("Quinta, 07/30, às 3:00 PM", new Date("2026-07-28T16:00:00Z")), "Quinta, 30 de julho, às 3:00 PM");
eq("terça (8/4) em 01/08 é 4 de agosto", ext("Na terça (8/4) ainda tenho 5:00 PM", AGO1), "Na terça (4 de agosto) ainda tenho 5:00 PM");
eq("terça (8/5) em 01/08 é 5 de agosto (o dia da semana errado é corrigido depois)", aplicarGuardaDeDataLead(["Na terça (8/5) tenho 5 PM"], ET, AGO1).messages[0], "Na quarta-feira (5 de agosto) tenho 5 PM");
eq("data recente já passada continua DD/MM", ext("quinta (06/08) ou segunda (10/08)", new Date("2026-08-12T16:00:00Z")), "quinta (6 de agosto) ou segunda (10 de agosto)");
eq("quinta, 06/11 em novembro é 6 de novembro, não 11 de junho", ext("quinta, 06/11, às 8"), "quinta, 6 de novembro, às 8");

console.log("\n3) O que NÃO é data de agenda fica como está");
for (const t of [
  "Só pra confirmar a data: 08/03/1980 é 8 de março",
  "seu filho (01/20/2020), os dois não fumam",
  "Atendemos 24/7 por aqui",
  "A cobertura chega a 2/3 da renda",
  "Aposentar em 10/20 anos",
  "Funciona entre às 7/8 da noite",
  "Nota 10/10 para o especialista",
  "Veja em https://exemplo.com/p/10/11 o vídeo",
  "São 30 minutos, sem custo",
  "Perdeu 1/2 do valor",
]) eq(`intacto: "${t.slice(0, 40)}"`, ext(t), t);

console.log("\n4) Idioma");
eq("espanhol: mês em espanhol", ext("Tengo martes, 10/11, a las 7 de la noche. ¿Te queda bien?"), "Tengo martes, 10 de noviembre, a las 7 de la noche. ¿Te queda bien?");
eq("inglês: não mexe", ext("I have Friday, 11/06 at 2 PM ET, which works for you?"), "I have Friday, 11/06 at 2 PM ET, which works for you?");
eq("sem pista: português", idiomaDoTexto("10/11 às 8"), "pt");
eq("'domingo' com 'a las' é espanhol", idiomaDoTexto("Domingo a las 3"), "es");

console.log("\n5) Leitores: os guardas entendem os dois formatos");
eq("lerDatas mistura", lerDatas("sexta, 6 de novembro ou 09/11").map((d) => `${d.d}-${d.m}`).join(" "), "6-11 9-11");
eq("por extenso com ano (nascimento) não é data de agenda", lerDatas("Nascimento em 3 de agosto de 1981").length, 0);
eq("mês sem cedilha", lerDatas("4 de marco").map((d) => `${d.d}-${d.m}`).join(""), "4-3");
eq("1º de dezembro", lerDatas("terça, 1º de dezembro").map((d) => `${d.d}-${d.m}`).join(""), "1-12");
eq("diaEMes", diaEMes({ d: 10, m: 11 }), "10 de novembro");
{
  const QUINTA = new Date("2026-08-27T16:00:00Z");
  const SEXTA = new Date("2026-08-28T16:00:00Z");
  eq("rótulo relativo certo, data por extenso: fica", aplicarGuardaDeDataLead(["Tem amanhã, sexta, 28 de agosto, às 2 da tarde."], ET, QUINTA).messages[0], "Tem amanhã, sexta, 28 de agosto, às 2 da tarde.");
  eq("rótulo relativo errado, data por extenso: cai", aplicarGuardaDeDataLead(["Tem amanhã, sexta, 28 de agosto, às 2 da tarde."], ET, SEXTA).messages[0], "Tem sexta, 28 de agosto, às 2 da tarde.");
  eq("dia da semana errado é corrigido pela data por extenso", corrigirDiaPelaData("Tem quinta, 28 de agosto, às 2.", ET, QUINTA).texto, "Tem sexta-feira, 28 de agosto, às 2.");
  eq("mantém a maiúscula", corrigirDiaPelaData("Quinta (28 de agosto) às 2", ET, QUINTA).texto, "Sexta-feira (28 de agosto) às 2");
  eq("par certo fica", corrigirDiaPelaData("Tem sexta, 28 de agosto, às 2.", ET, QUINTA).notes.length, 0);
  const so = aplicarGuardaDeDataLead(["Tem sexta, 28/08, às 2 da tarde."], ET, QUINTA);
  ok("trocar o formato muda o texto sem virar nota de correção", so.changed && so.notes.length === 0, so);
  const duas = aplicarGuardaDeDataLead(so.messages, ET, QUINTA);
  ok("passar duas vezes não muda mais nada", !duas.changed && duas.messages[0] === so.messages[0], duas);
}

console.log("\n6) Confirmação do agendamento");
{
  const BOOKED = "2026-11-10T19:00:00-05:00";
  eq("rótulo do slot", rotuloDoSlot(BOOKED, ET), "terça-feira, 10 de novembro, às 7 da noite");
  const certo = "Fechado: terça, 10 de novembro, às 7 da noite ET. A confirmação chega por aqui.";
  eq("data por extenso certa: intacta", aplicarGuardaDeRecapAgendado([certo], BOOKED, ET).messages[0], certo);
  ok("data por extenso errada: troca pelo rótulo", aplicarGuardaDeRecapAgendado(["Fechado: terça, 17 de novembro, às 7 da noite."], BOOKED, ET).messages[0].startsWith("Fechado: terça-feira, 10 de novembro"));
  const nasc = "Anotado! Nascimento em 3 de agosto de 1981.";
  eq("data de nascimento por extenso não é tratada como horário", aplicarGuardaDeRecapAgendado([nasc, certo], BOOKED, ET).messages[0], nasc);
}

console.log("\n7) Oferta conferida com a agenda, por extenso");
{
  const SLOTS = ["2026-11-04T15:00:00-05:00", "2026-11-05T20:00:00-05:00", "2026-11-06T14:00:00-05:00", "2026-11-09T20:00:00-05:00"];
  const AGORA = new Date("2026-11-04T01:38:40Z");
  const c = (t: string) => conferirOfertasDeHorario([t], SLOTS, ET, { agora: AGORA });
  const v = c("Tem sexta, 6 de novembro, às 2 da tarde ET ou segunda, 9 de novembro, às 8 da noite ET. Qual prefere?");
  ok("as duas existem", v.conferidas === 2 && v.invalidas.length === 0, v);
  const i = c("Tem sexta, 6 de novembro, às 8 da noite ET. Pode ser?");
  ok("inexistente acusa", i.invalidas.length === 1, i);
  const d = c("Tem quarta, 5 de novembro, às 3 da tarde ET ou quinta (6 de novembro), às 8 da noite ET. Qual funciona melhor?");
  eq("data errada com o dia certo: corrige a data por extenso", d.messages[0], "Tem quarta, 4 de novembro, às 3 da tarde ET ou quinta (5 de novembro), às 8 da noite ET. Qual funciona melhor?");
  const dia = c("Tenho dia 9 de novembro às 8 da noite, pode ser?");
  ok("'dia 9 de novembro' sem dia da semana", dia.conferidas === 1 && dia.invalidas.length === 0, dia);
  const o = ofertaDeterministica(SLOTS, ET, { agora: AGORA });
  ok("oferta determinística por extenso", !!o && o.includes("4 de novembro") && !/\d\/\d/.test(o), o);
}

console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
