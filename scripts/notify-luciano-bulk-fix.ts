/**
 * One-off (Pedro 2026-07-03): SparkBot chama o Luciano pra retomar o envio em massa
 * dos contatos de maio. Contexto: o disparo travava porque o bot montava a lista
 * inteira de uma vez (fix 9e7bb25 — deadline na resolução + quebra em lotes). Falta
 * o TEXTO FINAL da mensagem — o bot pede.
 *
 * Uso: WHATSAPP_DELIVERY_ENABLED=1 STEVO_SEND_ENABLED=1 \
 *      npx tsx -r tsconfig-paths/register scripts/notify-luciano-bulk-fix.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const PHONE = "+19543051116";

const MSG =
  "Opa Luciano! 👋 Voltando ali no envio pros seus contatos de *maio*.\n\n" +
  "Aquilo travou da outra vez porque eu tentei montar a lista inteira de uma vez só. " +
  "Já ajustei isso — agora, se a lista for grande, eu *quebro em lotes menores* " +
  "(por etapa do funil ou por mês) e vou disparando aos poucos, sem engasgar.\n\n" +
  "Pra eu tocar, só me falta *uma coisa*: o *texto final* da mensagem que você quer mandar. " +
  "Você tinha começado com algo assim:\n" +
  "_“Oi [nome], no mês de maio a gente falou sobre o seu planejamento de seguro. Vamos retomar…”_\n\n" +
  "Me manda o texto completo do jeitinho que quer (pode ser por áudio) que eu já monto e disparo. 🚀";

async function main() {
  const supabase = createAdminClient();
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, last_inbound_at, display_name")
    .eq("phone", PHONE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rep) throw new Error("rep não encontrada: " + PHONE);

  console.log(`→ ${rep.display_name} (${rep.phone})`);
  console.log(`mensagem (${MSG.length} chars)`);

  const res = await deliverProactiveMessage(
    { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
    MSG,
    {
      activeLocationId: rep.active_location_id,
      source: "manual_recovery",
      kind: "manual_recovery",
      extraMetadata: { reason: "bulk_send_fix_9e7bb25", by: "pedro_authorized_2026-07-03" },
    },
  );
  console.log("resultado:", JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
