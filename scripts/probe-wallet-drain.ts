/**
 * PROBE AO VIVO do auto-drain (Pedro 2026-07-27). ⚠️ FAZ COBRANÇAS REAIS na
 * wallet da location alvo — rode DE PROPÓSITO, numa conta que você controla,
 * pra VALIDAR que zerar o residual dispara o auto-recharge do HighLevel ANTES
 * de ligar a flag WALLET_AUTO_DRAIN_ENABLED em prod.
 *
 * O que faz: pega a MENOR cobrança pendente da location (charged_to_wallet=false)
 * e roda attemptWalletDrain — drena o residual em passos e refaz a cobrança real.
 * Se resolver, o auto-recharge do HL disparou e a cobrança fechou (record marcado).
 *
 * Uso (explícito, pra não rodar sem querer):
 *   npx tsx scripts/probe-wallet-drain.ts <LOCATION_ID> --yes
 *
 * Bypassa a flag de propósito (é a ferramenta de validação). Não mexe em bloqueio
 * a menos que resolva (aí limpa via markWalletCharged + clearWalletBlock, igual cron).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { attemptWalletDrain } from "@/lib/billing/charge";
import { markWalletCharged } from "@/lib/repositories/usage-records.repo";
import { clearWalletBlock } from "@/lib/billing/wallet-block";

async function main() {
  const locationId = process.argv[2];
  const confirmed = process.argv.includes("--yes");
  if (!locationId || !confirmed) {
    console.error("Uso: npx tsx scripts/probe-wallet-drain.ts <LOCATION_ID> --yes");
    console.error("⚠️  Faz cobranças REAIS na wallet — só rode numa conta sua, de propósito.");
    process.exit(1);
  }

  const supabase = createAdminClient();
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id, wallet_blocked_at")
    .eq("location_id", locationId)
    .maybeSingle();
  if (!loc?.company_id) {
    console.error(`Location ${locationId} sem company_id.`);
    process.exit(1);
  }
  console.log(`Location ${locationId} · company ${loc.company_id} · bloqueada: ${loc.wallet_blocked_at || "não"}`);

  const { data: rec } = await supabase
    .from("usage_records")
    .select("id, total_charge_usd, action_type")
    .eq("location_id", locationId)
    .eq("charged_to_wallet", false)
    .not("uses_custom_key", "is", true)
    .not("cap_blocked", "is", true)
    .gt("total_charge_usd", 0)
    .order("total_charge_usd", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!rec) {
    console.error("Sem cobrança pendente nessa location pra usar como 'real'. Escolha uma bloqueada/com pendência.");
    process.exit(1);
  }
  console.log(`Cobrança real de teste: record ${rec.id} · $${Number(rec.total_charge_usd).toFixed(4)} · ${rec.action_type}`);
  console.log("Iniciando dreno...\n");

  const result = await attemptWalletDrain(loc.company_id as string, locationId, {
    id: rec.id as string,
    total_charge_usd: rec.total_charge_usd as number,
    action_type: (rec.action_type as string | null) ?? null,
  });

  console.log("\n=== RESULTADO ===");
  console.log(`resolvido: ${result.resolved}`);
  console.log(`drenado:   $${result.drainedUsd.toFixed(2)}`);
  console.log(`razão:     ${result.reason}`);
  console.log(`chargeId:  ${result.chargeId || "-"}`);

  if (result.resolved) {
    await markWalletCharged(rec.id as string, result.chargeId, new Date().toISOString());
    await clearWalletBlock(locationId);
    console.log("\n✅ RECHARGE DISPAROU ao zerar a wallet → a premissa vale, pode ligar WALLET_AUTO_DRAIN_ENABLED.");
    console.log("   Record marcado como cobrado + bloqueio limpo.");
  } else {
    console.log("\n⚠️  Não resolveu. Se drenou $0,00 → o GHL rejeitou até o menor passo (piso de cobrança?)");
    console.log("   ou o saldo não zerou/não disparou o recharge. NÃO ligue a flag até entender.");
  }
  process.exit(0);
}

main();
