/**
 * Recuperação (2026-07-23): Pedro recarregou a wallet da Marina (A62s5EQj1hldOuvBEowv,
 * estava genuinamente em $0,02). Usa o caminho oficial do H52: clearWalletBlock
 * limpa o bloqueio + emite o sinal 💚 + re-enfileira os leads engolidos (janela
 * ≤24h — a Vania Alves de hoje entra). READ-then-write via a função de prod.
 *
 * Rodar: npx tsx scripts/recover-marina-wallet.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { clearWalletBlock } from "@/lib/billing/wallet-block";
import { createAdminClient } from "@/lib/supabase/admin";

const LOCATION = "A62s5EQj1hldOuvBEowv";

async function main() {
  const supabase = createAdminClient();
  const before = await supabase.from("locations").select("wallet_blocked_at").eq("location_id", LOCATION).maybeSingle();
  console.log("Antes: wallet_blocked_at =", before.data?.wallet_blocked_at);

  await clearWalletBlock(LOCATION);

  const after = await supabase.from("locations").select("wallet_blocked_at").eq("location_id", LOCATION).maybeSingle();
  console.log("Depois: wallet_blocked_at =", after.data?.wallet_blocked_at);

  // Quantos leads foram re-enfileirados (voltaram pra pending no message_queue)?
  const { count } = await supabase
    .from("message_queue")
    .select("id", { count: "exact", head: true })
    .eq("location_id", LOCATION)
    .eq("status", "pending")
    .gte("received_at", new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString());
  console.log(`Leads pending (últimas 25h) na location: ${count ?? "?"}`);
  console.log(after.data?.wallet_blocked_at === null ? "✅ Marina desbloqueada." : "⚠️ ainda bloqueada — checar.");
}

main().then(() => process.exit(0));
