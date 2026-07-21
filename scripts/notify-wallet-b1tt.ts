/**
 * A7 (estudo de custo 2026-07-20): a dona da location b1ttBRVEnm5joFvP2UXO
 * (wallet bloqueada desde 2026-07-17, $29.54 pendentes desde 30/06) NUNCA foi
 * notificada — wallet_block_notified_at está NULL porque o aviso do H52 só
 * dispara no gate lead-facing e a location está MUDA (sem tráfego → gate nunca
 * roda). Dispara o aviso 1x usando a copy aprovada do H52 (recarga na wallet
 * do Spark Leads + suporte).
 *
 * Rodar (em horário comercial!): WHATSAPP_DELIVERY_ENABLED=1 npx tsx scripts/notify-wallet-b1tt.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { notifyWalletBlockOwnerOnce } from "../src/lib/billing/wallet-block";
import { createAdminClient } from "../src/lib/supabase/admin";

const LOCATION = "b1ttBRVEnm5joFvP2UXO";

async function main() {
  await notifyWalletBlockOwnerOnce(LOCATION);
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("locations")
    .select("wallet_blocked_at, wallet_block_notified_at")
    .eq("location_id", LOCATION)
    .maybeSingle();
  console.log("Estado pós-notify:", JSON.stringify(data));
  if (!data?.wallet_block_notified_at) {
    console.error("⚠️ wallet_block_notified_at segue NULL — notificação NÃO saiu (checar dona alcançável / opt-in).");
    process.exit(1);
  }
  console.log("✅ Dona da b1tt notificada.");
}

main();
