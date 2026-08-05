/**
 * H52 (ultra-review 2026-07-17) — notificações de recuperação pós-fix:
 *  - Willian Poubel (rep f99a5868): ficou preso no gate de termos por bug do
 *    parser (~12 aceites ignorados) → destravado na mão + parser corrigido.
 *    Re-engajamento honesto.
 *  - Luciano (rep 34930c4d): blackout de 6d8h por timeout silencioso (10 msgs
 *    engolidas, incl. o go-ahead do disparo) → anti-timeout no ar. Retorno
 *    honesto + convite pra retomar o disparo.
 *
 * Rodar: npx tsx scripts/notify-ur-recovery.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const TARGETS = [
  {
    label: "Willian Poubel",
    rep: { id: "f99a5868-6fd4-44de-897e-337a19b279a8", phone: "+12062096191", last_inbound_at: null },
    locationId: "VKJITQwWwWVRzce0dbSb",
    message:
      "Oi Willian! Aqui é o SparkBot 👋\n\n" +
      "Te devo uma desculpa: você aceitou os termos certinho lá no dia 9 e uma falha NOSSA não registrou — por isso eu fiquei repetindo a mesma mensagem. O bug foi corrigido e teu acesso já tá liberado ✅\n\n" +
      "Pode me pedir o que precisar: nota, lembrete, agenda, busca de contato no Spark Leads... É só mandar (texto ou áudio). 🚀",
  },
  {
    label: "Luciano",
    rep: { id: "34930c4d-1df9-4d4b-a617-04723c37ca02", phone: "+19543051116", last_inbound_at: null },
    locationId: "oEEbKRN0rQHdee13Bn1u",
    message:
      "Oi Luciano! Passando pra te dar um retorno honesto 🙏\n\n" +
      "Entre os dias 10 e 16 eu tive uma falha técnica que engoliu várias mensagens suas — inclusive o \"sim\" do disparo de reativação, que por isso nunca saiu. Não foi nada que você fez: foi bug meu, e ele foi corrigido hoje.\n\n" +
      "Se ainda quiser o disparo pros contatos parados, me manda de novo que eu monto o preview pra você aprovar. E qualquer mensagem que ficar sem resposta, agora eu te aviso em vez de sumir. 👍",
  },
];

async function main() {
  for (const t of TARGETS) {
    try {
      const res = await deliverProactiveMessage(t.rep, t.message, {
        activeLocationId: t.locationId,
        source: "ur_recovery_notification",
        kind: "h52_recovery",
        extraMetadata: { case: "ultra-review-2026-07-17" },
      });
      console.log(`${t.label}: via=${res.via} ok=${res.ok}${res.error ? ` error=${res.error}` : ""}`);
    } catch (err) {
      console.error(`${t.label}: FALHOU`, err instanceof Error ? err.message : err);
    }
  }
}

main();
