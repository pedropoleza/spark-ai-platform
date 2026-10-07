/**
 * H102 — gatilho de lead novo (OpportunityCreate) com disjuntor de rajada.
 *
 *   TZ=UTC npx tsx scripts/test-lead-novo-create.ts
 *
 * TZ=UTC porque o nextWorkingHourStart (movido intacto do webhook) assume o
 * relógio do servidor em UTC, que é o da Vercel.
 *
 * A parte do disjuntor grava em sparkbot_dedup_locks com uma location FALSA e
 * apaga tudo no fim — não encosta em conta de cliente.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import {
  extractOpportunityCreateEvent,
  extractOpportunityStageEvent,
  isProactiveEventType,
} from "../src/lib/account-assistant/proactive/event-router";
import {
  encodeTriggerBody,
  parseTriggerBody,
  matchedTriggerKey,
  reservarVagaDeLeadNovo,
  chaveDisjuntorLeadNovo,
  RAJADA_LEAD_NOVO,
} from "../src/lib/account-assistant/proactive/reactive-trigger";
import { isWithinWorkingHours, nextWorkingHourStart } from "../src/lib/queue/working-hours";
import type { TargetingRule, WorkingHoursConfig } from "../src/types/agent";

let ok = 0;
let falhas = 0;
const t = (nome: string, cond: boolean, det = "") => {
  if (cond) { ok++; console.log(`  ✅ ${nome}`); }
  else { falhas++; console.log(`  ❌ ${nome}${det ? "  → " + det : ""}`); }
};

// Payload REAL da Vergus (07/10 12:11 UTC, lead do formulário do Facebook).
const PAYLOAD_VERGUS = {
  id: "opp-teste",
  name: "Lead Teste",
  type: "OpportunityCreate",
  appId: "x",
  source: "Facebook",
  status: "open",
  contactId: "7CpK7uOvJ0UOPxmOPuCx",
  dateAdded: "2026-10-07T12:11:27.000Z",
  timestamp: "2026-10-07T12:11:28.000Z",
  versionId: "v",
  webhookId: "w",
  locationId: "lUSGtKw9OWla97QEqtrh",
  pipelineId: "enhVQCgaSsSfQYv5fneP",
  pipelineStageId: "10f2184f-fc14-473a-9843-1c28b1916a5f",
};

(async () => {
  console.log("1. Roteamento e extração do OpportunityCreate");
  t("OpportunityCreate é evento proativo (o router escuta)", isProactiveEventType("OpportunityCreate"));
  const ev = extractOpportunityCreateEvent(PAYLOAD_VERGUS);
  t("extrai contato/location/etapa/pipeline do payload real",
    ev?.contactId === "7CpK7uOvJ0UOPxmOPuCx" && ev?.locationId === "lUSGtKw9OWla97QEqtrh" &&
    ev?.key === "10f2184f-fc14-473a-9843-1c28b1916a5f" && ev?.pipelineId === "enhVQCgaSsSfQYv5fneP",
    JSON.stringify(ev));
  t("marca origem = opportunity_create", ev?.origem === "opportunity_create");
  t("kind = stage_changed (mesmo matcher da movimentação)", ev?.kind === "stage_changed");
  t("oportunidade criada como WON não aborda (importação de histórico)",
    extractOpportunityCreateEvent({ ...PAYLOAD_VERGUS, status: "won" }) === null);
  t("oportunidade criada como LOST não aborda",
    extractOpportunityCreateEvent({ ...PAYLOAD_VERGUS, status: "lost" }) === null);
  t("sem status no payload = aberta (default de criação)",
    extractOpportunityCreateEvent({ ...PAYLOAD_VERGUS, status: undefined })?.origem === "opportunity_create");
  t("StageUpdate continua sem origem (comportamento antigo intacto)",
    extractOpportunityStageEvent(PAYLOAD_VERGUS)?.origem === undefined);

  console.log("\n2. Regra de funil casa o lead que NASCE na etapa");
  const regra: TargetingRule[] = [
    { type: "pipeline_stage", pipeline_id: "enhVQCgaSsSfQYv5fneP", pipeline_stage_id: "10f2184f-fc14-473a-9843-1c28b1916a5f" } as TargetingRule,
  ];
  t("casa e a chave de dedup é a MESMA da movimentação",
    matchedTriggerKey(regra, ev!) === "stage_changed:10f2184f-fc14-473a-9843-1c28b1916a5f");
  t("etapa diferente não casa",
    matchedTriggerKey(regra, { ...ev!, key: "outra-etapa" }) === null);
  t("folha NEGADA de funil não vira gatilho (H81)",
    matchedTriggerKey([{ ...regra[0], negate: true } as TargetingRule], ev!) === null);

  console.log("\n3. Corpo do gatilho carrega a origem até o processor");
  const corpo = encodeTriggerBody(ev!);
  const lido = parseTriggerBody(corpo);
  t("roundtrip mantém etapa, pipeline e origem",
    lido?.kind === "stage_changed" && lido.key === ev!.key && lido.pipelineId === ev!.pipelineId && lido.origem === "opportunity_create",
    corpo);
  const semPipe = parseTriggerBody(encodeTriggerBody({ ...ev!, pipelineId: undefined }));
  t("sem pipeline: origem continua na posição certa", semPipe?.origem === "opportunity_create" && semPipe.pipelineId === undefined, JSON.stringify(semPipe));
  const antigo = parseTriggerBody("__reactive_trigger__:stage_changed:etapaX:pipeY");
  t("corpo antigo (movimentação) segue sem origem", antigo?.origem === undefined && antigo?.pipelineId === "pipeY");
  t("corpo de campo personalizado intacto",
    parseTriggerBody(encodeTriggerBody({ locationId: "l", contactId: "c", kind: "custom_field_changed", key: "" }))?.kind === "custom_field_changed");

  console.log("\n4. Expediente da Bia (seg-sex 9h-17h ET) decide quando a abertura sai");
  const bia: WorkingHoursConfig = {
    enabled: true, mode: "only_during", timezone: "America/New_York",
    schedule: Object.fromEntries(["monday", "tuesday", "wednesday", "thursday", "friday"].map((d) => [d, { enabled: true, start: "09:00", end: "17:00" }])),
  } as WorkingHoursConfig;
  const segNoite = new Date("2026-10-06T03:02:07Z"); // seg 23:02 ET (lead real 6KBQRW5G)
  t("seg 23h ET está fora do expediente", !isWithinWorkingHours(bia, segNoite));
  t("abertura adiada pra ter 09:00 ET", nextWorkingHourStart(bia, segNoite) === "2026-10-06T13:00:00.000Z", String(nextWorkingHourStart(bia, segNoite)));
  const qua10 = new Date("2026-10-07T14:43:43Z"); // qua 10:43 ET (lead real 5yUZona4)
  t("qua 10h43 ET está dentro (sai na hora)", isWithinWorkingHours(bia, qua10));
  const sex18 = new Date("2026-10-09T22:00:00Z"); // sex 18:00 ET
  t("sex 18h ET → segunda 09:00 ET", nextWorkingHourStart(bia, sex18) === "2026-10-12T13:00:00.000Z", String(nextWorkingHourStart(bia, sex18)));

  console.log(`\n5. Disjuntor (${RAJADA_LEAD_NOVO.maxPorJanela} por ${RAJADA_LEAD_NOVO.janelaMin} min, pausa ${RAJADA_LEAD_NOVO.pausaHoras}h) contra o banco, location falsa`);
  const sb = createAdminClient();
  const LOC = `teste-h102-${Date.now()}`;
  const OUTRA = `${LOC}-b`;
  const agora = Date.now();
  try {
    const seq: string[] = [];
    for (let i = 0; i < RAJADA_LEAD_NOVO.maxPorJanela + 2; i++) seq.push(await reservarVagaDeLeadNovo(sb, LOC, agora));
    console.log(`     sequência: ${seq.join(", ")}`);
    t(`os ${RAJADA_LEAD_NOVO.maxPorJanela} primeiros passam`, seq.slice(0, RAJADA_LEAD_NOVO.maxPorJanela).every((x) => x === "ok"));
    t("o seguinte arma o disjuntor", seq[RAJADA_LEAD_NOVO.maxPorJanela] === "disjuntor_armado_agora");
    t("depois de armado, barra", seq[RAJADA_LEAD_NOVO.maxPorJanela + 1] === "disjuntor_aberto");
    t("janela seguinte NÃO reabre enquanto o disjuntor vale (importação longa não vaza)",
      (await reservarVagaDeLeadNovo(sb, LOC, agora + 15 * 60_000)) === "disjuntor_aberto");
    t("outra location não é afetada", (await reservarVagaDeLeadNovo(sb, OUTRA, agora)) === "ok");
    t(`passadas ${RAJADA_LEAD_NOVO.pausaHoras}h o disjuntor solta`,
      (await reservarVagaDeLeadNovo(sb, LOC, agora + (RAJADA_LEAD_NOVO.pausaHoras + 1) * 3600_000)) === "ok");

    // Concorrência: 30 lambdas da mesma importação ao mesmo tempo, numa janela limpa.
    const LOC2 = `${LOC}-c`;
    const res = await Promise.all(Array.from({ length: 30 }, () => reservarVagaDeLeadNovo(sb, LOC2, agora)));
    const passaram = res.filter((x) => x === "ok").length;
    t(`30 eventos simultâneos: só ${RAJADA_LEAD_NOVO.maxPorJanela} passam`, passaram === RAJADA_LEAD_NOVO.maxPorJanela, `passaram ${passaram}`);
  } finally {
    const { error } = await sb.from("sparkbot_dedup_locks").delete().or(
      `dedup_key.like.lead-novo:${LOC}%,dedup_key.like.${chaveDisjuntorLeadNovo(LOC)}%`,
    );
    console.log(`     limpeza: ${error ? "FALHOU " + error.message : "ok"}`);
  }

  console.log(`\nRESULTADO: ${ok} ok, ${falhas} falhas`);
  process.exit(falhas ? 1 : 0);
})();
