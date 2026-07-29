/**
 * Prova qual motor um PROATIVO usa hoje — sem mandar mensagem nenhuma.
 *
 * Existe porque o item 1 do scan (proativos saírem pelo SparkZap) é decidido por
 * `pickWaTransport(rep.phone)` lendo env, e a única forma honesta de verificar
 * era esperar o próximo disparo orgânico. Isto responde na hora e sem acordar
 * corretor às 22h.
 *
 * Uso:
 *   npx tsx scripts/probe-proactive-transport.ts            # todos os reps
 *   npx tsx scripts/probe-proactive-transport.ts +17867717077
 */
import { createAdminClient } from "../src/lib/supabase/admin";
import { pickWaTransport, sparkZapAllowlist } from "../src/lib/account-assistant/webhook/wa-transport";

async function main() {
  const alvo = process.argv[2];
  const allow = sparkZapAllowlist();

  console.log("\nConfiguração vista pelo processo:");
  console.log(`  SPARKBOT_WA_TRANSPORT = ${process.env.SPARKBOT_WA_TRANSPORT || "(vazio → stevo)"}`);
  console.log(
    `  SPARKZAP_REPS         = ${allow.length ? `${allow.length} telefone(s)` : "(vazia → vale pra TODOS)"}`,
  );
  console.log(
    `  gate de envio         = ${process.env.SPARKBOT_SEND_ENABLED || process.env.STEVO_SEND_ENABLED || "(desligado)"}`,
  );

  const db = createAdminClient();
  let q = db
    .from("rep_identities")
    .select("phone, display_name, is_internal")
    .not("phone", "is", null)
    .not("phone", "like", "webonly:%");
  if (alvo) q = q.eq("phone", alvo);
  const { data, error } = await q.limit(200);
  if (error) throw new Error(error.message);

  const reps = (data ?? []) as Array<{ phone: string; display_name: string | null; is_internal: boolean }>;
  const contagem: Record<string, number> = {};
  for (const r of reps) {
    const motor = pickWaTransport(r.phone);
    contagem[motor] = (contagem[motor] || 0) + 1;
    if (alvo || reps.length <= 12) {
      console.log(`  ${motor.padEnd(9)} ${r.phone.padEnd(15)} ${r.display_name ?? ""}`);
    }
  }

  console.log(`\nProativo sairia por (${reps.length} reps com telefone):`);
  for (const [motor, n] of Object.entries(contagem).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${motor}: ${n}`);
  }
  const naoZap = reps.length - (contagem.sparkzap || 0);
  console.log(
    naoZap === 0
      ? "\n✅ TODOS os proativos sairiam pelo SparkZap.\n"
      : `\n⚠️  ${naoZap} rep(s) ainda sairiam pelo caminho antigo.\n`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
