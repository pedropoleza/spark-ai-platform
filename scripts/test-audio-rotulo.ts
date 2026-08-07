/**
 * Caso D — "a IA continua falando que não consegue ouvir áudio" (Márcia, 06/08 15:23).
 *
 * Provado na forense: o áudio CHEGA com URL válida (145 de 146 em 7 dias) e a
 * transcrição funciona (testei 3 áudios reais da conta dela, 3/3 com texto
 * correto em português). O defeito estava no que o modelo LIA: a transcrição era
 * anexada embaixo, e o corpo agregado continuava começando com o rótulo cru
 * "🎤 Mensagem de voz (0:17)". Capturado ao vivo na conversa pqLVt4TltuQZfCLIM04v:
 *   [LEAD] 16:44:59 🎤 Mensagem de voz (0:17)
 *   [IA]   16:45:36 "Não deu pra ouvir seu áudio..."
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-audio-rotulo.ts
 */
import { substituirRotuloDeAudio } from "@/lib/queue/queue-processor";

const TRANSCRICAO = "[Áudio do contato, transcrito] Oi, eu queria saber se dá pra remarcar pra sexta.";
const FALHA = "[O contato mandou um áudio que eu não consegui abrir. Peça com naturalidade pra ele repetir por escrito ou reenviar o áudio.]";

let falhas = 0;
function checa(nome: string, cond: boolean, detalhe = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
}

console.log("1) Rótulo sozinho (o caso real da Márcia)");
{
  const antes = "🎤 Mensagem de voz (0:17)";
  const depois = substituirRotuloDeAudio(antes, antes, TRANSCRICAO);
  console.log(`   antes:  ${antes}`);
  console.log(`   depois: ${depois}`);
  checa("o rótulo some", !/Mensagem de voz/i.test(depois));
  checa("a transcrição entra", depois.includes("remarcar pra sexta"));
}

console.log("\n2) Rótulo junto de texto digitado no mesmo turno");
{
  const antes = "boa tarde\n🎤 Mensagem de voz (0:08)";
  const depois = substituirRotuloDeAudio(antes, "🎤 Mensagem de voz (0:08)", TRANSCRICAO);
  console.log(`   depois: ${depois.replace(/\n/g, " | ")}`);
  checa("preserva o texto digitado", depois.includes("boa tarde"));
  checa("o rótulo some", !/Mensagem de voz/i.test(depois));
}

console.log("\n3) Dois áudios no mesmo turno — cada um troca o SEU rótulo");
{
  let corpo = "🎤 Mensagem de voz (0:08)\n🎤 Mensagem de voz (0:21)";
  corpo = substituirRotuloDeAudio(corpo, "🎤 Mensagem de voz (0:08)", "[Áudio 1] primeiro");
  corpo = substituirRotuloDeAudio(corpo, "🎤 Mensagem de voz (0:21)", "[Áudio 2] segundo");
  console.log(`   depois: ${corpo.replace(/\n/g, " | ")}`);
  checa("os dois viraram texto", corpo.includes("primeiro") && corpo.includes("segundo"));
  checa("nenhum rótulo sobrou", !/Mensagem de voz/i.test(corpo));
}

console.log("\n4) Transcrição falhou — a recusa vira explícita e honesta");
{
  const antes = "🎤 Mensagem de voz (0:17)";
  const depois = substituirRotuloDeAudio(antes, antes, FALHA);
  console.log(`   depois: ${depois.slice(0, 80)}...`);
  checa("o modelo é instruído a pedir por escrito", /repetir por escrito/.test(depois));
  checa("o rótulo some", !/Mensagem de voz/i.test(depois));
}

console.log("\n5) Corpo vazio (mensagem só-mídia) — nunca perde a transcrição");
{
  const depois = substituirRotuloDeAudio("", "", TRANSCRICAO);
  checa("anexa mesmo sem rótulo pra casar", depois.includes("remarcar pra sexta"), depois.slice(0, 60));
}

console.log("\n6) Formato antigo em inglês também é coberto");
{
  const antes = "Voice message (0:12)";
  const depois = substituirRotuloDeAudio(antes, "corpo-que-nao-casa", TRANSCRICAO);
  checa("cai no regex do rótulo", !/Voice message/i.test(depois) && depois.includes("remarcar"), depois.slice(0, 70));
}

console.log(`\n${falhas === 0 ? "✅ Todos os cenários OK" : `❌ ${falhas} falha(s)`}`);
process.exit(falhas === 0 ? 0 : 1);
