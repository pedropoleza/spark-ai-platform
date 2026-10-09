/**
 * H103: remarcação depois que a equipe assume. Teste determinístico (sem rede).
 *   npx tsx scripts/test-remarcacao-pos-handoff.ts
 *
 * As frases do detector são mensagens REAIS de lead da frota (30.020 lidas em
 * 09/10/2026), sem nome, telefone ou e-mail. Os negativos são os falsos que a
 * primeira versão do detector pegou: se algum voltar a casar, o teste quebra.
 */
import {
  detectarPedidoDeRemarcacao,
  separarTextoDoLead,
  avaliarPreGate,
  confirmarEntrada,
  restringirAcoes,
  prepararRespostaDaRemarcacao,
  rotuloReuniao,
  pausaEhDaEquipe,
  ultimaSaidaHumanaEm,
  secaoModoRemarcacao,
  falaDaReuniao,
  type ReuniaoFutura,
} from "../src/lib/queue/remarcacao-pos-handoff";
import { buildSystemPrompt, buildRuntimeContext } from "../src/lib/ai/sales-prompt-builder";
import type { AgentConfig } from "../src/types/agent";
import type { AIAction } from "../src/types/ai";

let ok = 0;
let fail = 0;
function t(nome: string, cond: boolean, det = "") {
  if (cond) ok++;
  else {
    fail++;
    console.log(`  ❌ ${nome}${det ? `  → ${det}` : ""}`);
  }
}

// ── 1. Detector: pedidos reais ───────────────────────────────────────────────
console.log("1. detector: pedidos reais");
const POSITIVOS: Array<[string, "remarcar" | "desmarcar" | "nao_vai", "explicito" | "contextual"]> = [
  ["quero remarcar", "remarcar", "explicito"],
  ["Podemos remarca por favor ? 🙏🏼", "remarcar", "explicito"],
  ["Podemos reagendar pra amanhã?", "remarcar", "explicito"],
  ["Boa noite Eu preciso remarcar Desculpa Eu teria folga amanhã mas infelizmente terei q trabalhar.", "remarcar", "explicito"],
  ["Ola Boa tarde. Seria possível remarcarmos essa reunião? Eu gostaria muito, mas estou numa crise de enxaqueca terrível.", "remarcar", "explicito"],
  ["Oi teria como reagendar tive que sair", "remarcar", "explicito"],
  ["Podemos reprogramar para as 7pm", "remarcar", "explicito"],
  ["Vou ter que desmarcar o apontamento", "desmarcar", "explicito"],
  ["Desculpa queria desmarcar a reunião de quarta tinha me esquecido, é aniversário da minha filha", "desmarcar", "explicito"],
  ["Gostaria de cancelar o encontro de hoje Nao estarei disponível", "desmarcar", "explicito"],
  ["Vou ter q cancelar a videochamada,pois um colega de trabalho se acidentou", "desmarcar", "explicito"],
  ["Pode cancelar o agendamento", "desmarcar", "explicito"],
  ["Gente vcs não leem as mensagens ? Já cancelei essa reunião", "desmarcar", "explicito"],
  ["É possível mudar a data?", "remarcar", "explicito"],
  ["Gostaria de mudar meu agendamento para terça feira mesmo horário teria como?", "remarcar", "explicito"],
  ["Bom dia! Acho que não vou conseguir …. Podemos deixar pra segunda ?", "remarcar", "explicito"],
  ["Tem algum outro dia? Tenho um compromisso nesse mesmo horário dia 25.", "remarcar", "explicito"],
  ["Oi boa tarde desculpa vamos marcar outro dia o meu trabalho ta uma correria hoje 😬", "remarcar", "explicito"],
  ["Vc tem outro horário ?", "remarcar", "explicito"],
  ["Por favor se você tiver até para outro dia as 4", "remarcar", "explicito"],
  ["amanhã não consigo", "nao_vai", "explicito"],
  ["Hoje a tarde nao consigo", "nao_vai", "explicito"],
  ["Na quinta nao consigo", "nao_vai", "explicito"],
  ["Hj eu não vou conseguir", "nao_vai", "explicito"],
  ["Infelizmente eu não vou poder estar na reuniao", "nao_vai", "explicito"],
  ["Boa noite Tive um problema de última hora e infelizmente não poderei participar da vídeo chamada hoje à noite", "nao_vai", "explicito"],
  ["Oi bom dia fiquei sabendo agora que tenho que trabalhar até mais tarde eu sou nanny então não posso fazer a ligação hoje", "nao_vai", "explicito"],
  ["Olá desculpa eu não vou conseguir entrar na chamada estou no trabalho ainda!!!", "nao_vai", "explicito"],
  ["Nao vou conseguir", "nao_vai", "contextual"],
  ["Não vai dar, desculpa!", "nao_vai", "contextual"],
  ["Cancela", "desmarcar", "contextual"],
  ["Podemos cancelar", "desmarcar", "contextual"],
  ["Oi desculpe aconteceram algumas coisas de sexta pra hoje e terei q cancelar Assim q eu conseguir me organizar novamente entro em contato Obrigada", "desmarcar", "contextual"],
  ["Oi bom dia preciso cancelar meu filho tá passando mal estou indo p médico com ele desculpa", "desmarcar", "contextual"],
  ["Tive um imprevisto", "nao_vai", "contextual"],
  ["Me desculpe ouve imprevisto", "nao_vai", "contextual"],
  ["[Áudio do contato, transcrito] Oi, bom dia, tudo bom? É, eu precisei vir buscar um carro meu no aeroporto, a gente pode remarcar para a tarde?", "remarcar", "explicito"],
];
for (const [frase, tipo, forca] of POSITIVOS) {
  const r = detectarPedidoDeRemarcacao(frase);
  t(`"${frase.slice(0, 60)}" → ${tipo}/${forca}`, !!r && r.tipo === tipo && r.forca === forca, JSON.stringify(r));
}

// ── 2. Detector: o que NÃO é pedido (falsos que já casaram) ──────────────────
console.log("2. detector: não é pedido de remarcação");
const NEGATIVOS = [
  "Não posso falar agora!!",
  "Desculpa nao posso falar agora",
  "Oii me desculpe não consigo falar agora tive um compromisso com minha esposa e filho",
  "Estou no serviço. Não consigo atender",
  "Não posso falar",
  "Agora eu não posso gastar esse dinheiro",
  "Más não posso pagar para tirar uma licensa tao cara para começar a trabalhar por comissao",
  "E outra coisa se eu decidir ir embora por exemplo ano que vem . Quando eu posso cancelar meu contrato?",
  "Caso eu queira cancelar como funciona?",
  "Oi vou cancelar uma menina já mim respondeu que seguro tá pagando",
  "Mais eu cancelei",
  "E seguro tava no nome do meu ex mais o dinheiro saia da minha conta por isso cancelei",
  "Não consigo entrar , endereço inválido",
  "Não consigo baixar Pode me reenviar?",
  "Tô na reunião não consigo ouvir",
  "Devo acessar em outro horário ou fico aguardando?",
  "Oi desculpa mas não vou conseguir contratar o seguro agora . Mas quando puder ,volto a entrar em contato . Obrigada",
  "Tudo certo, não precisa remarcar",
  "Confirmado, estarei lá",
  "👤 Fulana (+5500000000000) Ju, pede pra remarcar com ela",
  "🔵 AD MESSAGE: Title: x Body: cancele quando quiser",
  "*Headline:* Alves Cury Financial *Source URL:* https://fb.me/x Hello! I filled out your form",
  "↩️ Reply menssage: Passando pra lembrar da sua reunião hoje 1PM. Se não conseguir comparecer, nos avise para remarcar.\n\n➡️ Message: Ok, estarei lá",
];
for (const frase of NEGATIVOS) {
  const r = detectarPedidoDeRemarcacao(frase);
  t(`"${frase.slice(0, 60)}" → nada`, r === null, JSON.stringify(r));
}

// ── 3. Resposta citando o lembrete ───────────────────────────────────────────
console.log("3. resposta citando outra mensagem");
{
  const bruto = "↩️ Reply menssage: Passando pra lembrar da sua reunião hoje 1PM.\n\n➡️ Message: Não vou conseguir";
  const { proprio, citado } = separarTextoDoLead(bruto);
  t("separa o texto do lead", proprio.trim() === "Não vou conseguir", proprio);
  t("guarda a citada como contexto", citado.includes("lembrar da sua reunião"), citado);
  t("o pedido sai do texto do lead", detectarPedidoDeRemarcacao(bruto)?.regra === "nao_vai_solto");
  t("a citada fala da reunião (contexto do pedido solto)", falaDaReuniao(citado));
}

// ── 4. Primeira trava: pausa e pedido ────────────────────────────────────────
console.log("4. primeira trava");
const agora = new Date("2026-10-12T15:00:00Z");
const pedido = detectarPedidoDeRemarcacao("quero remarcar");
const pre = (o: Partial<Parameters<typeof avaliarPreGate>[0]>) =>
  avaliarPreGate({ habilitado: true, motivoPausa: "auto_pause:human_message:user_abc", pedido, janelaAte: null, agora, ...o });
t("desligado não entra", !pre({ habilitado: false }).candidato);
t("pausa por mensagem humana + pedido entra", pre({}).candidato && pre({}).via === "pedido");
t("pausa pelo histórico (F52) + pedido entra", pre({ motivoPausa: "auto_pause:human_message:history" }).candidato);
t("pausa pós-agendamento + pedido entra", pre({ motivoPausa: "post_booking:stop_and_handoff" }).candidato);
t("switch manual do painel NÃO entra (desligar tem que valer)", !pre({ motivoPausa: "manual_ui:switch:user_x" }).candidato);
t("opt-out NÃO entra", !pre({ motivoPausa: "opt_out:pare" }).candidato);
t("automação pausou NÃO entra", !pre({ motivoPausa: "reaction:pause_ai" }).candidato);
t("teto de mensagens NÃO entra", !pre({ motivoPausa: "max_messages_per_conversation:60/60" }).candidato);
t("sem pedido e sem janela não entra", !pre({ pedido: null }).candidato);
t(
  "janela aberta entra sem pedido (\"pode ser terça\")",
  pre({ pedido: null, janelaAte: "2026-10-12T20:00:00Z" }).via === "janela",
);
t("janela vencida não entra", !pre({ pedido: null, janelaAte: "2026-10-12T14:00:00Z" }).candidato);
t("pausaEhDaEquipe lista fechada", pausaEhDaEquipe("auto_pause:human_message:user_1") && !pausaEhDaEquipe(null));

// ── 5. Segunda trava: reunião e humano ───────────────────────────────────────
console.log("5. segunda trava");
const reuniao: ReuniaoFutura = { id: "apt123456789012345678", calendarId: "cal-bruna", startTime: "2026-10-15T19:00:00-04:00" };
const conf = (o: Partial<Parameters<typeof confirmarEntrada>[0]>) =>
  confirmarEntrada({
    via: "pedido",
    pedido,
    reuniao,
    calendarioDoAgente: "cal-bruna",
    ultimaSaidaHumanaEm: "2026-10-11T15:00:00Z",
    janelaAbertaEm: null,
    humanoAtivoMin: 60,
    contextoFalaDaReuniao: false,
    agora,
    ...o,
  });
t("caso feliz entra", conf({}).entra);
t("sem reunião futura não entra", conf({ reuniao: null }).motivo === "sem_reuniao_futura");
t("reunião de outro calendário não entra", conf({ calendarioDoAgente: "cal-bruno" }).motivo === "reuniao_de_outro_calendario");
t("humano há 20 min (janela 60) não entra", conf({ ultimaSaidaHumanaEm: "2026-10-12T14:40:00Z" }).motivo === "humano_ativo");
t("humano há 2h entra", conf({ ultimaSaidaHumanaEm: "2026-10-12T13:00:00Z" }).entra);
t("janela 0 usa o padrão de 30 min", conf({ humanoAtivoMin: 0, ultimaSaidaHumanaEm: "2026-10-12T14:40:00Z" }).motivo === "humano_ativo");
{
  const d = conf({ via: "janela", pedido: null, janelaAbertaEm: "2026-10-12T12:00:00Z", ultimaSaidaHumanaEm: "2026-10-12T13:00:00Z" });
  t("humano escreveu depois da janela abrir: sai e fecha", !d.entra && d.motivo === "humano_retomou" && d.fecharJanela);
}
t("janela sem reunião fecha", conf({ via: "janela", reuniao: null }).fecharJanela);
const solto = detectarPedidoDeRemarcacao("Não vou conseguir");
t("pedido solto sem contexto não entra", conf({ pedido: solto }).motivo === "pedido_sem_contexto");
t("pedido solto com contexto entra", conf({ pedido: solto, contextoFalaDaReuniao: true }).entra);

// ── 6. Ações e resposta ──────────────────────────────────────────────────────
console.log("6. ações e resposta do turno");
{
  const acts: AIAction[] = [
    { type: "book_appointment", calendar_id: "x", start_time: "2026-10-16T15:00:00-04:00" },
    { type: "reschedule_appointment", start_time: "2026-10-17T15:00:00-04:00" },
    { type: "update_field", field_key: "state", value: "FL" },
    { type: "add_tag", tag: "x" },
  ];
  const r = restringirAcoes(acts, reuniao);
  t("só 1 ação sobra", r.acoes.length === 1, JSON.stringify(r.acoes));
  t("book vira reschedule da reunião certa", r.acoes[0]?.type === "reschedule_appointment" && r.acoes[0]?.appointment_id === reuniao.id && r.acoes[0]?.calendar_id === "cal-bruna");
  t("o resto é descartado", r.descartadas.join(",") === "reschedule_appointment,update_field,add_tag", r.descartadas.join(","));
  const sil = prepararRespostaDaRemarcacao({ message: "", should_send_message: false, actions: [] }, reuniao);
  t("modelo pediu silêncio → silêncio", sil.silencio && sil.message.length === 0);
  const vazio = prepararRespostaDaRemarcacao({ message: [], should_send_message: true, actions: [] }, reuniao);
  t("sem texto e sem ação → silêncio (nunca o \"Pode me contar mais?\")", vazio.silencio);
  const marcador = prepararRespostaDaRemarcacao({ message: "[[NAO_ENVIAR]]", should_send_message: true, actions: [] }, reuniao);
  t("marcador [[NAO_ENVIAR]] → silêncio", marcador.silencio);
  const fala = prepararRespostaDaRemarcacao({ message: ["Tudo bem!", "Tenho terça ou quarta."], should_send_message: true, actions: [] }, reuniao);
  t("oferta de horário sai normal", !fala.silencio && fala.message.length === 2);
  const so = prepararRespostaDaRemarcacao(
    { message: "", should_send_message: false, actions: [{ type: "reschedule_appointment", start_time: "2026-10-16T15:00:00-04:00" }] },
    reuniao,
  );
  t("remarcou sem texto → confirmação mínima, nunca silêncio", !so.silencio && so.message[0] === "Pronto, remarquei sua reunião.");
}

// ── 7. Rótulo de data (fuso da conta, com e sem horário de verão) ───────────
console.log("7. rótulo da reunião");
t("quinta-feira, 15/10 às 19:00", rotuloReuniao("2026-10-15T19:00:00-04:00", "America/New_York") === "quinta-feira, 15/10 às 19:00", rotuloReuniao("2026-10-15T19:00:00-04:00", "America/New_York"));
t("depois do fim do horário de verão (05/11)", rotuloReuniao("2026-11-05T20:00:00Z", "America/New_York") === "quinta-feira, 05/11 às 15:00", rotuloReuniao("2026-11-05T20:00:00Z", "America/New_York"));

// ── 8. Última saída humana (mesmo classificador do F52) ─────────────────────
console.log("8. última saída humana");
{
  const msgs = [
    { id: "m1", direction: "outbound", messageType: "TYPE_WHATSAPP", body: "Oi, aqui é o Marcos", userId: "u1", dateAdded: "2026-10-10T12:00:00Z" },
    { id: "m2", direction: "outbound", messageType: "TYPE_WHATSAPP", body: "Lembrete: sua reunião é quinta", source: "workflow", dateAdded: "2026-10-11T12:00:00Z" },
    { id: "m3", direction: "outbound", messageType: "TYPE_WHATSAPP", body: "Tenho terça ou quarta", dateAdded: "2026-10-12T12:00:00Z" },
    { id: "m4", direction: "outbound", messageType: "TYPE_ACTIVITY_OPPORTUNITY", body: "Opportunity created", userId: "u1", dateAdded: "2026-10-12T13:00:00Z" },
    { id: "m5", direction: "inbound", messageType: "TYPE_WHATSAPP", body: "ok", dateAdded: "2026-10-12T13:30:00Z" },
  ];
  const em = ultimaSaidaHumanaEm(msgs, { textos: ["Tenho terça ou quarta"], ids: ["m3"] });
  t("pula a IA (id), a automação e a atividade do CRM; acha o humano", em === "2026-10-10T12:00:00Z", String(em));
  t("sem humano → null", ultimaSaidaHumanaEm(msgs.slice(1), { textos: ["Tenho terça ou quarta"], ids: ["m3"] }) === null);
}

// ── 9. Prompt ────────────────────────────────────────────────────────────────
console.log("9. prompt");
{
  const config = {
    data_fields: [],
    objective: "qualification_and_booking",
    calendar_id: "cal-bruna",
    personality: { name: "Bruna" },
    post_booking: { behavior: "continue_until_appointment", allow_reschedule: true },
  } as unknown as AgentConfig;
  const base = {
    config,
    agentType: "sales_agent" as const,
    contactName: "Gabi",
    collectedData: {},
    locationName: "Alves Cury Financial",
    currentDate: "12/10/2026 11:00",
    timezone: "America/New_York",
    priorTurnCount: 8,
  };
  const modo = { via: "pedido" as const, tipo: "remarcar" as const, reuniao, rotulo: "quinta-feira, 15/10 às 19:00", fuso: "horário do leste" };
  const sysSem = buildSystemPrompt(base);
  const sysCom = buildSystemPrompt({ ...base, modoRemarcacao: modo });
  t("sem o modo, o formato segue exigindo resposta", sysSem.includes('"should_send_message": SEMPRE true') && !sysSem.includes("MODO REMARCAÇÃO"));
  t("com o modo, a regra de silêncio troca", sysCom.includes("NESTE TURNO você está no MODO REMARCAÇÃO") && !sysCom.includes('"should_send_message": SEMPRE true'));
  t("com o modo, a regra 3 em diante fica igual", sysCom.slice(sysCom.indexOf('3. "actions":')) === sysSem.slice(sysSem.indexOf('3. "actions":')));
  t("com o modo, o que vem antes do formato fica igual", sysCom.slice(0, sysCom.indexOf("REGRAS DO JSON:")) === sysSem.slice(0, sysSem.indexOf("REGRAS DO JSON:")));
  const rtSem = buildRuntimeContext(base);
  const rtCom = buildRuntimeContext({ ...base, modoRemarcacao: modo });
  t("runtime sem o modo não muda", !rtSem.includes("MODO REMARCAÇÃO"));
  t("runtime com o modo termina com a seção", rtCom.trimEnd().endsWith(secaoModoRemarcacao(modo).trimEnd()));
  t("a seção traz o appointment_id e proíbe book", secaoModoRemarcacao(modo).includes(reuniao.id) && secaoModoRemarcacao(modo).includes("NUNCA use book_appointment"));
  t("sem travessão no texto novo", !/[—–]/.test(secaoModoRemarcacao(modo)));
}

console.log(`\nRESULTADO: ${ok} ok, ${fail} falhas`);
process.exit(fail ? 1 : 0);
