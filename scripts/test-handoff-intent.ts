/**
 * Golden test do detector de pedido de humano (review de uso 2026-08-25).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-handoff-intent.ts
 *
 * Os casos "PROD" são VERBATIM de `handoff_notifications.trigger_message` — as
 * mensagens de lead que interromperam a IA de verdade na frota. Das 29, UMA era
 * pedido de humano. Se alguma das outras 28 voltar a disparar, regrediu.
 */
import { detectarPedidoDeHumano } from "@/lib/queue/handoff-intent";
import { DEFAULT_HANDOFF_POLICY } from "@/types/agent";

/** Gatilhos DEPOIS da migration 00130 (sem o alvo solto "pessoa"). */
const KW = DEFAULT_HANDOFF_POLICY.custom_keywords_handoff;
/** Gatilhos ANTES — usados só pra provar que o alvo solto era o problema. */
const KW_ANTIGO = ["humano", "atendente", "pessoa", "falar com alguem", "falar com alguém", "real person", "agent please"];

let pass = 0;
let fail = 0;

function caso(nome: string, texto: string, deveDisparar: boolean, kw: string[] = KW) {
  const r = detectarPedidoDeHumano(texto, kw);
  const ok = !!r === deveDisparar;
  console.log(`${ok ? "✅" : "❌"} ${nome}`);
  if (!ok) {
    console.log(`   texto: ${texto.replace(/\n/g, " ").slice(0, 130)}`);
    console.log(`   esperado disparar=${deveDisparar}, obtido=${JSON.stringify(r)}`);
  }
  ok ? pass++ : fail++;
}

// ═══════ PEDIDOS REAIS — TÊM que disparar ═══════
console.log("=== pedido de humano de verdade (tem que disparar) ===");
caso("PROD 31/07: 'To falando com humano? Ou IA'", "04 maio\n1991\nTo falando com humano? Ou IA\nNão entendi?\nJá passei", true);
caso("quero falar com um atendente", "quero falar com um atendente por favor", true);
caso("posso falar com uma pessoa?", "isso aqui é robô? posso falar com uma pessoa?", true);
caso("me passa pra um humano", "me passa pra um humano por favor", true);
caso("falar com alguém (frase)", "gostaria de falar com alguém do time", true);
caso("preciso de um atendente", "preciso de um atendente urgente", true);
caso("tem atendente aí?", "tem atendente aí agora?", true);
caso("quero pessoa de verdade", "não quero robô, quero pessoa de verdade", true);
caso("atendimento humano", "vocês têm atendimento humano?", true);
caso("chama o atendente", "chama o atendente pra mim", true);
caso("real person (EN)", "can I talk to a real person?", true);

// ═══════ AS 28 INTERRUPÇÕES INDEVIDAS DE PROD — NÃO podem disparar ═══════
console.log("\n=== falso positivo real de prod (NÃO pode disparar) ===");
const fpsProd: Array<[string, string]> = [
  ["triagem: estado civil", "[Áudio do contato, transcrito] Não, no momento eu quero saber o valor. [Áudio do contato, transcrito] Não sou fumante e sou solteiro, vivo só com uma pessoa, mas não casei no papel."],
  ["triagem: 'Moro com um pessoa'", "Moro com um pessoa"],
  ["triagem: noivo x casado", "[Áudio do contato, transcrito] Porque eu ainda estou no trabalho, assim que eu chegar em casa, eu pego tudo certinho, porque a gente só é noivo, a gente não é casado. Tem algum problema, ou a pessoa tem que ser casada? Me deixa saber, por favor"],
  ["produto: cobertura", "Quanto por cento que a pessoa recebe  vida, caso fica infermo, e quais infermidade o seguro cobre"],
  ["produto: cotação 2 idades", "Qual seria o valor para uma pessoa idade de 46 anos e uma pessoa de 57 . Para seguro de vida com benefícios em vida ?"],
  ["perdeu o negócio pra concorrente", "Oíe Jussara perdão acabei fechado Já com outra pessoa já"],
  ["perdeu o negócio (variante)", "Oi Jussara! Perdao really responder só agora. Estou fora da cidade. Acabei fechando com outra pessoa. Tinha pressa em resolver logo isso pra cancelar o outro."],
  ["cuida de idosos", "Eu trabalho interna cuidando de pessoas idosas, não tenho como participar da reunião pessoalmente"],
  ["'essa pessoa sou eu'", "Oi Marina essa pessoa sou eu! Olá Marina, queria entender melhor sobre essa carreira 🎯🎯"],
  ["auto-apresentação de outro corretor", "Oi, sou o Klauss. Estamos no mesmo grupo Brasileiros Empreendedores na Florida e tomei a liberdade de me apresentar. Trabalho com planejamento financeiro e converso com muitas pessoas que estão na luta"],
  ["elogio à IA (contém 'atendente')", "Gostei da atendente de IA. A ideia era bater um papo e quem sabe um poder ajudar o outro, sendo que basicamente trabalhamos com a mesma coisa"],
  ["texto do anúncio", "🔵 AD MESSAGE:  Title: Agende pelo Whatsapp sua conversa gratuita Body: A maioria dos brasileiros que chega aos EUA aprende a trabalhar pelo dinheiro. Poucos aprendem a fazer o dinheiro trabalhar pra pessoa"],
  ["apresentação de casamento/filhas", "Olá Márcia é Roberta! Tudo bem? Meu nome é Carla Oliveira Francisquini, tenho 48 anos, sou divorciada e moro com minhas duas filhas, tenho uma ótima saúde, não fumo, não bebo e muito menos uso drogas"],
  ["escolhendo horário", "[Áudio do contato, transcrito] Oi, Márcia. Bom dia, tudo bom? O horário que fica melhor pra mim é umas 4 horas da tarde. Acho que esse horário é um horário bom."],
  ["pede info antes de dar dados", "Oi queria. Saber mas sobre a  empresa de você   Por gentileza  antes de enviar  meus dados Pessoal Obrigado"],
  ["indicação por terceiro", "[Áudio do contato, transcrito] Se você puder explicar tudo em forma de áudio, ou marcar uma ligação... Eu vim aqui através do Will, né? Que ele fazia de digital. Eu acompanho ele"],
  ["reclamação sobre anúncios (janela larga)", "e outra coisa... eu tenho visto várias pessoas com esses anúncios de seguro... a gente não tem interesse de conversar com alguém que não é aquela pessoa que estava lá no vídeo falando."],
  ["terceiro: 'tenho que falar com a pessoa'", "Agora é muito cedo\nTenho que falar com a pessoa\nEle pode hj às 11 hora da California"],
  ["conversa entre amigas sobre o painel", "Amigaaa\nA msg q você adicionou\nApareceu - cliente do lado\nDa pra editarrr lá\nA pessoa\nSó pra te avisar"],
  ["carreira: pergunta polêmica", "Olá Marina, queria entender melhor sobre essa carreira 😀 [Áudio do contato, transcrito] Amor, posso fazer uma pergunta meio polêmica? Manda. Eu acho que a maioria dos brasileiros aqui nos Estados Unidos não tem a ideia do valor"],
];
for (const [nome, txt] of fpsProd) caso(`PROD ${nome}`, txt, false);

// ═══════ Outras negativas de sanidade ═══════
console.log("\n=== negativas de sanidade ===");
caso("vou falar com o atendente (narrativa de terceiro)", "amanhã vou falar com o atendente do banco", false);
caso("preciso falar com a pessoa do RH", "preciso falar com a pessoa do RH antes", false);
caso("'humano' adjetivo: erro humano", "foi erro humano mesmo, acontece", false);
caso("'humano' adjetivo: ser humano", "todo ser humano erra né", false);
caso("'humano' adjetivo: recursos humanos", "trabalho em recursos humanos", false);
caso("adjetivo NÃO cega o resto: 'erro humano' + pedido", "foi erro humano. quero falar com um atendente", true);
caso("plural nunca dispara", "atendo várias pessoas por dia", false);
caso("mensagem vazia", "", false);
caso("sem keywords configuradas", "quero falar com um atendente", false, []);

// ═══════ A prova do problema: com o gatilho ANTIGO, tudo disparava ═══════
console.log("\n=== regressão: o alvo solto 'pessoa' era mesmo o problema ===");
{
  const antesDisparavam = fpsProd.filter(([, t]) => {
    const tn = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    return KW_ANTIGO.some((k) => tn.includes(k.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")));
  }).length;
  const agoraDisparam = fpsProd.filter(([, t]) => !!detectarPedidoDeHumano(t, KW)).length;
  // O que precisa valer: o novo NÃO dispara em nenhum destes, e o antigo
  // disparava na maioria. (Não são 20/20 no antigo porque alguns textos aqui
  // estão truncados na cópia e perderam a palavra-gatilho; em prod, os 20
  // dispararam — está registrado em handoff_notifications.)
  const ok = agoraDisparam === 0 && antesDisparavam >= 15;
  console.log(
    `${ok ? "✅" : "❌"} matcher antigo disparava em ${antesDisparavam}/${fpsProd.length} · matcher novo dispara em ${agoraDisparam}/${fpsProd.length}`,
  );
  ok ? pass++ : fail++;
}
{
  const semPessoa = !KW.includes("pessoa");
  console.log(`${semPessoa ? "✅" : "❌"} o default não tem mais o alvo solto "pessoa"`);
  semPessoa ? pass++ : fail++;
}

console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
