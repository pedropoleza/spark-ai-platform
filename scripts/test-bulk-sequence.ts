/**
 * Test bulk sequence runtime (Etapa 4.4 — Pedro 2026-05-28).
 *
 * Guard-rail: confirma que os módulos novos compilam e que a flag default-OFF
 * funciona (zero side effect quando BULK_SEQUENCES_ENABLED não está setada).
 *
 * NÃO valida lógica de DB end-to-end — isso fica pro smoke supervisionado
 * com Pedro (criar campanha real, ativar, ver bot disparar steps).
 *
 * Rodar: `npx tsx scripts/test-bulk-sequence.ts`
 */
import { processSequenceSteps } from "../src/lib/account-assistant/proactive/sequence-runner";
import { pauseBulkSequencesOnReply } from "../src/lib/account-assistant/proactive/bulk-sequence-monitor";

type Assertion = { name: string; ok: boolean; message: string };
const results: Assertion[] = [];

function assert(name: string, condition: boolean, msg: string) {
  results.push({ name, ok: condition, message: msg });
}

async function main() {
  // ── 1. Flag-gate ───────────────────────────────────────────────────────
  // BULK_SEQUENCES_ENABLED ausente = no-op
  delete process.env.BULK_SEQUENCES_ENABLED;
  const flagOff = await processSequenceSteps();
  assert(
    "flag OFF → no-op",
    flagOff.advanced === 0 && flagOff.completed === 0 && flagOff.failed === 0,
    `esperado zeros, recebeu advanced=${flagOff.advanced} completed=${flagOff.completed} failed=${flagOff.failed}`,
  );

  // BULK_SEQUENCES_ENABLED com valor falsy também
  process.env.BULK_SEQUENCES_ENABLED = "0";
  const flagZero = await processSequenceSteps();
  assert(
    "flag '0' → no-op",
    flagZero.advanced === 0 && flagZero.failed === 0,
    "esperado zeros mesmo com flag='0'",
  );

  process.env.BULK_SEQUENCES_ENABLED = "false";
  const flagFalse = await processSequenceSteps();
  assert(
    "flag 'false' → no-op",
    flagFalse.advanced === 0 && flagFalse.failed === 0,
    "esperado zeros mesmo com flag='false'",
  );

  // ── 2. Pause monitor: IDs vazios = no-op ──────────────────────────────
  const emptyContact = await pauseBulkSequencesOnReply("", "loc1");
  assert(
    "pause monitor: contact_id vazio → no-op",
    emptyContact.paused_states === 0 && emptyContact.cancelled_recipients === 0,
    "esperado zeros pra contact_id vazio",
  );

  const emptyLocation = await pauseBulkSequencesOnReply("c1", "");
  assert(
    "pause monitor: location_id vazio → no-op",
    emptyLocation.paused_states === 0 && emptyLocation.cancelled_recipients === 0,
    "esperado zeros pra location_id vazio",
  );

  // ── 3. Test com DB ativa só roda em CI com env vars. Smoke real é
  // supervisionado: criar campanha real com 3 contatos, ativar, ver disparo.
  // Comentado pra não exigir env vars locais.

  // ── Resultado ──────────────────────────────────────────────────────────
  const failed = results.filter((r) => !r.ok);
  const passed = results.length - failed.length;
  console.log(`\n${passed}/${results.length} testes passaram`);
  for (const r of results) {
    console.log(`  ${r.ok ? "✅" : "❌"} ${r.name}: ${r.message}`);
  }
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("[test-bulk-sequence] crashed:", err);
  process.exit(1);
});
