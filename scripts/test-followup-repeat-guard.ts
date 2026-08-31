// Teste do followup-repeat-guard — replay dos casos REAIS de produção
// (Cleidmar/Joe/Marcos Ciprian 26-27/08 + Lucy 08-09/08). Regra H85: detector
// só está pronto depois de rodar contra o corpus real.
// Rodar: npx tsx scripts/test-followup-repeat-guard.ts
import { isRepeatedAsk, extractAsks, agentLinesFromHistory } from "@/lib/queue/followup-repeat-guard";

let pass = 0;
let fail = 0;
function caso(nome: string, got: boolean, want: boolean, extra?: string) {
  if (got === want) {
    pass++;
    console.log(`  ✅ ${nome}${extra ? ` (${extra})` : ""}`);
  } else {
    fail++;
    console.log(`  ❌ ${nome} — got ${got}, want ${want}${extra ? ` (${extra})` : ""}`);
  }
}

console.log("— caso Cleidmar (estado 3×, 26-27/08) —");
{
  const prior = ["Cleidmar, vi que você demonstrou interesse em proteção financeira por aqui.\nVocê mora em qual estado?"];
  const fu1 = "Cleidmar, você chegou a ver as mensagens sobre proteção financeira? Me conta em qual estado você mora para eu te ajudar melhor.";
  const v1 = isRepeatedAsk(fu1, prior);
  caso("FU1 repete estado", v1.repeated, true, v1.via);
  const fu2 = "Cleidmar, quando tiver um minutinho, me conta em qual estado você está para eu conseguir te ajudar com o seguro de vida.";
  const v2 = isRepeatedAsk(fu2, [...prior, fu1]);
  caso("FU2 repete estado", v2.repeated, true, v2.via);
}

console.log("— caso Marcos Ciprian (espanhol, estado 3×) —");
{
  const prior = ["Marcos, retomando nossa conversa de ontem.\nVocê mencionou que fala espanhol, então vou seguir assim.\n¿En qué estado de los EUA estás viviendo?"];
  const fu1 = "Marcos, en qué estado de los EUA estás viviendo? Con eso puedo avanzar con tu seguro.";
  const v1 = isRepeatedAsk(fu1, prior);
  caso("FU1 ES repete estado", v1.repeated, true, v1.via);
  const fu2 = "Marcos, ¿en qué estado de los EUA estás? Con eso puedo conectarte con el especialista para tu seguro con beneficio en vida.";
  const v2 = isRepeatedAsk(fu2, [...prior, fu1]);
  caso("FU2 ES repete estado", v2.repeated, true, v2.via);
}

console.log("— caso Joe: repetição pega, pivô pra outro ângulo passa —");
{
  const prior = ["Joe, vi que você tinha interesse no seguro com benefício em vida.\nVocê mora em qual estado?"];
  const fu1 = "Joe, você mencionou interesse no seguro com benefício em vida. Em qual estado você mora? Assim consigo te passar as informações certas.";
  caso("FU1 repete estado", isRepeatedAsk(fu1, prior).repeated, true);
  // O FU2 real pivotou pra ligação — ângulo NOVO, não pode ser flagado.
  const fu2 = "Joe, posso te ligar rapidinho para falar sobre o seguro com benefício em vida? Me diz um horário que funciona para você, de tarde ou noite.";
  caso("FU2 pivô não flaga", isRepeatedAsk(fu2, prior).repeated, false);
}

console.log("— caso Lucy (nome 4×, 08-09/08) —");
{
  const prior = [
    "Que bom que chegou até a gente! Esse produto tem feito bastante diferença pra famílias brasileiras aqui nos EUA",
    "Me conta, como posso te chamar?",
  ];
  const fu1 = "Oi Lucy, como vc tá? Vi que se interessou pelo seguro com benefício em vida, como é seu nome completo pra eu já separar as opções certas pra vc?";
  const v1 = isRepeatedAsk(fu1, prior);
  caso("FU1 repete nome", v1.repeated, true, v1.via);
  const fu2 = "Lucy, pra eu montar as opções certas de seguro com benefício em vida pra vc, preciso do seu nome completo. Pode me mandar?";
  caso("FU2 repete nome", isRepeatedAsk(fu2, [...prior, fu1]).repeated, true);
}

console.log("— follow-up das 18:52 re-oferecendo os mesmos horários —");
{
  const prior = [
    "Quem trabalha por conta própria precisa ainda mais de uma proteção bem estruturada, já que não tem os benefícios de uma empresa.\nDeixa eu ver a agenda aqui. Tem hoje às 7 da noite ou amanhã, sexta 28/08, às 2 da tarde, horário do leste. Qual funciona melhor para você?",
  ];
  const fu = "Cleidmar, qual dos dois horários funciona melhor para você: hoje às 7 da noite ou amanhã às 2 da tarde?";
  const v = isRepeatedAsk(fu, prior);
  caso("re-oferta idêntica flaga", v.repeated, true, v.via);
}

console.log("— não-repetições (não pode flagar) —");
{
  const prior = ["Você mora em qual estado?"];
  const v = isRepeatedAsk("E o que você faz hoje, trabalha em qual área?", prior);
  caso("pergunta nova (trabalho) não flaga", v.repeated, false, v.via);
  const v2 = isRepeatedAsk("Sem problema, fico por aqui. Qualquer coisa me chama.", prior);
  caso("sem pergunta não flaga", v2.repeated, false);
  const v3 = isRepeatedAsk("O que te fez buscar proteção financeira agora?", ["Você mora em qual estado?", "E o que você faz hoje?"]);
  caso("gancho novo não flaga", v3.repeated, false, v3.via);
}

console.log("— helpers —");
{
  const hist = "LEAD: Moro nos EUA\nAGENTE: Que bom!\nAGENTE: Você mora em qual estado?\nLEAD: Flórida";
  const lines = agentLinesFromHistory(hist);
  caso("agentLines extrai 2", lines.length === 2, true);
  caso("extractAsks pega imperativo", extractAsks("Me conta em qual estado você mora.").length === 1, true);
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
process.exit(fail > 0 ? 1 : 0);
