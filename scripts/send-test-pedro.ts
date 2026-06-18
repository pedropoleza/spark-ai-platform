/**
 * One-off (Pedro autorizou 2026-06-17): smoke test de entrega — manda 1 msg do
 * SparkBot pro WhatsApp do Pedro (rep interno +17867717077) confirmando que a
 * entrega via Stevo + o crédito Anthropic estão de volta.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/send-test-pedro.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const PHONE = "+17867717077";
const MSG =
  "Opa Pedro! 👋 Teste de entrega do SparkBot — se você tá vendo isso aqui no " +
  "WhatsApp, a entrega tá 100%. O crédito da Anthropic voltou e eu já respondi " +
  "no Claude agora há pouco. Tá tudo no ar 🚀";

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
      source: "manual_smoke_test",
      kind: "smoke_test",
      extraMetadata: { reason: "delivery_smoke_after_anthropic_recharge", by: "pedro_authorized_2026-06-17" },
    },
  );
  console.log("resultado:", JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
