// Teste do followup-repeat-guard — replay dos casos REAIS de produção
// (Cleidmar/Joe/Marcos Ciprian 26-27/08 + Lucy 08-09/08). Regra H85: detector
// só está pronto depois de rodar contra o corpus real.
// Rodar: npx tsx scripts/test-followup-repeat-guard.ts
import {
  isRepeatedAsk,
  extractAsks,
  agentLinesFromHistory,
  turnRepeatVerdict,
  stripRepeatedAsks,
} from "@/lib/queue/followup-repeat-guard";

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

console.log("— turnRepeatVerdict (repetição DENTRO da conversa — juiz venda-evasiva) —");
{
  // Replay da conversa reprovada: estado perguntado nos turnos 1 e 2, candidato repete no 3.
  const prior = [
    "Oi, tudo bem? Vi que você se interessou em saber mais sobre proteção financeira.\nQue ótimo que você chegou até a gente! Me conta, você mora em qual estado?",
    "Atendemos brasileiros nos EUA que querem proteger a família ou construir algo para o futuro.\nVocê mora em qual estado?",
  ];
  const v3rd = turnRepeatVerdict("O processo é rápido. Você mora em qual estado?", prior);
  caso("3ª ocorrência flagada", v3rd.repeated, true, `occ=${v3rd.occurrences}`);
  // 2ª ocorrência (1 refeita) é PERMITIDA:
  const v2nd = turnRepeatVerdict("Você mora em qual estado?", [prior[0]]);
  caso("2ª ocorrência (refeita 1x) permitida", v2nd.repeated, false);
  // pergunta nova no 3º turno passa:
  const vNova = turnRepeatVerdict("E o que você faz hoje de trabalho?", prior);
  caso("pergunta nova no 3º turno passa", vNova.repeated, false);
  // strip preserva a parte que responde e corta a re-pergunta:
  const s = stripRepeatedAsks(["O processo é bem rápido, em uns 30 minutos você entende tudo.", "Você mora em qual estado?"], prior);
  caso("strip corta só a re-pergunta", s.stripped && s.messages.length === 1 && /processo/.test(s.messages[0]), true, JSON.stringify(s.messages));
}

console.log("— elipse do PT (re-teste 31/08: 'Você mora em qual?' furava a contagem) —");
{
  const prior = [
    "Oi, tudo bem? Vi que você se interessou em saber mais sobre proteção financeira.\nÓtimo que você chegou até aqui! Me conta, você mora em qual estado?",
    "Sim, atendemos em vários estados aqui nos EUA.\nVocê mora em qual?",
  ];
  const v = turnRepeatVerdict("O processo é rápido, sem burocracia.\nVocê mora em qual estado?", prior);
  caso("elipse conta como estado (3ª flagada)", v.repeated, true, `occ=${v.occurrences}`);
  const s = stripRepeatedAsks(["O processo é rápido, sem burocracia.", "Você mora em qual estado?"], prior);
  caso("strip remove a 3ª elíptica", s.stripped && s.messages.length === 1, true, JSON.stringify(s.messages));
  // "onde você mora?" também conta:
  const v2 = turnRepeatVerdict("E onde você mora?", prior);
  caso("'onde você mora?' mesma família", v2.repeated, true);
  // frase sem pedido com "mora" NÃO flaga ("muita gente que mora aqui se preocupa com isso"):
  const v3 = turnRepeatVerdict("Muita gente que mora aqui se preocupa exatamente com isso. Faz sentido para você?", prior);
  caso("menção a 'mora' sem pedido de estado não flaga", v3.repeated, false, v3.via);
  // "Faz sentido?" NÃO pode colidir com a família trabalho ("o que você faz hoje?"):
  const priorTrab = ["E o que você faz hoje de trabalho?", "Me conta, você trabalha com o quê?"];
  const v4 = turnRepeatVerdict("Faz sentido para você seguir por esse caminho?", priorTrab);
  caso("'faz sentido?' não colide com trabalho", v4.repeated, false, v4.via);
  const v5 = turnRepeatVerdict("E hoje, o que você faz?", priorTrab);
  caso("3ª pergunta de trabalho ainda flaga", v5.repeated, true, `occ=${v5.occurrences}`);
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
