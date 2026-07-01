/**
 * Comando MANUAL do resumo matinal da Marina (mesma lógica do cron).
 *   Ver a lista de hoje (não envia):  npx tsx -r tsconfig-paths/register scripts/marina-daily-appointments.ts
 *   Outro dia:                        DATE=2026-06-29 npx tsx ... (dry-run)
 *   ENVIAR de verdade agora:          SEND=1 npx tsx ...   (precisa MARINA_DAILY_PHONE + STEVO_SEND_ENABLED=1)
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { runMarinaDailyDigest } from "@/lib/account-assistant/marina-daily";

async function main() {
  const forDate = process.env.DATE ? new Date(`${process.env.DATE}T12:00:00-04:00`) : new Date();
  const send = /^(1|true|yes)$/i.test(process.env.SEND?.trim() || "");
  const result = await runMarinaDailyDigest({ forDate, dryRun: !send });
  console.log("\n=== MENSAGEM ===\n");
  console.log(result.text || "(sem texto)");
  console.log("\n=== RESULTADO ===");
  console.log(JSON.stringify({ ...result, text: undefined }, null, 1));
  if (!send) console.log("\n(dry-run — não enviou. Use SEND=1 pra enviar de verdade.)");
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
