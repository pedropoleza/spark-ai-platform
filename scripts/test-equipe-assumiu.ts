/**
 * H105 (2026-10-16, ticket #445) — "a equipe assumiu, a IA sai".
 *
 *   npx tsx scripts/test-equipe-assumiu.ts
 *
 * Parte 1 reproduz o incidente com a linha do tempo REAL do Thiago (contato
 * vaGTKuibHHf4gnurDXv0, conta da Jussara): horário, source, userId e id de cada
 * mensagem vieram do Spark Leads; os envios da IA, do execution_log. Em cada
 * ponto de decisão roda o código de produção (`decidirPausaPeloHistorico`) e a
 * regra antiga (copiada aqui só pra provar o furo).
 * Parte 2 cobre as peças uma a uma. Sem rede, sem banco.
 */
import {
  decidirPausaPeloHistorico,
  saidaQueDecide,
  pareceEcoDoEnvio,
  contatoDaEquipe,
  ehSaidaAutomatica,
  classifyLastOutbound,
  extractAiSentTexts,
  extractAiSentIds,
  type MensagemDoHistoricoGhl,
} from "../src/lib/queue/human-takeover";
import { isChatMessageType } from "../src/lib/ghl/message-sources";

let passed = 0;
let failed = 0;
function eq(nome: string, veio: unknown, esperado: unknown) {
  if (veio === esperado) {
    console.log(`  ✓ ${nome}`);
    passed++;
  } else {
    console.log(`  ✗ ${nome} (esperava ${JSON.stringify(esperado)}, veio ${JSON.stringify(veio)})`);
    failed++;
  }
}

type M = MensagemDoHistoricoGhl & { id: string; dateAdded: string };
const JUSSARA = "u-jussara"; // o envio pela API sai com o usuário dono do contato
const THAMIRES = "u-thamires";
const SMS = "TYPE_CUSTOM_SMS";
const inn = (id: string, at: string, body: string): M => ({ id, dateAdded: at, direction: "inbound", body, source: "api", messageType: SMS });
const out = (id: string, at: string, body: string, source: string, userId = "", messageType = SMS): M => ({ id, dateAdded: at, direction: "outbound", body, source, userId, messageType });

// ── Conversa Mjjk4w6ZSDE0sRYhkQgQ (Spark Leads), em ordem ──────────────────────
const HIST: M[] = [
  out("act-opp", "2026-06-19T20:02:40Z", "Opportunity created", "app", "", "TYPE_ACTIVITY_OPPORTUNITY"),
  inn("TEUqVzGKs5KnaITjU3cZ", "2026-10-15T22:48:19Z", "Olá! Tenho interesse e queria mais informações, por favor."),
  inn("nkCl4pHPsBd4rehthqrs", "2026-10-15T22:48:25Z", "Precisamos finalizar o meu"),
  out("wf-oie", "2026-10-15T22:49:22Z", "Oiê 😊 Aqui é a Jussara Lima, Agente Financeira Licenciada", "workflow", JUSSARA),
  out("xND55NseYXRKUJS0dxhG", "2026-10-15T22:49:37Z", "Finalizar o seu quê? 😊", "api", JUSSARA),
  out("ihkDC5O2QYnHYkJ7s5hr", "2026-10-15T22:49:39Z", "Me conta mais, vc tinha começado a digitar algo", "api", JUSSARA),
  out("wf-menu", "2026-10-15T22:49:39Z", "Qual destes assuntos despertou seu interesse? 1️⃣ Seguro de Vida", "workflow", JUSSARA),
  out("call-thamires", "2026-10-15T22:50:02Z", "", "app", THAMIRES, "TYPE_CALL"),
  out("ficha-thamires", "2026-10-15T22:52:31Z", "1️⃣Nome: 2️⃣Data de nascimento: 3️⃣Estado que você mora: Sobre saúde: 4️⃣Você fuma?", "api", THAMIRES),
  out("act-appt", "2026-10-15T22:53:00Z", "Apresentação com Thiago ", "app", "", "TYPE_ACTIVITY_APPOINTMENT"),
  out("wf-agendada", "2026-10-15T22:53:04Z", "Olá, Thiago ! Sua reunião foi agendada com sucesso!", "workflow", JUSSARA),
  out("wf-video", "2026-10-15T22:53:05Z", "Oi! 😊 Se puder, assista esse vídeo antes da nossa reunião.", "workflow", JUSSARA),
  out("wf-arquivo", "2026-10-15T22:53:06Z", "", "workflow", JUSSARA),
  inn("jYvKsve1oQKWplafSfgX", "2026-10-15T23:03:03Z", "1"),
  out("Q3lCUtyD7NEJRV2GjzYD", "2026-10-15T23:03:35Z", "Ótima escolha 😊 o seguro de vida aqui nos EUA é bem diferente do que a maioria imagina", "api", JUSSARA),
  out("SFlYuz7jhuxdkTzSjNp6", "2026-10-15T23:03:39Z", "Pra eu preparar uma simulação certinha pro seu caso, me fala: qual estado vc mora?", "api", JUSSARA),
  inn("C39MjDao2ixDo62VHq6G", "2026-10-15T23:12:20Z", "Thiago Ribeiro 08/24/1991 Flórida Nao fumo Sem doenças"),
  out("ljSkwVngaUlOBeyHTvh7", "2026-10-15T23:12:53Z", "Perfeito, Thiago! anotei tudo 😊", "api", JUSSARA),
  out("jcIYDlnjlSd3QmxjtYEJ", "2026-10-15T23:12:56Z", "Pra agendar sua consulta, tenho esses horários disponíveis: sexta, 16/10, às 1 PM ET", "api", JUSSARA),
  // equipe pelo CELULAR: o Spark OS espelha como saída `api` SEM userId
  out("cel-perfeito", "2026-10-15T23:13:31Z", "Perfeito!!", "api"),
  out("cel-obrigada", "2026-10-15T23:13:32Z", "Muito obrigada!", "api"),
  out("cel-ate-amanha", "2026-10-15T23:13:35Z", "Até amanhã", "api"),
  inn("gA1ktdrY9ETmEvG7GEzb", "2026-10-16T00:11:01Z", "Flórida"),
  out("PYeJNy23yAo90YRsikN4", "2026-10-16T00:11:31Z", "Já vi que vc mora na Flórida, tudo certo 😊", "api", JUSSARA),
  out("DhL5Zs2Pk5fE80DKQ27j", "2026-10-16T00:11:33Z", "Só me diz: prefere sexta, 16/10, às 1 PM ET ou segunda, 19/10, às 9 AM ET?", "api", JUSSARA),
  out("cel-desconsiderar", "2026-10-16T00:11:34Z", "Pode desconsiderar essas mensagens", "api"),
  out("cel-robo", "2026-10-16T00:11:48Z", "Elas estão sendo mandadas pelo robô", "api"),
  out("cel-agendado", "2026-10-16T00:12:00Z", "Vc já está agendado já", "api"),
  inn("RfUHJqaLK6z7QNUJRwQD", "2026-10-16T00:12:07Z", "Sim amanhã"),
  out("cel-boa-viagem", "2026-10-16T00:12:52Z", "Boa viagem!!", "api"),
  inn("CAKoZW4QnPaB7Mz5I9Dj", "2026-10-16T00:13:05Z", "Até amanhã"),
  out("guJMxkvzXrAw46EMHIqt", "2026-10-16T00:14:06Z", "😊🙏", "api", JUSSARA),
  out("WdsMKF1XKKpmT01f6jJF", "2026-10-16T12:02:28Z", "Oi Thiago! Tudo bem por aí? Posso te mandar uma cotação hoje?", "api", JUSSARA),
  out("cel-thamires-1", "2026-10-16T13:09:45Z", "Thiago, bom dia! Tudo bem? Aq quem fala é Thamires, assistente da Jussara. Você consegue manter a reunião hoje, às 12pm?", "api"),
  out("cel-thamires-2", "2026-10-16T13:10:20Z", "Eu não sei por que o robô te mandou essa mensagem. Vou entrar em contato com o suporte, mas esta tudo certo pra nossa reunião 12pm", "api"),
  out("wf-zoom-1h", "2026-10-16T15:00:10Z", "Thiago, em 1h a gente fala: 12:00 PM.", "workflow", JUSSARA),
];

// ── execution_log send_message do contato (texto + message_ids) ────────────────
const ENVIOS = [
  { created_at: "2026-10-15T22:49:39Z", action_payload: { message: ["Finalizar o seu quê? 😊", "Me conta mais, vc tinha começado a digitar algo"], message_ids: ["xND55NseYXRKUJS0dxhG", "ihkDC5O2QYnHYkJ7s5hr"] } },
  { created_at: "2026-10-15T23:03:39Z", action_payload: { message: ["Ótima escolha 😊 o seguro de vida aqui nos EUA é bem diferente do que a maioria imagina", "Pra eu preparar uma simulação certinha pro seu caso, me fala: qual estado vc mora?"], message_ids: ["Q3lCUtyD7NEJRV2GjzYD", "SFlYuz7jhuxdkTzSjNp6"] } },
  { created_at: "2026-10-15T23:12:57Z", action_payload: { message: ["Perfeito, Thiago! anotei tudo 😊", "Pra agendar sua consulta, tenho esses horários disponíveis: sexta, 16/10, às 1 PM ET"], message_ids: ["ljSkwVngaUlOBeyHTvh7", "jcIYDlnjlSd3QmxjtYEJ"] } },
  { created_at: "2026-10-16T00:11:33Z", action_payload: { message: ["Já vi que vc mora na Flórida, tudo certo 😊", "Só me diz: prefere sexta, 16/10, às 1 PM ET ou segunda, 19/10, às 9 AM ET?"], message_ids: ["PYeJNy23yAo90YRsikN4", "DhL5Zs2Pk5fE80DKQ27j"] } },
  { created_at: "2026-10-16T00:14:06Z", action_payload: { message: ["😊🙏"], message_ids: ["guJMxkvzXrAw46EMHIqt"] } },
  { created_at: "2026-10-16T12:02:28Z", action_payload: { message: ["Oi Thiago! Tudo bem por aí? Posso te mandar uma cotação hoje?"], message_ids: ["WdsMKF1XKKpmT01f6jJF"], source: "follow_up" } },
];

/** O que existia no instante T (histórico e log), do jeito que o processor lê. */
function naHora(t: string) {
  const ms = Date.parse(t);
  return {
    mensagens: HIST.filter((m) => Date.parse(m.dateAdded) < ms),
    enviosDaIa: ENVIOS.filter((e) => Date.parse(e.created_at) < ms).reverse(),
    agoraMs: ms,
  };
}

/** A regra que rodava até 16/10 (última saída de chat + eco por tempo), só pra provar o furo. */
function decidiaAntes(t: string): boolean {
  const { mensagens, enviosDaIa, agoraMs } = naHora(t);
  const ultima = [...mensagens]
    .sort((a, b) => Date.parse(b.dateAdded) - Date.parse(a.dateAdded))
    .find((m) => m.direction === "outbound" && isChatMessageType(m.messageType));
  if (!ultima) return false;
  const { isHuman } = classifyLastOutbound({ lastOutbound: ultima, aiTexts: extractAiSentTexts(enviosDaIa), sentIds: extractAiSentIds(enviosDaIa) });
  const ultimoEnvio = enviosDaIa[0] ? Date.parse(enviosDaIa[0].created_at) : 0;
  const delta = Date.parse(ultima.dateAdded) - ultimoEnvio;
  const eco = ultimoEnvio > 0 && delta <= 120_000 && delta >= -5_000;
  const velho = agoraMs - Date.parse(ultima.dateAdded) > 72 * 3600_000;
  return isHuman && !eco && !velho;
}

function decideAgora(t: string, estrito = false) {
  return decidirPausaPeloHistorico({ ...naHora(t), autoPause: true, estrito, retomadaManualEmMs: 0 });
}

console.log("\n=== Parte 1: o incidente do Thiago, decisão por decisão ===");

console.log("\n15/10 22:49, 1º turno (o anúncio acabou de chegar):");
eq("antes: IA responde", decidiaAntes("2026-10-15T22:49:30Z"), false);
eq("agora: IA responde (lead do patrocinado, ninguém da equipe falou)", decideAgora("2026-10-15T22:49:30Z").motivo, null);
eq("modo estrito: IA responde também", decideAgora("2026-10-15T22:49:30Z", true).motivo, null);

console.log("\n15/10 23:03, lead manda \"1\" (a Thamires já ligou, mandou a ficha e marcou):");
eq("antes: o fluxo de confirmação escondia a Thamires → IA respondia", decidiaAntes("2026-10-15T23:03:24Z"), false);
eq("agora: a saída que decide é a ficha da Thamires", saidaQueDecide(naHora("2026-10-15T23:03:24Z").mensagens)?.id, "ficha-thamires");
eq("agora: pausa (F52)", decideAgora("2026-10-15T23:03:24Z").motivo, "auto_pause:human_message:history");
eq("modo estrito: pausa por contato da equipe", decideAgora("2026-10-15T23:03:24Z", true).motivo, "auto_pause:human_message:team_contact");
eq("modo estrito: o contato mais recente é a ficha", decideAgora("2026-10-15T23:03:24Z", true).detalhe.team_contact_at, "2026-10-15T22:52:31Z");

console.log("\n16/10 00:11, lead manda \"Flórida\" (a Thamires escreveu pelo celular 38s depois da IA):");
eq("antes: \"Até amanhã\" passava por eco da IA → IA respondia", decidiaAntes("2026-10-16T00:11:22Z"), false);
eq("agora: pausa (id diferente dos que a IA gravou não é eco)", decideAgora("2026-10-16T00:11:22Z").motivo, "auto_pause:human_message:history");

console.log("\n16/10 00:13, depois do \"pode desconsiderar, são do robô\":");
eq("antes: \"Boa viagem!!\" (79s depois da IA) passava por eco → IA respondia", decidiaAntes("2026-10-16T00:12:58Z"), false);
eq("agora: pausa", decideAgora("2026-10-16T00:12:58Z").motivo, "auto_pause:human_message:history");

console.log("\n16/10 15:02, 2º follow-up (lembrete do Zoom às 15:00 depois da Thamires):");
eq("antes: o lembrete escondia o \"não sei por que o robô te mandou\"", decidiaAntes("2026-10-16T15:02:43Z"), false);
eq("agora: a saída que decide é a Thamires das 13:10", saidaQueDecide(naHora("2026-10-16T15:02:43Z").mensagens)?.id, "cel-thamires-2");
eq("agora: humano", decideAgora("2026-10-16T15:02:43Z").motivo, "auto_pause:human_message:history");

console.log("\n=== Parte 2: peças ===");

console.log("\nehSaidaAutomatica:");
eq("workflow", ehSaidaAutomatica(out("a", "2026-10-15T22:00:00Z", "oi", "workflow", "u")), true);
eq("campanha (case-insensitive)", ehSaidaAutomatica(out("a", "2026-10-15T22:00:00Z", "oi", "Campaign")), true);
eq("merge field quebrado", ehSaidaAutomatica(out("a", "2026-10-15T22:00:00Z", "Oi Nome do Cliente, tudo bem?", "api", "u")), true);
eq("mídia nossa (±10min)", ehSaidaAutomatica(out("a", "2026-10-15T22:00:00Z", "", "api", "u"), ["2026-10-15T21:55:00Z"]), true);
eq("mensagem da equipe pelo celular", ehSaidaAutomatica(out("a", "2026-10-15T22:00:00Z", "Até amanhã", "api")), false);
eq("áudio da equipe (sem automação nossa perto)", ehSaidaAutomatica(out("a", "2026-10-15T22:00:00Z", "", "api")), false);

console.log("\nsaidaQueDecide:");
eq("só automação → nenhuma", saidaQueDecide([out("w", "2026-10-15T22:00:00Z", "Bem-vindo!", "workflow")]), undefined);
eq("atividade e ligação ficam de fora", saidaQueDecide([out("c", "2026-10-15T22:00:00Z", "", "app", "u", "TYPE_CALL"), out("a", "2026-10-15T22:01:00Z", "Opportunity created", "app", "", "TYPE_ACTIVITY_OPPORTUNITY")]), undefined);
eq("IA depois da equipe → decide a IA", saidaQueDecide([out("h", "2026-10-15T22:00:00Z", "deixa comigo", "api"), out("ia", "2026-10-15T22:05:00Z", "Perfeito!", "api", JUSSARA), out("w", "2026-10-15T22:06:00Z", "Lembrete", "workflow")])?.id, "ia");
eq("inbound não conta", saidaQueDecide([inn("i", "2026-10-15T22:00:00Z", "oi")]), undefined);

console.log("\npareceEcoDoEnvio:");
const envio = Date.parse("2026-10-15T23:12:57Z");
eq("texto, id desconhecido, ids do envio no log → NÃO é eco", pareceEcoDoEnvio({ saida: { id: "x", body: "Até amanhã", dateAdded: "2026-10-15T23:13:35Z" }, ultimoEnvioEmMs: envio, idsDoUltimoEnvio: ["ljSkwVngaUlOBeyHTvh7"] }), false);
eq("texto, mas o envio não gravou ids → presume eco (como antes)", pareceEcoDoEnvio({ saida: { id: "x", body: "Até amanhã", dateAdded: "2026-10-15T23:13:35Z" }, ultimoEnvioEmMs: envio, idsDoUltimoEnvio: [] }), true);
eq("sem texto (mídia) → presume eco (como antes)", pareceEcoDoEnvio({ saida: { id: "x", body: "", dateAdded: "2026-10-15T23:13:35Z" }, ultimoEnvioEmMs: envio, idsDoUltimoEnvio: ["ljSkwVngaUlOBeyHTvh7"] }), true);
eq("saída sem id → presume eco (como antes)", pareceEcoDoEnvio({ saida: { body: "Até amanhã", dateAdded: "2026-10-15T23:13:35Z" }, ultimoEnvioEmMs: envio, idsDoUltimoEnvio: ["ljSkwVngaUlOBeyHTvh7"] }), true);
eq("fora da janela de 120s → não é eco", pareceEcoDoEnvio({ saida: { id: "x", body: "", dateAdded: "2026-10-15T23:15:00Z" }, ultimoEnvioEmMs: envio, idsDoUltimoEnvio: [] }), false);
eq("sem envio nosso → não é eco", pareceEcoDoEnvio({ saida: { id: "x", body: "", dateAdded: "2026-10-15T23:13:35Z" }, ultimoEnvioEmMs: 0, idsDoUltimoEnvio: [] }), false);

console.log("\ncontatoDaEquipe (modo estrito):");
const ia = { textos: ["Perfeito, Thiago! anotei tudo 😊"], ids: ["ia-1"] };
eq("só fluxo automático → ninguém", contatoDaEquipe([out("w", "2026-10-15T22:00:00Z", "Oiê 😊", "workflow", JUSSARA)], ia), null);
eq("mensagem nossa por id → ninguém", contatoDaEquipe([out("ia-1", "2026-10-15T22:00:00Z", "qualquer", "api", JUSSARA)], ia), null);
eq("mensagem nossa por texto → ninguém", contatoDaEquipe([out("z", "2026-10-15T22:00:00Z", "Perfeito, Thiago! anotei tudo 😊", "api", JUSSARA)], ia), null);
eq("ligação de alguém da equipe → equipe", contatoDaEquipe([out("c", "2026-10-15T22:00:00Z", "", "app", THAMIRES, "TYPE_CALL")], ia)?.id, "c");
eq("ligação sem usuário (automática) → ninguém", contatoDaEquipe([out("c", "2026-10-15T22:00:00Z", "", "app", "", "TYPE_CALL")], ia), null);
eq("atividade do CRM → ninguém", contatoDaEquipe([out("a", "2026-10-15T22:00:00Z", "Apresentação com Thiago", "app", "", "TYPE_ACTIVITY_APPOINTMENT")], ia), null);
eq("celular ANTES de a IA falar → equipe (o F52 não pegava)", contatoDaEquipe([out("h", "2026-10-15T22:00:00Z", "vc clicou em um patrocinado nosso", "api")], { textos: [], ids: [] })?.id, "h");
eq("o F52 nesse mesmo caso: IA nunca falou → não pausa", decidirPausaPeloHistorico({ mensagens: [out("h", "2026-10-15T22:00:00Z", "vc clicou em um patrocinado nosso", "api")], enviosDaIa: [], autoPause: true, estrito: false, retomadaManualEmMs: 0, agoraMs: Date.parse("2026-10-15T22:01:00Z") }).motivo, null);
eq("áudio da equipe pelo celular → equipe", contatoDaEquipe([out("v", "2026-10-15T22:00:00Z", "", "api")], ia)?.id, "v");

console.log("\ndecidirPausaPeloHistorico, guardas:");
const velha = [out("h", "2026-10-01T22:00:00Z", "deixa comigo", "api", THAMIRES)];
const enviosVelhos = [{ created_at: "2026-09-30T22:00:00Z", action_payload: { message: ["oi"], message_ids: ["ia-0"] } }];
eq("F52: humano de 15 dias → não pausa (MC-7)", decidirPausaPeloHistorico({ mensagens: velha, enviosDaIa: enviosVelhos, autoPause: true, estrito: false, retomadaManualEmMs: 0, agoraMs: Date.parse("2026-10-16T22:00:00Z") }).motivo, null);
eq("F52: e avisa que achou humano velho", decidirPausaPeloHistorico({ mensagens: velha, enviosDaIa: enviosVelhos, autoPause: true, estrito: false, retomadaManualEmMs: 0, agoraMs: Date.parse("2026-10-16T22:00:00Z") }).humanoVelhoEm, "2026-10-01T22:00:00Z");
eq("estrito: humano de 15 dias → pausa (o combinado não vence)", decidirPausaPeloHistorico({ mensagens: velha, enviosDaIa: enviosVelhos, autoPause: true, estrito: true, retomadaManualEmMs: 0, agoraMs: Date.parse("2026-10-16T22:00:00Z") }).motivo, "auto_pause:human_message:team_contact");
eq("estrito: religada à mão DEPOIS da equipe → IA fala (GU-6)", decidirPausaPeloHistorico({ mensagens: velha, enviosDaIa: enviosVelhos, autoPause: true, estrito: true, retomadaManualEmMs: Date.parse("2026-10-02T10:00:00Z"), agoraMs: Date.parse("2026-10-16T22:00:00Z") }).motivo, null);
eq("estrito sem auto-pause: ainda pausa por equipe", decidirPausaPeloHistorico({ mensagens: velha, enviosDaIa: enviosVelhos, autoPause: false, estrito: true, retomadaManualEmMs: 0, agoraMs: Date.parse("2026-10-16T22:00:00Z") }).gatilho, "H105_team_contact");
eq("tudo desligado → nunca pausa", decidirPausaPeloHistorico({ mensagens: velha, enviosDaIa: enviosVelhos, autoPause: false, estrito: false, retomadaManualEmMs: 0, agoraMs: Date.parse("2026-10-02T22:00:00Z") }).motivo, null);
eq("2ª parte do envio da IA logo depois da 1ª (id bate) → não pausa", decidirPausaPeloHistorico({ ...naHora("2026-10-15T23:12:58Z"), autoPause: true, estrito: false, retomadaManualEmMs: 0 }).motivo, null);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
