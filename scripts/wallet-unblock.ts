/**
 * Desbloqueio manual de wallet (H60, 2026-08-01).
 *
 * Usa o clearWalletBlock REAL (não SQL cru) de propósito: além de limpar
 * wallet_blocked_at, ele reseta o CAS do auto-drain, emite o signal 💚 e
 * re-enfileira os inbounds de lead engolidos durante o bloqueio (com os guards
 * do MC-4: pula conversa que humano já atendeu / que a IA já respondeu).
 *
 * Quando usar: location travada cujo débito está DENTRO da carência (H60) —
 * ex: bloqueio nasceu antes da carência existir — ou location presa sem
 * nenhum record pendente (sem pendência, o cron de retry nunca tem o que
 * cobrar ali e o desbloqueio automático não tem gatilho).
 *
 * Rodar: npx tsx scripts/wallet-unblock.ts <locationId> [<locationId> ...]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

async function main() {
  const ids = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  if (ids.length === 0) {
    console.error("Uso: npx tsx scripts/wallet-unblock.ts <locationId> [...]");
    process.exit(1);
  }
  const { clearWalletBlock } = await import("../src/lib/billing/wallet-block");
  const { createAdminClient } = await import("../src/lib/supabase/admin");
  const supabase = createAdminClient();

  for (const id of ids) {
    const { data: before } = await supabase
      .from("locations")
      .select("wallet_blocked_at")
      .eq("location_id", id)
      .maybeSingle();
    if (!before?.wallet_blocked_at) {
      console.log(`- ${id}: já estava desbloqueada, nada a fazer.`);
      continue;
    }
    await clearWalletBlock(id);
    const { data: after } = await supabase
      .from("locations")
      .select("wallet_blocked_at")
      .eq("location_id", id)
      .maybeSingle();
    console.log(
      after?.wallet_blocked_at
        ? `❌ ${id}: AINDA bloqueada (ver logs)`
        : `✅ ${id}: desbloqueada (estava desde ${before.wallet_blocked_at})`,
    );
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
