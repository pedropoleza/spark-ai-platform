/**
 * Extensão do áudio a partir do mime (fix prod 2026-09-09, áudios da Raquel).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-audio-ext.ts
 *
 * O Whisper valida o CONTAINER contra a extensão do arquivo. `audio/mp4` é
 * MPEG-4 SÓ-ÁUDIO (= .m4a, o que o WhatsApp manda); mandá-lo como `.mp4`, que
 * é contêiner de vídeo, faz a API recusar com "Invalid file format" — mesmo
 * com mp4 na lista de suportados dela. Falha ficou 3 dias em prod.
 */
import { getExtensionFromMime } from "@/lib/ai/audio-transcriber";

let pass = 0, fail = 0;
function eq(nome: string, got: string, esperado: string) {
  const ok = got === esperado;
  console.log(`${ok ? "✅" : "❌"} ${nome}: "${got}"${ok ? "" : ` (esperado "${esperado}")`}`);
  ok ? pass++ : fail++;
}

console.log("=== mime → extensão ===");
// O caso do bug: mime que o WhatsApp/iOS manda em nota de voz .m4a
eq("audio/mp4 → m4a (o bug de 09/09)", getExtensionFromMime("audio/mp4"), "m4a");
eq("audio/m4a → m4a", getExtensionFromMime("audio/m4a"), "m4a");
eq("audio/x-m4a → m4a", getExtensionFromMime("audio/x-m4a"), "m4a");
// video/mp4 continua mp4 — lá o contêiner é de vídeo de verdade
eq("video/mp4 → mp4 (NÃO pode virar m4a)", getExtensionFromMime("video/mp4"), "mp4");
// os do WhatsApp Android
eq("audio/ogg → ogg", getExtensionFromMime("audio/ogg"), "ogg");
eq("audio/ogg; codecs=opus → ogg (param ignorado)", getExtensionFromMime("audio/ogg; codecs=opus"), "ogg");
eq("AUDIO/MP4 maiúsculo → m4a", getExtensionFromMime("AUDIO/MP4"), "m4a");
eq("mime desconhecido → vazio", getExtensionFromMime("application/octet-stream"), "");

console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
