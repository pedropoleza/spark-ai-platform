/**
 * One-off (Pedro 2026-07-10): SparkBot chama a Jussara pra retomar o disparo da
 * planilha de triagem (post-mortem H49). Contexto: job 8d622ac4 cancelado (12
 * saíram com texto divergente; 5 pendentes cancelados); Onda 2 deployada
 * (draft persistente + disparo por ids + guarda anti-drift) — fluxo blindado.
 *
 * Uso: WHATSAPP_DELIVERY_ENABLED=1 STEVO_SEND_ENABLED=1 \
 *      npx tsx -r tsconfig-paths/register scripts/notify-jussara-retomada.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { deliverProactiveMessage } from "../src/lib/account-assistant/proactive/whatsapp-delivery";

const PHONE = "+16892033343";

const MSG =
  "Oi Jussara! 👋 Sobre aquela lista de triagem da planilha (do dia 03/07): " +
  "eu tinha travado no meio e *5 pessoas* ficaram sem receber — Ayeska, Barbara, Marta, Edson e Izabella. " +
  "Cancelei esses envios porque o texto não tava exatamente do jeito que você aprovou.\n\n" +
  "Boa notícia: já arrumei o problema do arquivo — *não vou mais pedir a planilha várias vezes* 🙏 " +
  "e agora o texto que você aprovar é EXATAMENTE o que sai.\n\n" +
  "Me manda o *texto final* que você quer (pode ser por áudio) e eu disparo pros 5 que faltaram — " +
  "ou pra lista toda de novo, você que manda. 🚀";

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
      extraMetadata: { reason: "h49_onda2_retomada_planilha", by: "pedro_authorized_2026-07-10", cancelled_job: "8d622ac4-30b0-40ef-b294-103b0ad38e4a" },
    },
  );
  console.log("resultado:", JSON.stringify(res));
  process.exit(res.ok ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
