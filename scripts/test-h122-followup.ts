/**
 * H122: nota interna fora do chat; follow-up enxerga todas as bolhas; toque não re-oferece dia+hora.
 * Rodar: npx tsx scripts/test-h122-followup.ts
 */
import { agentLinesFromHistory, isRepeatedAsk, toqueOfereceHorario } from "@/lib/queue/followup-repeat-guard";
import { isChatMessageType } from "@/lib/ghl/message-sources";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, x !== undefined ? JSON.stringify(x) : ""); } };

const hist = "AGENTE: Oi Âna, tudo bem? 😊\n\nVi que você se interessou em saber mais sobre proteção financeira. Me conta, você está em qual estado?";
const linhas = agentLinesFromHistory(hist);
ok("as 2 bolhas da IA viram 1 fala inteira", linhas.length === 1 && linhas[0].includes("qual estado"), linhas);
ok("o toque que repete a pergunta do estado é pego", isRepeatedAsk("Âna, proteção financeira para a família é um assunto que vale dois minutos. Me conta em qual estado você está? 😊", linhas).repeated);
ok("LEAD separa as falas", agentLinesFromHistory("AGENTE: a\nb\nLEAD: oi\nAGENTE: c").length === 2);
ok("re-oferta 'segunda às 7 da noite' é pega", !!toqueOfereceHorario("Lorena, segunda às 7 da noite ou terça às 6 da tarde, qual fica melhor para você?"));
ok("convite sem dia e hora passa", toqueOfereceHorario("Quando ficar bom para você, a gente marca uma conversa rápida com o especialista.") === null);
ok("nota interna não é chat", !isChatMessageType("TYPE_INTERNAL_COMMENT"));
ok("WhatsApp e SMS continuam chat", isChatMessageType("TYPE_WHATSAPP") && isChatMessageType("TYPE_CUSTOM_SMS"));
console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
