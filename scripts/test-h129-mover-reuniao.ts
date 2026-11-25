/**
 * H129: reunião marcada só se move quando o lead escolheu o horário (chamado 527,
 * Alves Cury, 19/11/2026). Mensagens reais da frota, sem nome de lead.
 * Rodar: npx tsx scripts/test-h129-mover-reuniao.ts
 */
import { agruparFalas, falaDeRecusa, leadEscolheuHorario, type EscolhaInput } from "@/lib/queue/escolha-de-horario";
import { aplicarGuardasDeAgenda, type AgendaGuardInput } from "@/lib/queue/agenda-guard";
import type { AIResponse } from "@/types/ai";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra?: unknown) => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}`, extra !== undefined ? JSON.stringify(extra) : ""); }
};

const ET = "America/New_York";
const MT = "America/Denver";
// 19/11/2026 é quinta; 20/11 sexta; 23/11 segunda.
const QUI = new Date("2026-11-19T16:20:28Z"); // 11:20 ET, o turno do caso
const REUNIAO = "2026-11-19T17:00:00-05:00"; // quinta às 5 da tarde
const FECHADO = { texto: "Fechado: quinta-feira, 19/11, às 5 da tarde (ET). A confirmação chega por aqui. 😊", em: "2026-11-17T14:39:24Z" };
const OFERTA_ANTIGA = { texto: "Tem terça, 17/11, às 7 da noite ET ou quinta, 19/11, às 5 da tarde ET. Qual fica melhor para você?", em: "2026-11-17T09:58:24Z" };
const base = (mensagem: string, startIso: string, o: Partial<EscolhaInput> = {}): EscolhaInput => ({
  mensagem, startIso, fusoLista: ET, falasAnteriores: [FECHADO, OFERTA_ANTIGA], reuniaoIso: REUNIAO, agora: QUI, ...o,
});
const escolheu = (m: string, s: string, o: Partial<EscolhaInput> = {}) => leadEscolheuHorario(base(m, s, o));
const naoEscolheu = (nome: string, m: string, s: string, o: Partial<EscolhaInput> = {}) => {
  const r = escolheu(m, s, o); ok(`NÃO escolheu: ${nome}`, !r.escolheu, r);
};
const sim = (nome: string, m: string, s: string, o: Partial<EscolhaInput> = {}) => {
  const r = escolheu(m, s, o); ok(`escolheu: ${nome}`, r.escolheu, r);
};

console.log("\n1) O lead disse que não vai e o modelo escolheu o horário sozinho (casos reais)");
const SEXTA14 = "2026-11-20T14:00:00-05:00";
naoEscolheu("caso da Bruna, 19/11", "Bom dia, infelizmente não poderei participar do nosso encontro, obrigado e desculpe .", SEXTA14);
naoEscolheu("'não terei como parar'", "Bom dia estou agarrado no trabalho\nNão terei como parar  pra conversar\nDesculpa", "2026-11-20T11:30:00-05:00");
naoEscolheu("'tenho um compromisso' com a hora da própria reunião", "Hoje 5:00 tenho um compromisso sorry", "2026-11-19T18:00:00-05:00");
naoEscolheu("imprevisto", "Olá\nTudo bem?\nNão conseguirei hoje\nTive um imprevisto\nJá iria te mandar mensagem inclusive", "2026-11-23T11:00:00-05:00");
naoEscolheu("surgiu reunião de trabalho nesse horário", "Oi, tudo bem?\n\nSurgiu uma reunião de trabalho nesse horário e não poderei atender amanhã.", "2026-11-20T13:00:00-05:00");
naoEscolheu("disse uma hora, o modelo marcou outra", "Oi, bom dia!\nNão vou conseguir, surgiu um trabalho, só às 6 da noite 🤦🏼‍♀️", "2026-11-20T20:00:00-05:00");
naoEscolheu("disse só o dia", "Desculpa n vou poder conversar hoje só segunda", "2026-11-23T13:00:00-05:00");
naoEscolheu("férias até quinta que vem", "Desculpa, amanhã não vai dar. Estou de férias até quinta que vêm", "2026-11-27T10:00:00-05:00");
naoEscolheu("'prefiro outro dia, talvez sábado'", "Prefiro agendar outro dia\nVejo e tw falo\nTalvez sábado", "2026-11-23T09:00:00-05:00");
naoEscolheu("dois dias possíveis, sem hora", "por favor vx pode me ligar amanha ou qualquer momento no sabado eu to apertada aqui\nPor favor e perdao", "2026-11-20T10:00:00-05:00");
naoEscolheu("'se tiver mais cedo seria melhor'", "Se tiver mais cedo seria melhor", "2026-11-20T15:00:00-05:00");
naoEscolheu("'ok, te aguardo' e o modelo mudou o dia", "Ok, te aguardo", "2026-11-20T17:00:00-05:00");
naoEscolheu("'tanto faz'", "Tanto faz", "2026-11-19T18:00:00-05:00");

console.log("\n2) Variações de 'não vou'");
for (const m of [
  "não vou poder ir hoje", "Desculpa, surgiu um imprevisto", "Oi, hoje não dá", "terei que faltar", "Infelizmente não vou conseguir, obrigado",
  "preciso cancelar", "vou ter que desmarcar", "estou doente", "estou no hospital com meu filho", "Não posso hoje, obrigada viu",
  "hj n consigo", "não vou estar disponível amanhã", "tive que trabalhar hoje", "não será possível", "Obrigado, mas não poderei",
  "Quero remarcar", "Podemos mudar o horário?", "preciso remarcar a reunião de quinta às 5",
]) naoEscolheu(`"${m}"`, m, SEXTA14);
// "obrigado" e "ok" não aceitam oferta antiga quando a fala é de recusa
naoEscolheu("recusa + 'obrigado' com a sexta 14h ofertada antes", "Infelizmente não vou poder, obrigado", SEXTA14, {
  falasAnteriores: [FECHADO, { texto: "Tem quinta, 19/11, às 5 da tarde ou sexta, 20/11, às 2 da tarde. Qual fica melhor?", em: "2026-11-17T09:58:24Z" }],
});
naoEscolheu("recusa do dia oferecido", "Sexta não posso", SEXTA14, { falasAnteriores: [{ texto: "Tenho sexta, 20 de novembro, às 2 da tarde. Pode ser?", em: "2026-11-19T15:00:00Z" }] });

console.log("\n3) O lead escolheu: a agenda segue como sempre");
sim("dia e hora na mesma frase da recusa", "Hoje não consigo, pode ser amanhã às 3?", "2026-11-20T15:00:00-05:00");
sim("'não posso nesse horário, mas pode às 3'", "não posso nesse horário, mas pode às 3", "2026-11-19T15:00:00-05:00");
sim("sem pontuação", "n consigo hoje so amanha as 3", "2026-11-20T15:00:00-05:00");
sim("'só às 6 da noite' no mesmo dia", "Não vou conseguir, surgiu um trabalho, só às 6 da noite", "2026-11-19T18:00:00-05:00");
sim("dia e hora", "Pode ser sexta 7pm", "2026-11-20T19:00:00-05:00");
sim("hora e dia em mensagens separadas", "Sexta 20\n9am", "2026-11-20T09:00:00-05:00");
sim("formato americano de data", "Pode ser 11/23 às 2pm?", "2026-11-23T14:00:00-05:00");
sim("'amanhã 9:00 am'", "Oi\nAmanhã 9:00 am\n20/11", "2026-11-20T09:00:00-05:00");
sim("número solto respondendo à oferta", "6", "2026-11-23T18:00:00-05:00", { falasAnteriores: [{ texto: "Segunda funciona sim. Tenho esses horários na segunda (23/11): • 1:00 PM ET\n• 6:00 PM ET Qual fica melhor pra vc?", em: "2026-11-19T15:00:00Z" }] });
sim("'5 é melhor para mim'", "5 eh melhor p mim.", "2026-11-20T17:00:00-05:00", { falasAnteriores: [{ texto: "Tem sexta, às 10:00 AM ou às 5:00 PM. Qual funciona melhor?", em: "2026-11-19T15:00:00Z" }] });
sim("'7 está bom'", "pode ser na quinta\naliás sexta\n7 está bom", "2026-11-20T19:00:00-05:00", { falasAnteriores: [{ texto: "Sexta (20/11) então! 7:00 PM ou 8:00 PM ET, qual fica melhor?", em: "2026-11-19T15:00:00Z" }] });
sim("aceite da oferta", "Está ótimo\nObrigada", "2026-11-23T16:00:00-05:00", { falasAnteriores: [{ texto: "Segunda 23/11 tem a partir das 4 PM ET 👍\nPrefere segunda às 4 PM então?", em: "2026-11-19T15:00:00Z" }] });
sim("período da oferta", "tarde", "2026-11-24T14:00:00-05:00", { falasAnteriores: [{ texto: "9 AM ou 2 PM na terça, qual vc prefere?", em: "2026-11-19T15:00:00Z" }] });
sim("dia da oferta, recusando o outro", "Quinta não posso, sexta sim", SEXTA14, { falasAnteriores: [{ texto: "Tem quinta, 26 de novembro, às 5 da tarde ou sexta, 20 de novembro, às 2 da tarde?", em: "2026-11-19T15:00:00Z" }] });
sim("'a segunda opção' depois da recusa", "Não consigo hoje. Fico com a segunda opção", SEXTA14, { falasAnteriores: [{ texto: "Tenho sexta, 20 de novembro, às 10 da manhã ou às 2 da tarde. Qual prefere?", em: "2026-11-19T15:00:00Z" }] });
sim("dia dito com horário único na agenda", "consigo reagendar para a de segunda, por favor?", "2026-11-23T20:00:00-05:00", { slotsIso: ["2026-11-23T20:00:00-05:00", "2026-11-26T20:00:00-05:00"] });
naoEscolheu("dia dito com vários horários na agenda", "consigo reagendar para a de segunda, por favor?", "2026-11-23T20:00:00-05:00", { slotsIso: ["2026-11-23T20:00:00-05:00", "2026-11-23T18:00:00-05:00"] });
sim("'mesmo horário' noutro dia", "Pode ser sexta no mesmo horário?", "2026-11-20T17:00:00-05:00");
sim("hora no fuso do lead", "Não consigo hoje. Pode ser amanhã 1 da tarde?", "2026-11-20T15:00:00-05:00", { fusoLead: MT });
sim("hora por extenso", "Hoje não vai dar, pode ser amanhã às três da tarde?", "2026-11-20T15:00:00-05:00");
sim("meia hora por extenso", "amanhã às cinco e meia", "2026-11-20T17:30:00-05:00");
sim("'430'", "430", "2026-11-25T16:30:00-05:00", { falasAnteriores: [{ texto: "Ficou pendente só confirmar o horário, 4:00 PM ou 4:30 PM na quarta 25/11?", em: "2026-11-19T15:00:00Z" }] });
sim("resposta citando a nossa oferta", "Essa", SEXTA14, { falasAnteriores: [], citado: "Tenho sexta, 20 de novembro, às 2 da tarde. Pode ser?" });
sim("só áudio sem transcrição: não dá para julgar", "[media]", SEXTA14);
sim("cancelar e marcar outro na mesma frase", "Preciso cancelar hoje e marcar para sexta às 3 da tarde", "2026-11-20T15:00:00-05:00");
sim("'tenho que remarcar para sexta às 3'", "tenho que remarcar para sexta às 3", "2026-11-20T15:00:00-05:00");
sim("escolha com o motivo junto", "Pode ser sexta às 7 que eu saio às 6", "2026-11-20T19:00:00-05:00");
sim("aceite alongado", "simmm", SEXTA14, { falasAnteriores: [{ texto: "Posso confirmar sexta, 20 de novembro, às 2 da tarde?", em: "2026-11-19T15:00:00Z" }] });
naoEscolheu("'talvez sexta' com a sexta oferecida", "Talvez sexta, vou ver e te aviso", SEXTA14, { falasAnteriores: [{ texto: "Tenho sexta, 20 de novembro, às 2 da tarde. Pode ser?", em: "2026-11-19T15:00:00Z" }] });
naoEscolheu("'bom dia' não é aceite", "Bom dia, tudo bem?", SEXTA14, { falasAnteriores: [{ texto: "Tenho sexta, 20 de novembro, às 2 da tarde. Pode ser?", em: "2026-11-19T15:00:00Z" }] });
naoEscolheu("número dentro de link não é hora", "https://us02web.zoom.us/j/14", SEXTA14);
naoEscolheu("mesma hora, dia que ele não disse", "pode às 3 pm?", "2026-11-23T15:00:00-05:00");
naoEscolheu("idade não é hora", "Tenho 2 filhos e 14 anos de casado", SEXTA14);

console.log("\n4) Recusa");
ok("caso real é recusa", falaDeRecusa("Bom dia, infelizmente não poderei participar do nosso encontro"));
ok("confirmar presença não é recusa", !falaDeRecusa("Sim, confirmado! Estarei lá"));
ok("pedir hora não é recusa", !falaDeRecusa("Pode ser sexta às 3?"));

console.log("\n5) Falas agrupadas por turno");
{
  const f = agruparFalas([
    { direction: "outbound", body: "Tenho segunda, 23 de novembro:", dateAdded: "2026-11-19T10:00:00Z" },
    { direction: "outbound", body: "1 PM ou 6 PM?", dateAdded: "2026-11-19T10:00:05Z" },
    { direction: "inbound", body: "6", dateAdded: "2026-11-19T10:01:00Z" },
    { direction: "outbound", body: "Fechado!", dateAdded: "2026-11-19T10:02:00Z" },
    { direction: "inbound", body: "ok", dateAdded: "2026-11-19T10:03:00Z" },
  ]);
  ok("2 falas, a mais nova primeiro, bolhas juntas", f.length === 2 && f[0].texto === "Fechado!" && f[1].texto.includes("6 PM"), f);
}

const resp = (message: string[], actions: AIResponse["actions"] = [], status: AIResponse["conversation_status"] = "booked"): AIResponse =>
  ({ message, should_send_message: true, actions, internal_notes: "", collected_data: {}, conversation_status: status });
const SLOTS = [SEXTA14, "2026-11-20T15:00:00-05:00", "2026-11-23T16:00:00-05:00", "2026-11-23T18:00:00-05:00"];
const MOVE = { type: "reschedule_appointment" as const, start_time: SEXTA14 };
const entrada = (o: Partial<AgendaGuardInput>): AgendaGuardInput => ({
  resposta: resp(["Sem problema, acontece!", "Fechado: sexta-feira, 20/11, às 2 da tarde, horário do leste. A confirmação chega por aqui."], [MOVE]),
  slotsIso: SLOTS, fusoLista: ET, fusoLead: null, pularOferta: true, agora: QUI,
  mensagemDoLead: "Bom dia, infelizmente não poderei participar do nosso encontro, obrigado e desculpe .",
  falasAnteriores: [FECHADO, OFERTA_ANTIGA],
  reuniaoMarcada: async () => ({ inicioIso: REUNIAO }),
  regenerar: async () => { throw new Error("não devia refazer"); },
  ...o,
});

async function main() {
  console.log("\n6) Guarda no turno (com o modelo simulado)");
  {
    let diretiva = "";
    const r = await aplicarGuardasDeAgenda(entrada({
      regenerar: async (d) => { diretiva = d; return resp(["Sem problema, agradeço por avisar!", "Você prefere outro dia ou quer deixar para depois?"], [], "active"); },
    }));
    ok("refaz 1 vez e nenhuma ação de agenda sai", r.regenerou && r.resposta.actions.length === 0, r.resposta);
    ok("a diretiva diz qual reunião e proíbe mexer", diretiva.includes("quinta-feira, 19 de novembro, às 5 da tarde") && diretiva.includes("NÃO mexa na agenda") && diretiva.includes("não vai ou não pode"), diretiva);
    ok("o texto refeito é o que vai", (r.resposta.message as string[])[1].includes("outro dia"), r.resposta.message);
    ok("fica na auditoria o que ia ser movido", r.movimentoRetirado?.reuniao === REUNIAO && r.movimentoRetirado.tentou[0] === SEXTA14, r.movimentoRetirado);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({ regenerar: async () => entrada({}).resposta }));
    const m = r.resposta.message as string[];
    ok("insistiu: a ação sai e a afirmação vira pergunta", r.resposta.actions.length === 0 && m.length === 2 && m[0] === "Sem problema, acontece!" && m[1].endsWith("?") && !/20/.test(m[1]), r.resposta);
    ok("a conversa não fica como agendada", r.resposta.conversation_status === "active");
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({ regenerar: async () => null }));
    ok("refazer falhou: mesmo assim a reunião não se move", r.resposta.actions.length === 0 && !JSON.stringify(r.resposta.message).includes("Fechado"), r.resposta);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({ regenerar: async () => resp(["Remarquei para sexta, 20 de novembro, às 2 da tarde."], [], "active") }));
    ok("refez sem a ação mas afirmando a mudança: vira pergunta", r.resposta.actions.length === 0 && (r.resposta.message as string[]).length === 1 && (r.resposta.message as string[])[0].endsWith("?"), r.resposta.message);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({
      resposta: resp(["Sem problema! Acontece 😊 Tenho sexta, 20/11, às 2 da tarde ou segunda, 23/11, às 6 da tarde. Qual fica melhor pra vc?"], [MOVE]),
    }));
    ok("o texto já perguntava: só a ação sai, sem refazer", !r.regenerou && r.resposta.actions.length === 0 && (r.resposta.message as string[])[0].startsWith("Sem problema"), r);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({
      resposta: resp(["Sem problema!"], [{ type: "update_field", field_key: "state", value: "FL" }, { type: "book_appointment", start_time: SEXTA14 }]),
      regenerar: async () => { throw new Error("não devia refazer"); },
    }));
    ok("book_appointment também conta, e as outras ações ficam", r.resposta.actions.length === 1 && r.resposta.actions[0].type === "update_field", r.resposta.actions);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({
      mensagemDoLead: "Hoje não consigo, pode ser amanhã às 2?",
      resposta: resp(["Fechado: sexta-feira, 20 de novembro, às 2 da tarde ET."], [MOVE]),
    }));
    ok("o lead escolheu: não mexe em nada", r.notas.length === 0 && r.resposta.actions.length === 1 && !r.movimentoRetirado, r.notas);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({
      mensagemDoLead: "Sim, confirmado! Obrigada",
      resposta: resp(["Perfeito, te esperamos!"], [{ type: "book_appointment", start_time: "2026-11-19T17:00:00-03:00" }]),
    }));
    ok("repetir o horário que ele já tem (offset errado incluso) não é mover", r.notas.length === 0 && r.resposta.actions.length === 1, r);
  }
  {
    let consultou = 0;
    const r = await aplicarGuardasDeAgenda(entrada({
      resposta: resp(["Que ótimo, te esperamos na quinta!"], []),
      mensagemDoLead: "Estarei lá!",
      reuniaoMarcada: async () => { consultou++; return { inicioIso: REUNIAO }; },
    }));
    ok("sem ação de agenda a reunião nem é consultada", consultou === 0 && r.notas.length === 0);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({
      mensagemDoLead: "quero sim, me coloca aí", reuniaoMarcada: async () => null,
      resposta: resp(["Fechado: sexta, 20 de novembro, às 2 da tarde."], [{ type: "book_appointment", start_time: SEXTA14 }]),
    }));
    ok("primeiro agendamento (sem reunião) não passa por esta guarda", r.notas.length === 0 && r.resposta.actions.length === 1, r.notas);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({ reuniaoMarcada: async () => { throw new Error("CRM fora"); } }));
    ok("CRM fora do ar: comportamento de antes", r.notas.length === 0 && r.resposta.actions.length === 1, r.notas);
  }
  {
    const r = await aplicarGuardasDeAgenda(entrada({ reuniaoMarcada: undefined }));
    ok("sem a reunião conhecida (turno proativo): guarda desligada", r.notas.length === 0 && r.resposta.actions.length === 1, r.notas);
  }
  console.log(`\n${pass} ok · ${fail} falhas`);
  process.exit(fail > 0 ? 1 : 0);
}
main();
