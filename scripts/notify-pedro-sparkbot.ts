/**
 * Notifica o Pedro (rep +17867717077, interno) via SparkBot/WhatsApp — usado pelo
 * loop de health check (scheduled task marina-agente-healthcheck) pra mandar o
 * veredito/alertas a cada run. Pedro pediu isso explicitamente (2026-06-18).
 *
 * SEGURANÇA: envia SÓ pro número do Pedro (hardcoded). Nunca itera leads/clientes.
 *
 * Mensagem (precedência): argv[2] = caminho de arquivo → lê o arquivo;
 *   senão env NOTIFY_MSG; senão um aviso default.
 *
 * Uso (precisa das flags de envio):
 *   WHATSAPP_DELIVERY_ENABLED=1 STEVO_SEND_ENABLED=1 \
 *     npx tsx -r tsconfig-paths/register scripts/notify-pedro-sparkbot.ts /tmp/msg.txt
 */
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync } from "fs";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const PEDRO_PHONE = "+17867717077"; // hardcoded — única pessoa que este script notifica

function resolveMessage(): string {
  const fileArg = process.argv[2];
  if (fileArg) {
    try { return readFileSync(fileArg, "utf8").trim(); } catch { /* cai pro próximo */ }
  }
  if (process.env.NOTIFY_MSG && process.env.NOTIFY_MSG.trim()) return process.env.NOTIFY_MSG.trim();
  return "🤖 Monitor da Marina: sem mensagem específica (teste de canal).";
}

async function main() {
  const msg = resolveMessage();
  const supabase = createAdminClient();
  const { data: rep, error } = await supabase
    .from("rep_identities")
    .select("id, phone, active_location_id, last_inbound_at, display_name, is_internal")
    .eq("phone", PEDRO_PHONE)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!rep) throw new Error("rep do Pedro não encontrado: " + PEDRO_PHONE);

  console.log(`→ notificando ${rep.display_name} (${rep.phone}) interno=${rep.is_internal} loc=${rep.active_location_id}`);
  const res = await deliverProactiveMessage(
    { id: rep.id, phone: rep.phone, last_inbound_at: rep.last_inbound_at },
    msg,
    {
      activeLocationId: rep.active_location_id,
      source: "health_monitor",
      kind: "marina_healthcheck",
      extraMetadata: { monitor: "marina-agente-healthcheck", by: "pedro_authorized_2026-06-18" },
    },
  );
  console.log("resultado:", JSON.stringify(res));
  // via:'whatsapp' = entregou no WhatsApp; via:'system' = caiu no badge web (sem opt-in WhatsApp)
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
