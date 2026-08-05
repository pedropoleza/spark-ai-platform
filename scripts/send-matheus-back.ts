/**
 * One-off (Pedro autorizou 2026-06-18): avisa o Matheus (rep +17325278816) que o
 * SparkBot voltou, depois do fix do loop de termos (tap templateButtonReplyMessage
 * descartado → terms_accepted_at gravado na mão + parser corrigido em e3acdf4).
 *
 * Uso: WHATSAPP_DELIVERY_ENABLED=1 STEVO_SEND_ENABLED=1 \
 *      npx tsx -r tsconfig-paths/register scripts/send-matheus-back.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const PHONE = "+17325278816";
const MSG =
  "Oi Matheus! 👋 Aqui é o SparkBot. Mais cedo deu um probleminha técnico no aceite " +
  "dos termos e por isso eu fiquei reenviando aquela mesma mensagem, desculpa! Já tá " +
  "resolvido e eu tô de volta, pronto pra te ajudar. Pode mandar de novo o que você " +
  "precisa (tipo aquele apontamento de Zoom com o Sebastião) que eu cuido. 🚀";

async function main() {
  const supabase = createAdminClient();
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, last_inbound_at, display_name")
    .eq("phone", PHONE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rep) throw new Error("rep não encontrado: " + PHONE);

  console.log(`→ ${rep.display_name} (${rep.phone}) loc=${rep.active_location_id}`);
  const res = await deliverProactiveMessage(
    { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
    MSG,
    {
      activeLocationId: rep.active_location_id,
      source: "manual_recovery",
      kind: "back_online",
      extraMetadata: { reason: "terms_loop_fix_templateButtonReplyMessage", by: "pedro_authorized_2026-06-18" },
    },
  );
  console.log("resultado:", JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
