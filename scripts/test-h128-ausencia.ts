/**
 * H128: dia em que o lead disse que está fora não é oferecido (chamado 492, Alves
 * Cury, 06/11/2026). Mensagens reais da frota, sem nome de lead.
 * Rodar: npx tsx scripts/test-h128-ausencia.ts
 */
import {
  buscarMaisHorariosDesde, datasOferecidasNaAusencia, dentroDaAusencia, diasQueOferecemos, filtrarSlotsDaAusencia,
  lerAusencias, rotuloDasAusencias, type FalaDaConversa,
} from "@/lib/queue/ausencia-lead";
import { agendaComAusencia, juntarFalas } from "@/lib/queue/ausencia-io";
import { aplicarGuardasDeAgenda } from "@/lib/queue/agenda-guard";
import { conferirOfertasDeHorario } from "@/lib/queue/slot-offer-guard";
import { buildRuntimeContext } from "@/lib/ai/sales-prompt-builder";
import type { AIResponse } from "@/types/ai";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};
const eq = (nome: string, got: unknown, want: unknown) => {
  if (got === want) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}\n     veio:   ${JSON.stringify(got)}\n     queria: ${JSON.stringify(want)}`); }
};

const ET = "America/New_York";
const lead = (texto: string, em: string): FalaDaConversa => ({ de: "lead", texto, em });
const nos = (texto: string, em: string): FalaDaConversa => ({ de: "nos", texto, em });
/** Lê uma mensagem só, dita no instante `em` (ISO), e devolve o período em texto. */
const le = (texto: string, em: string, antes: FalaDaConversa[] = []) => {
  const a = lerAusencias([...antes, lead(texto, em)], ET, new Date(em));
  return rotuloDasAusencias(a.ausencias, ET, new Date(em)) + (a.semVolta ? "[sem volta]" : "");
};
const caso = (texto: string, em: string, queria: string, antes: FalaDaConversa[] = []) => eq(`"${texto.slice(0, 70)}"`, le(texto, em, antes), queria);

console.log("\n1) Caso do chamado: sexta 06/11/2026, 09:55");
const OFERTA = nos("Tem sexta, 06/11, às 2 da tarde ET ou segunda, 09/11, às 5 da tarde ET. Qual funciona melhor para você?", "2026-11-06T14:48:52Z");
const FALA = "Esses dias não estarei disponíveis, irei viajar na segunda a noite e retorno no sábado.";
const EM = "2026-11-06T14:55:12Z";
caso(FALA, EM, "sexta-feira, 6 de novembro; de segunda-feira, 9 de novembro a sábado, 14 de novembro", [OFERTA]);
caso("irei viajar na segunda a noite e retorno no sábado", EM, "de segunda-feira, 9 de novembro (à noite) a sábado, 14 de novembro");
{
  const a = lerAusencias([lead("irei viajar na segunda a noite e retorno no sábado", EM)], ET, new Date(EM)).ausencias;
  ok("segunda de dia ainda vale, segunda 7 da noite não", !dentroDaAusencia("2026-11-09T14:00:00-05:00", a, ET) && dentroDaAusencia("2026-11-09T19:00:00-05:00", a, ET));
  ok("terça 10 e quinta 12 (o que foi oferecido) estão fora", dentroDaAusencia("2026-11-10T19:00:00-05:00", a, ET) && dentroDaAusencia("2026-11-12T18:00:00-05:00", a, ET));
  ok("sábado, o dia da volta, ainda é fora; domingo 15 já vale", dentroDaAusencia("2026-11-14T15:00:00-05:00", a, ET) && !dentroDaAusencia("2026-11-15T10:00:00-05:00", a, ET));
}

console.log("\n2) Formas de dizer que está fora (mensagens reais)");
caso("Estou viajando amanha e so volto Quinta a noite . Depois disso estou disponivel.", "2026-09-20T16:00:00Z", "de segunda-feira, 21 de setembro a quinta-feira, 24 de setembro");
caso("Tem algum horário pra semana seguinte? Eu vou estar fora a partir de amanhã e so volto dia 5.", "2026-09-23T16:00:00Z", "de quinta-feira, 24 de setembro a segunda-feira, 5 de outubro");
caso("Eu vou fazer uma viagem semana que vem e só volto em agosto. Ela tem agenda em agosto?", "2026-07-02T16:00:00Z", "de segunda-feira, 6 de julho a sexta-feira, 31 de julho");
caso("Estou em viagem fora do país só retorno dia 15", "2026-07-31T18:00:00Z", "até sábado, 15 de agosto");
caso("Estou com viagem marcada e só volto depois do dia 30 de outubro", "2026-10-04T12:00:00Z", "até sexta-feira, 30 de outubro");
caso("Estarei viajando até dia 27. Seria bom dia 28 pela manhã ja que estarei de folga.", "2026-08-19T16:00:00Z", "até quinta-feira, 27 de agosto");
caso("Desculpa, amanhã não vai dar. Estou de férias até quinta que vêm", "2026-07-08T18:00:00Z", "até quinta-feira, 16 de julho");
caso("Bom dia, Estamos de férias até semana que vem. Depois pode sim por favor.", "2026-08-15T15:00:00Z", "até domingo, 23 de agosto");
caso("Eu estou em Portugal agora Volto dia 08 de setembro Podemos nos falar depois desse dia?", "2026-08-27T20:00:00Z", "até terça-feira, 8 de setembro");
caso("Volto em Setembro .", "2026-08-21T22:18:00Z", "até segunda-feira, 31 de agosto");
caso("Volto em\nSetembro .", "2026-08-21T22:18:17Z", "até segunda-feira, 31 de agosto"); // como chegou
caso("Eu to de férias no Brasil e volto no meio do mês que vem. Eu moro na Flórida", "2026-09-29T23:00:00Z", "até quinta-feira, 15 de outubro");
caso("Tudo bem? Estou viajando, deve ter sido por isso. Volto semana que vem e combinamos. Abs", "2026-08-31T15:00:00Z", "até domingo, 6 de setembro");
caso("Eu estou na Alemanha agora mas vou estar de volta na próxima semana", "2026-09-30T14:00:00Z", "até domingo, 4 de outubro");
caso("Eu vou estar viajando hoje, mas semana que vem vou estar de volta.", "2026-08-21T19:00:00Z", "até domingo, 23 de agosto");
caso("Boa tarde !!Estamos em viajem , amanhã chego em casa , te retorno .", "2026-11-20T18:30:00Z", "até sábado, 21 de novembro");
caso("Já sai pra viajar a trabalho, retorno na quarta aí assino ok?", "2026-09-28T18:00:00Z", "até quarta-feira, 30 de setembro");
caso("So posso participar desse encontro depois do dia 7 de Agosto, estou de ferias. Obrigada.", "2026-07-22T12:00:00Z", "até sexta-feira, 7 de agosto");
caso("Estou viajando e somente após 08/11", "2026-10-31T20:00:00Z", "até domingo, 8 de novembro");
caso("Amanhã nao consigo pode ser a partir de terça eu poderia agora", "2026-11-07T15:00:00Z", "até segunda-feira, 9 de novembro");
caso("Só a partir de terça-feira", "2026-11-07T15:00:00Z", "até segunda-feira, 9 de novembro");
caso("Oi estou viajando só semana que vem eu consigo falar ! Depois marcamos melhor", "2026-07-08T14:00:00Z", "até domingo, 12 de julho");
caso("Olá querida podemos agendar na semana que vem estou de férias ainda", "2026-09-02T21:00:00Z", "até domingo, 6 de setembro");
caso("Desculpe, estou de férias agora. Daqui uma semana Obrigada", "2026-08-21T23:00:00Z", "até quinta-feira, 27 de agosto");
caso("Estarei fora na segunda e na terça", "2026-07-03T14:00:00Z", "de segunda-feira, 6 de julho a terça-feira, 7 de julho");
caso("Segunda eu vou estar em viagem", "2026-07-17T20:00:00Z", "segunda-feira, 20 de julho");
caso("Próxima semana estou viajando a trabalho. Posso falar com vcs no dia 5 de Outubro às 11am PST.", "2026-09-25T21:00:00Z", "de segunda-feira, 28 de setembro a domingo, 4 de outubro");
caso("Essa semana não consigo. Na próxima terça tenho disponibilidade às 10h", "2026-09-22T14:00:00Z", "até domingo, 27 de setembro");
caso("Essa semana nao posso", "2026-11-21T22:10:00Z", "até domingo, 29 de novembro"); // sábado: é a semana que vai começar
caso("vou estar fora de segunda à noite a sábado", EM, "de segunda-feira, 9 de novembro (à noite) a sábado, 14 de novembro");
caso("Vou viajar segunda\nVolto sábado", EM, "de segunda-feira, 9 de novembro a sábado, 14 de novembro");
caso("Viajo segunda. Volto sábado.", EM, "de segunda-feira, 9 de novembro a sábado, 14 de novembro");
caso("eu e meu esposo vamos viajar segunda e voltamos sábado", EM, "de segunda-feira, 9 de novembro a sábado, 14 de novembro");
caso("não consigo de segunda a quinta", EM, "de segunda-feira, 9 de novembro a quinta-feira, 12 de novembro");
caso("Estou de férias. Até dia 27.", "2026-08-19T16:00:00Z", "até quinta-feira, 27 de agosto");
caso("só volto sábado", EM, "até sábado, 7 de novembro");
caso("estou fora, volto 11/14", EM, "até sábado, 14 de novembro"); // formato americano

console.log("\n3) Dia ou turno recusado");
caso("Segunda não posso", "2026-09-11T14:00:00Z", "segunda-feira, 14 de setembro");
caso("hoje não consigo só amanhã", "2026-08-06T16:00:00Z", "quinta-feira, 6 de agosto");
caso("Oi me Desculpa não vou consegui amanhã meu esposo vai está trabalhando e eu também.", "2026-08-28T14:00:00Z", "sábado, 29 de agosto");
caso("Hj a tarde eu não posso", "2026-07-23T14:00:00Z", "quinta-feira, 23 de julho (à tarde) (até o fim da tarde)");
caso("Quinta não posso, sexta sim", "2026-11-17T14:00:00Z", "quinta-feira, 19 de novembro");
caso("Só consigo na sexta", "2026-11-16T14:00:00Z", "até quinta-feira, 19 de novembro");
caso("Este fim de semana não estarei disponível", "2026-07-03T14:00:00Z", "de sábado, 4 de julho a domingo, 5 de julho");
caso("Hoje eu não vou conseguir participar porque estou muito ocupado no trabalho você tem outros horários ou fins de semana como sábado", "2026-07-06T14:00:00Z", "segunda-feira, 6 de julho");
caso("Bom dia , eu não terei tempo hoje , você poderia remarcar para a próxima terça-feira no mesmo horário por favor", "2026-08-11T14:00:00Z", "terça-feira, 11 de agosto");
caso("Na parte da tarde ou amanhã a noite que hoje a noite não consigo", "2026-11-17T14:00:00Z", "terça-feira, 17 de novembro (à noite)");

console.log("\n4) 'Esses dias não': são os que acabamos de oferecer");
const DUAS = [nos("Tem vaga na segunda (28/09) ou na terça (29/09), sempre às 8pm. Qual encaixa melhor?", "2026-09-26T14:49:00Z")];
caso("Não posso nesses dias! Faço curso", "2026-09-26T14:50:00Z", "de segunda-feira, 28 de setembro a terça-feira, 29 de setembro", DUAS);
caso("Desculpa mas não consigo em nenhum desses dias", "2026-09-26T14:50:00Z", "de segunda-feira, 28 de setembro a terça-feira, 29 de setembro", DUAS);
caso("Nesses dias eu tenho aula", "2026-09-26T14:50:00Z", "de segunda-feira, 28 de setembro a terça-feira, 29 de setembro", DUAS);
caso("Nenhum desses dias. Pode ser dia 6 nesse horario?", "2026-09-26T14:50:00Z", "de segunda-feira, 28 de setembro a terça-feira, 29 de setembro", DUAS);
caso("Pode ser essa semana nesses horários", "2026-09-26T14:50:00Z", "", DUAS);
caso("Na próxima semana eu tenho segunda e quarta feira livre pode ser nestes dias a parti de 1:00 da tarde", "2026-09-26T14:50:00Z", "", DUAS);
caso("Esses dias super corrido. Irei mandar assim que eu sair do trampo", "2026-09-26T14:50:00Z", "", DUAS);
caso("Ola! Desculpe! Estive muito ocupada todos esses dias. Perdi a reunião da semana passada", "2026-09-26T14:50:00Z", "", DUAS);
caso("Pra mim nenhum desses horário e desse dia funciona porque eu vou estar trabalhando", "2026-09-26T14:50:00Z", "", DUAS); // ela pode depois das 5
caso("nenhum desses", "2026-09-26T14:50:00Z", "", [nos("Terça, 29/09, às 2 ou às 5?", "2026-09-26T14:49:00Z")]); // duas horas do mesmo dia
caso("Te agradeço mas estas datas não estou disponível!", "2026-09-26T14:50:00Z", "de segunda-feira, 28 de setembro a terça-feira, 29 de setembro", DUAS);
eq("dias que oferecemos", diasQueOferecemos("Tem terça, 10 de novembro, às 7 ou quinta (12/11) às 6", Math.floor(Date.UTC(2026, 10, 6) / 86400000)).length, 2);

console.log("\n5) O que NÃO é ausência (mensagens reais)");
for (const [t, em] of [
  ["Ok, agora to saindo pra trabalhar e só volto às 8:00pm vou ter um intervalo", "2026-07-25T12:00:00Z"],
  ["Não amor saio 6:30 am para o trabalho só volto às 20:30", "2026-07-26T23:00:00Z"],
  ["Saio pela manhã e só volto a noite. Daí fica difícil pra fazer outras coisas", "2026-08-17T12:00:00Z"],
  ["estou de licença médica porque eu fiz uma cirurgia recentemente e só volto mês q vem.", "2026-06-23T15:00:00Z"],
  ["Olá meu esposo viajou", "2026-08-13T14:00:00Z"],
  ["Ana disse q o esposo está viajando e chega amanhã", "2026-10-04T23:00:00Z"],
  ["todo ano eu viajo para Estados Unidos", "2026-10-31T03:00:00Z"],
  ["Tenho combo card autorização para trabalho e viagem", "2026-07-07T14:00:00Z"],
  ["posso te responder daqui 2 horas volto pra conversar", "2026-08-30T10:00:00Z"],
  ["Mas te retorno em breve", "2026-07-16T13:00:00Z"],
  ["te retorno no final da tarde", "2026-11-06T17:00:00Z"],
  ["Lhe darei um retorno amanhã", "2026-07-14T18:00:00Z"],
  ["Quais são os detalhes da previsão de retorno em 15 anos", "2026-11-17T22:00:00Z"],
  ["Agora estou fora de casa", "2026-09-25T21:00:00Z"],
  ["Trabalho de segunda a sábado", "2026-09-09T06:32:00Z"],
  ["trabalho de segunda a sexta das 9 às 5", "2026-09-09T14:00:00Z"],
  ["Não posso falar agora, trabalho de segunda a sexta", "2026-11-06T14:55:12Z"],
  ["meu marido vai viajar segunda e volta sexta e eu fico sozinha", "2026-11-06T14:55:12Z"],
  ["não posso depois de sexta", "2026-11-06T14:55:12Z"],
  ["Só vi sua mensagem hoje", "2026-11-06T14:55:12Z"],
  ["Eu fumo só fds", "2026-07-21T14:00:00Z"],
  ["Eu recebo só na sexta kkkk", "2026-08-18T14:00:00Z"],
  ["Estou na Flórida a 3 meses mas volto para o Brasil dia 14 estou na correria", "2026-07-12T14:00:00Z"],
  ["Amanhã não posso esse horário", "2026-09-29T14:00:00Z"],
  ["quinta às 5 não consigo", "2026-11-17T14:00:00Z"],
  ["hoje não consigo falar , somente depois das 6 ou 6:30", "2026-11-04T18:00:00Z"],
  ["não posso pagar isso hoje", "2026-11-04T18:00:00Z"],
  ["não consigo assistir o vídeo hoje", "2026-11-04T18:00:00Z"],
  ["Pode ser quinta às 3?", "2026-11-17T14:00:00Z"],
  ["Sim, confirmado. Até quinta!", "2026-11-17T14:00:00Z"],
  ["Minhas ferias acabaram, quando posso marcar para saber mais detalhes?", "2026-08-04T14:00:00Z"],
  ["não posso nesse horário, mas pode às 3", "2026-11-17T14:00:00Z"],
  ["Não tenho nada na quinta, estou livre", "2026-11-17T14:00:00Z"],
] as Array<[string, string]>) caso(t, em, "");

console.log("\n5b) Condicional, exceção e pergunta: o dia que ele deixou em aberto fica (revisão das 141 leituras reais)");
const SEG28 = "2026-09-28T23:02:30Z"; // segunda, 19:02 da Flórida
const SO_A_QUARTA = "até terça-feira, 29 de setembro; de quinta-feira, 1º de outubro a domingo, 4 de outubro";
caso("Eu não posso nesses dias e horários. Se não for quarta, só consigo semana que vem!", SEG28, SO_A_QUARTA); // real
caso("Essa semana não posso, só na quarta", SEG28, SO_A_QUARTA);
caso("Essa semana não dá, a não ser na quarta", SEG28, SO_A_QUARTA);
caso("Não consigo essa semana, exceto quarta", SEG28, SO_A_QUARTA);
caso("essa semana não posso só quarta", SEG28, SO_A_QUARTA);
caso("Semana que vem não consigo, exceto quinta", SEG28, "de segunda-feira, 5 de outubro a quarta-feira, 7 de outubro; de sexta-feira, 9 de outubro a domingo, 11 de outubro");
caso("Essa semana só consigo na quarta", SEG28, "até terça-feira, 29 de setembro");
caso("Só consigo na quarta, pode ser?", SEG28, "até terça-feira, 29 de setembro");
caso("Só na quarta, pode ser?", SEG28, "até terça-feira, 29 de setembro");
caso("Só não posso na quarta", SEG28, "quarta-feira, 30 de setembro");
caso("Vou viajar só no sábado", SEG28, "sábado, 3 de outubro");
caso("viajo só na quinta", SEG28, "quinta-feira, 1º de outubro");
caso("não posso na segunda, terça e quarta", "2026-11-06T14:55:12Z", "de segunda-feira, 9 de novembro a quarta-feira, 11 de novembro");
caso("Não consigo nem segunda nem terça", "2026-11-06T14:55:12Z", "de segunda-feira, 9 de novembro a terça-feira, 10 de novembro");
for (const [t, em] of [
  ["Me avisa se tem interesse e disponibilidade; se não der nessa data, podemos fazer em janeiro. Obrigada!", "2026-11-16T19:07:49Z"], // real
  ["Não dá\nsegunda às 5?", SEG28],
  ["Posso qualquer dia, menos quarta", SEG28], // não lê, para não errar nas duas de baixo
  ["Trabalho, todos os dias exceto aos domingos das 7 às 23 hs", "2026-07-31T14:00:00Z"], // real: o domingo é o livre
  ["Minhas aulas são todos os dias 7pm do Texas; exceto sexta-feira", "2026-08-26T14:00:00Z"], // real
  ["Se eu não puder na quarta te aviso", SEG28],
  ["Se não der na quinta, pode ser sexta", SEG28],
  ["caso eu não consiga na quarta te falo", SEG28],
  ["Não trabalho amanhã, posso sim", SEG28],
  ["Amanhã não trabalho, consigo a qualquer hora", SEG28],
  ["[Áudio do contato, transcrito] Segunda-feira você não tem expediente, segunda-feira que a segunda-feira eu tô de folga. O horário que você falou, aqui vai ser 5 horas da tarde, eu tô em casa aí, sem preocupação. Segunda-feira você não tem, né? Só terça e quinta, né? Esses dois dias.", "2026-10-29T21:51:31Z"], // real
  ["Só na quinta?", SEG28],
  ["só quinta mesmo?", SEG28],
  ["Ah, é só terça e quinta né", SEG28],
  ["De quarta, quinta e sexta tá tranquilo a noite pra mim. Só segunda e terça que eu tenho aula. Mas é o horário mesmo.", "2026-08-23T01:14:17Z"], // real
  ["Só segunda e terça que eu trabalho até tarde", "2026-11-06T14:55:12Z"],
  ["Eu não tenho tempo p manhã 💁‍♀️ somente quarta feira p amanhã . Os outros dias somente 5 pm a tarde daqui.", "2026-10-12T21:22:41Z"], // real
] as Array<[string, string]>) caso(t, em, "");

console.log("\n6) Sem data: não tira nada, só avisa");
caso("Eu vou estar viajando, não terei tempo disponível, mas obrigado de qualquer maneira.", "2026-11-19T16:43:00Z", "[sem volta]");
caso("Oi estou em viagem, quando eu retornar te chamo ok", "2026-10-30T22:00:00Z", "[sem volta]");
caso("Liga no meu telefone e por WhatsApp se possível pois estou em viagem", "2026-08-18T16:00:00Z", "[sem volta]");
caso("Feliz aniversário! Espero que tenha aproveitado a sua viagem !", "2026-07-17T16:00:00Z", "");
caso("Olá, estamos fora do nosso horário de expediente.", "2026-08-17T16:00:00Z", "");

console.log("\n7) A conversa: vale para as ofertas seguintes, e o lead muda de ideia");
{
  const viagem = lead("irei viajar na segunda a noite e retorno no sábado", EM);
  const depois = (falas: FalaDaConversa[], agora: string) => rotuloDasAusencias(lerAusencias([viagem, ...falas], ET, new Date(agora)).ausencias, ET, new Date(agora));
  eq("no dia seguinte ainda vale", depois([lead("ok, e como funciona?", "2026-11-07T15:00:00Z")], "2026-11-07T15:00:00Z"), "de segunda-feira, 9 de novembro (à noite) a sábado, 14 de novembro");
  eq("no meio da viagem: até a volta", depois([lead("oi", "2026-11-11T15:00:00Z")], "2026-11-11T15:00:00Z"), "até sábado, 14 de novembro");
  eq("passou: nada", depois([lead("oi", "2026-11-16T15:00:00Z")], "2026-11-16T15:00:00Z"), "");
  eq("ele escolhe um dia do meio: o dia volta", depois([lead("quarta às 3 eu consigo", "2026-11-07T15:00:00Z")], "2026-11-07T15:00:00Z"), "de segunda-feira, 9 de novembro (à noite) a terça-feira, 10 de novembro; de quinta-feira, 12 de novembro a sábado, 14 de novembro");
  eq("na mesma frase", le("viajo segunda e volto sábado, mas quarta eu consigo", EM), "de segunda-feira, 9 de novembro a terça-feira, 10 de novembro; de quinta-feira, 12 de novembro a sábado, 14 de novembro");
  eq("'essa semana só na quarta' não abre a quarta da viagem da semana seguinte", rotuloDasAusencias(lerAusencias([
    lead("Semana que vem estou viajando", SEG28), lead("Essa semana não posso, só na quarta", "2026-09-28T23:05:00Z"),
  ], ET, new Date("2026-09-28T23:05:00Z")).ausencias, ET, new Date("2026-09-28T23:05:00Z")), "até terça-feira, 29 de setembro; de quinta-feira, 1º de outubro a domingo, 11 de outubro");
  eq("'qualquer dia menos quarta' não devolve a quarta recusada antes", rotuloDasAusencias(lerAusencias([
    lead("Quarta não posso", SEG28), lead("Posso qualquer dia, menos quarta", "2026-09-28T23:05:00Z"),
  ], ET, new Date("2026-09-28T23:05:00Z")).ausencias, ET, new Date("2026-09-28T23:05:00Z")), "quarta-feira, 30 de setembro");
  eq("viagem cancelada", depois([lead("cancelei a viagem, pode marcar", "2026-11-07T15:00:00Z")], "2026-11-07T15:00:00Z"), "");
  eq("já voltei", depois([lead("Oi, já voltei de viagem", "2026-11-12T15:00:00Z")], "2026-11-12T15:00:00Z"), "");
  eq("a equipe oferece quarta e ele aceita", depois([nos("Consegue quarta, 11/11, às 6?", "2026-11-07T15:00:00Z"), lead("Sim", "2026-11-07T15:01:00Z")], "2026-11-07T15:01:00Z"), "de segunda-feira, 9 de novembro (à noite) a terça-feira, 10 de novembro; de quinta-feira, 12 de novembro a sábado, 14 de novembro");
  eq("'ok, obrigada' é despedida, não aceite", depois([nos("Consegue quarta, 11/11, às 6?", "2026-11-07T15:00:00Z"), lead("Ok, obrigada", "2026-11-07T15:01:00Z")], "2026-11-07T15:01:00Z"), "de segunda-feira, 9 de novembro (à noite) a sábado, 14 de novembro");
  eq("'só no sábado... mas tá tudo bem' aceita o que foi oferecido", rotuloDasAusencias(lerAusencias([
    nos("Ela tem terça 13/10 ou quinta 15/10, às 8pm. Qual fica melhor?", "2026-10-12T00:55:00Z"), lead("Pra min só no sábado", "2026-10-12T00:56:00Z"), lead("Mas tá tudo bem", "2026-10-12T00:57:00Z"),
  ], ET, new Date("2026-10-12T00:58:00Z")).ausencias, ET, new Date("2026-10-12T00:58:00Z")).includes("terça"), false);
  eq("'domingo pode' devolve o domingo que a gente ofereceu", rotuloDasAusencias(lerAusencias([
    nos("Então domingo dia 20/09 fica perfeito", "2026-09-09T06:32:43Z"), lead("Vou estar no trabalho estes dias", "2026-09-09T06:33:25Z"), lead("Domingo pode!!", "2026-09-09T06:33:43Z"),
  ], ET, new Date("2026-09-09T06:34:00Z")).ausencias, ET, new Date("2026-09-09T06:34:00Z")), "");
  const j = juntarFalas([lead("Essa semana nao posso", "2026-11-21T22:10:14Z"), lead("Essa semana nao posso", "2026-11-21T22:10:16Z"), lead("Essa semana nao posso", "2026-11-22T22:17:57Z")]);
  eq("o mesmo texto por WhatsApp e SMS conta uma vez; repetido no dia seguinte, duas", j.length, 2);
}

// ---------------------------------------------------------------------------
const slot = (d: string, hs: string[]) => ({ slots: hs.map((h) => `${d}T${h}:00-05:00`) });
const JANELA = {
  "2026-11-06": slot("2026-11-06", ["14:00", "16:00"]), "2026-11-09": slot("2026-11-09", ["14:00", "19:00"]), "2026-11-10": slot("2026-11-10", ["19:00"]),
  "2026-11-11": slot("2026-11-11", ["18:00"]), "2026-11-12": slot("2026-11-12", ["18:00"]), "2026-11-13": slot("2026-11-13", ["14:00"]), traceId: "x",
} as Record<string, unknown>;
const VOLTA = { "2026-11-16": slot("2026-11-16", ["14:00", "19:00"]), "2026-11-17": slot("2026-11-17", ["18:00"]), "2026-11-18": slot("2026-11-18", ["15:00"]) } as Record<string, unknown>;
const AGORA = new Date(EM);
const FIM_JANELA = new Date("2026-11-13T14:55:12Z");

async function main() {
  console.log("\n8) A agenda do turno");
  const falas = [OFERTA, lead(FALA, EM)];
  let desdePedido: Date | null = null;
  const a = await agendaComAusencia({ slots: JANELA, falas, tzLead: ET, tzConta: ET, agora: AGORA, fimDaJanela: FIM_JANELA, buscarDesde: async (d) => { desdePedido = d; return VOLTA; } });
  ok("a semana da viagem sai da lista", !Object.keys(a.slots).some((k) => /2026-11-(0[6-9]|1[0-4])/.test(k)), Object.keys(a.slots));
  ok("e entram os dias depois da volta", Object.keys(a.slots).includes("2026-11-16") && a.buscouMais, Object.keys(a.slots));
  eq("buscando a partir do domingo 15, meia-noite da Flórida", (desdePedido as Date | null)?.toISOString(), "2026-11-15T05:00:00.000Z");
  ok("conta o que saiu", a.retirados === 8, a.retirados);
  const semBusca = await agendaComAusencia({ slots: JANELA, falas, tzLead: ET, tzConta: ET, agora: AGORA, fimDaJanela: FIM_JANELA, buscarDesde: async () => { throw new Error("CRM fora"); } });
  ok("CRM fora na 2ª busca: segue sem horário e sem a semana", semBusca.slots && !Object.keys(semBusca.slots).some((k) => k.startsWith("2026")) && !semBusca.buscouMais, Object.keys(semBusca.slots));
  const nada = await agendaComAusencia({ slots: JANELA, falas: [OFERTA, lead("Sexta às 2 está ótimo", EM)], tzLead: ET, tzConta: ET, agora: AGORA, fimDaJanela: FIM_JANELA, buscarDesde: async () => { throw new Error("não devia buscar"); } });
  ok("sem ausência a agenda é a mesma (mesmo objeto)", nada.slots === JANELA && nada.ausencias.length === 0);
  ok("um dia recusado só tira esse dia e não busca de novo", buscarMaisHorariosDesde(filtrarSlotsDaAusencia(JANELA, lerAusencias([lead("Terça não posso", EM)], ET, AGORA).ausencias, ET), lerAusencias([lead("Terça não posso", EM)], ET, AGORA).ausencias, ET, AGORA, FIM_JANELA) === null);
  ok("viagem daqui a um mês não mexe na busca de hoje", buscarMaisHorariosDesde({}, lerAusencias([lead("vou viajar dia 20 de dezembro e volto dia 27 de dezembro", EM)], ET, AGORA).ausencias, ET, AGORA, FIM_JANELA) === null);
  {
    const CT = "America/Los_Angeles";
    const ausPT = lerAusencias([lead("terça não posso", EM)], CT, AGORA).ausencias;
    ok("o dia é o do fuso do lead: 00:30 ET de quarta ainda é terça na Califórnia", dentroDaAusencia("2026-11-11T00:30:00-05:00", ausPT, CT) && !dentroDaAusencia("2026-11-10T00:30:00-05:00", ausPT, CT));
  }

  console.log("\n9) Guarda do turno: o que o modelo escreve");
  const resp = (message: string[]): AIResponse => ({ message, should_send_message: true, actions: [], internal_notes: "", collected_data: {}, conversation_status: "active" });
  const iso = (s: Record<string, unknown>) => Object.entries(s).flatMap(([k, v]) => (k === "traceId" ? [] : (v as { slots: string[] }).slots));
  const ERRO = ["Sem problema! Então a semana que vem fica difícil.", "Tem terça, 10/11, às 7 da noite ET ou quinta, 12/11, às 6 da tarde ET. Algum desses funciona depois que você voltar?"];
  const aus = { ausencias: a.ausencias, tz: ET, rotulo: a.rotulo };
  {
    let d = "";
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(ERRO), slotsIso: iso(a.slots), fusoLista: ET, fusoLead: null, mensagemDoLead: FALA, pularOferta: false, agora: AGORA, ausencia: aus,
      regenerar: async (x) => { d = x; return resp(["Sem problema, boa viagem!", "Na volta, tenho segunda, 16 de novembro, às 7 da noite ET ou terça, 17 de novembro, às 6 da tarde ET. Qual fica melhor?"]); },
    });
    ok("a oferta do chamado é refeita", r.regenerou && (r.resposta.message as string[])[1].includes("16 de novembro"), r.resposta.message);
    ok("a diretiva explica a ausência e lista os horários da volta", d.includes("sábado, 14 de novembro") && d.includes("segunda-feira, 16 de novembro"), d);
  }
  {
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(ERRO), slotsIso: iso(a.slots), fusoLista: ET, fusoLead: null, mensagemDoLead: FALA, pularOferta: false, agora: AGORA, ausencia: aus,
      regenerar: async () => resp(ERRO),
    });
    const m = (r.resposta.message as string[]).join(" ");
    ok("insistiu: oferta determinística depois da volta", r.ofertaSubstituida && m.includes("16 de novembro") && !/10\/11|12\/11/.test(m), m);
  }
  {
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(ERRO), slotsIso: [], fusoLista: ET, fusoLead: null, mensagemDoLead: FALA, pularOferta: false, agora: AGORA, ausencia: aus,
      regenerar: async (x) => { ok("sem horário: a diretiva manda perguntar", x.includes("pergunte qual dia e período"), x); return resp(ERRO); },
    });
    const m = (r.resposta.message as string[]).join(" ");
    ok("sem horário e insistindo: sai a oferta e fica a pergunta", !/10\/11|12\/11/.test(m) && m.includes("?"), m);
  }
  {
    let refez = false;
    const r = await aplicarGuardasDeAgenda({
      resposta: resp(["Tenho terça (10/11) ou quinta (12/11). Qual prefere?"]), slotsIso: iso(a.slots), fusoLista: ET, fusoLead: null, mensagemDoLead: FALA, pularOferta: false, agora: AGORA, ausencia: aus,
      regenerar: async () => { refez = true; return resp(["Qual dia fica bom depois que você voltar?"]); },
    });
    ok("data oferecida sem hora também acusa", refez && (r.resposta.message as string[])[0].startsWith("Qual dia"), r);
  }
  {
    const boa = ["Boa viagem! Como você volta no sábado, 14 de novembro, tenho segunda, 16 de novembro, às 7 da noite ET ou terça, 17 de novembro, às 6 da tarde ET. Qual fica melhor?"];
    const r = await aplicarGuardasDeAgenda({ resposta: resp(boa), slotsIso: iso(a.slots), fusoLista: ET, fusoLead: null, mensagemDoLead: FALA, pularOferta: false, agora: AGORA, ausencia: aus, regenerar: async () => { throw new Error("não devia refazer"); } });
    ok("falar da viagem dele e oferecer depois não acusa", r.notas.length === 0, r.notas);
    eq("datasOferecidasNaAusencia não vê a data da volta", datasOferecidasNaAusencia(boa, a.ausencias, ET, AGORA).length, 0);
  }

  console.log("\n10) A correção de data não desfaz a vontade do lead (caso real, 21/11/2026)");
  {
    const SAB = new Date("2026-11-21T22:10:40Z");
    const semana = ["2026-11-23T14:00:00-05:00", "2026-11-24T14:00:00-05:00", "2026-11-26T14:00:00-05:00", "2026-11-27T14:00:00-05:00"];
    const texto = "Tenho segunda, 30/11, às 2 PM (ET) ou quinta, 03/12, às 2 PM (ET)";
    const r = conferirOfertasDeHorario([texto, "Qual funciona pra vc?"], semana, ET, { agora: SAB });
    ok("'segunda, 30/11' é um par certo: não vira 23/11", r.correcoes.length === 0 && r.messages[0] === texto && r.invalidas.length === 2, r);
    const r2 = conferirOfertasDeHorario(["Tem quarta, 05/11, às 3 da tarde ET, qual prefere?"], ["2026-11-04T15:00:00-05:00"], ET, { agora: new Date("2026-11-04T01:38:40Z") });
    ok("par errado (Izolismaria, 05/11 é quinta) segue corrigido", r2.correcoes.length === 1, r2);
    const b = await agendaComAusencia({
      slots: Object.fromEntries(semana.map((s) => [s.slice(0, 10), { slots: [s] }])), falas: [lead("Segunda 30th\nAs 2pm", "2026-11-21T22:08:50Z"), nos("Segunda, 30/11, às 2 PM (ET) não tenho disponibilidade aqui. Mas tenho segunda, 23/11, às 2 PM ou sexta, 27/11, às 2 PM, qual funciona?", "2026-11-21T22:09:22Z"), lead("Essa semana nao posso", "2026-11-21T22:10:14Z")],
      tzLead: ET, tzConta: ET, agora: SAB, fimDaJanela: new Date("2026-11-28T22:10:40Z"),
      buscarDesde: async () => ({ "2026-11-30": { slots: ["2026-11-30T14:00:00-05:00"] }, "2026-12-03": { slots: ["2026-12-03T14:00:00-05:00"] } }),
    });
    const r3 = conferirOfertasDeHorario([texto], iso(b.slots), ET, { agora: SAB });
    ok("com a ausência lida, a agenda traz 30/11 e a oferta passa como está", r3.invalidas.length === 0 && r3.messages[0] === texto, { slots: Object.keys(b.slots), r3 });
  }

  console.log("\n11) Prompt");
  {
    const ctx = (x: Record<string, unknown>) => buildRuntimeContext({
      config: { objective: "booking", data_fields: [], timezone_config: { auto_detect_from_state: true, use_location_default: true } } as never,
      contactName: "x", collectedData: {}, locationName: "Conta", currentDate: "x", timezone: ET, ...x,
    } as never);
    ok("com lista: diz o período e que já saiu da lista", ctx({ availableSlots: "Monday, November 16: 2:00 PM", ausenciaLead: { rotulo: a.rotulo, semVolta: false } }).includes("### O LEAD ESTÁ FORA"));
    const vazio = ctx({ availableSlots: "", slotsEmpty: true, ausenciaLead: { rotulo: a.rotulo, semVolta: false } });
    ok("sem lista: não diz que a agenda está cheia", vazio.includes("### O LEAD ESTÁ FORA") && !vazio.includes("### SEM HORÁRIOS DISPONÍVEIS"), vazio.slice(-400));
    ok("sem volta dita: manda perguntar", ctx({ availableSlots: "Monday: 2 PM", ausenciaLead: { rotulo: null, semVolta: true } }).includes("### O LEAD ESTÁ VIAJANDO"));
    ok("nada dito: prompt igual ao de sempre", ctx({ availableSlots: "Monday: 2 PM", ausenciaLead: { rotulo: null, semVolta: false } }) === ctx({ availableSlots: "Monday: 2 PM" }));
  }

  console.log(`\n${pass} ok · ${fail} falhas`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
