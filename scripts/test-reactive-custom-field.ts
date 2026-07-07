/**
 * Testa o gatilho de ativação por CUSTOM FIELD (F27.D, Pedro 2026-07-06 — Alves
 * Cury): "campo AI liga -> agente entra sozinho". Cobre as PARTES PURAS (sem DB):
 *  - matchedTriggerKey: casa custom_field por id+valor, dedup key específica,
 *    valor-vazio = qualquer, e mantém tag/stage funcionando.
 *  - encode/parse do trigger sintético (body genérico p/ custom_field).
 *  - extractContactCustomFieldEvent contra o PAYLOAD REAL do CONTACTUPDATE.
 *  - isLocationProactiveAllowed (allowlist de rollout).
 *
 * As partes com DB (hasConversation, alreadyFired, insert) ficam pro smoke real.
 *
 * Run: npx tsx -r tsconfig-paths/register scripts/test-reactive-custom-field.ts
 */
import {
  matchedTriggerKey,
  ruleMatchesTrigger,
  encodeTriggerBody,
  parseTriggerBody,
  isReactiveTriggerBody,
  type ReactiveTriggerContext,
} from "@/lib/account-assistant/proactive/reactive-trigger";
import {
  extractContactCustomFieldEvent,
  isLocationProactiveAllowed,
} from "@/lib/account-assistant/proactive/event-router";
import type { TargetingRule } from "@/types/agent";

const AI_FIELD = "C7LzKTXG3QHJuzfqOi9T";
const LOC = "YuR0LCZomFzrfkDK2ezo";

let pass = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: string) {
  total++;
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const salesRule: TargetingRule = { id: "ac-sales", type: "custom_field", custom_field_key: AI_FIELD, custom_field_value: "Venda" };
const recruitRule: TargetingRule = { id: "ac-recruit", type: "custom_field", custom_field_key: AI_FIELD, custom_field_value: "Recruit" };
const anyRule: TargetingRule = { id: "any", type: "custom_field", custom_field_key: AI_FIELD, custom_field_value: "" };
const tagRule: TargetingRule = { id: "t", type: "tag", tag: "VIP" };
const stageRule: TargetingRule = { id: "s", type: "pipeline_stage", pipeline_stage_id: "stg1", pipeline_id: "pipe1" };

function cfEv(fields: Array<{ id: string; value: string }>): ReactiveTriggerContext {
  return { locationId: LOC, contactId: "c1", kind: "custom_field_changed", key: "", customFields: fields };
}

// ── matchedTriggerKey: custom_field ─────────────────────────────────────────
{
  const ev = cfEv([{ id: AI_FIELD, value: "Venda" }, { id: "other", value: "x" }]);
  check("cf: sales casa Venda", matchedTriggerKey([salesRule], ev) === `custom_field_changed:${AI_FIELD}:Venda`, String(matchedTriggerKey([salesRule], ev)));
  check("cf: recruit NÃO casa Venda", matchedTriggerKey([recruitRule], ev) === null);
  check("cf: ruleMatchesTrigger true", ruleMatchesTrigger([salesRule], ev) === true);
}
{
  const ev = cfEv([{ id: AI_FIELD, value: "Recruit" }]);
  check("cf: recruit casa Recruit", matchedTriggerKey([recruitRule], ev) === `custom_field_changed:${AI_FIELD}:Recruit`);
  check("cf: sales NÃO casa Recruit", matchedTriggerKey([salesRule], ev) === null);
}
{
  const ev = cfEv([{ id: AI_FIELD, value: "Off" }]);
  check("cf: valor Off não casa Venda", matchedTriggerKey([salesRule], ev) === null);
  check("cf: regra valor-vazio (any) casa qualquer valor não-vazio", matchedTriggerKey([anyRule], ev) === `custom_field_changed:${AI_FIELD}:Off`);
}
{
  const ev = cfEv([{ id: "outro-campo", value: "Venda" }]);
  check("cf: campo diferente não casa", matchedTriggerKey([salesRule], ev) === null);
}
{
  check("cf: sem customFields -> null", matchedTriggerKey([salesRule], { locationId: LOC, contactId: "c1", kind: "custom_field_changed", key: "" }) === null);
  check("cf: rules vazias -> null", matchedTriggerKey([], cfEv([{ id: AI_FIELD, value: "Venda" }])) === null);
}

// ── matchedTriggerKey: tag/stage seguem funcionando ─────────────────────────
{
  const tagEv: ReactiveTriggerContext = { locationId: LOC, contactId: "c1", kind: "tag_added", key: "VIP" };
  check("tag: casa e dedup key", matchedTriggerKey([tagRule], tagEv) === "tag_added:VIP");
  check("tag: tag errada não casa", matchedTriggerKey([{ id: "t2", type: "tag", tag: "OUTRA" }], tagEv) === null);
  const stageEv: ReactiveTriggerContext = { locationId: LOC, contactId: "c1", kind: "stage_changed", key: "stg1", pipelineId: "pipe1" };
  check("stage: casa e dedup key", matchedTriggerKey([stageRule], stageEv) === "stage_changed:stg1");
}

// ── encode/parse do trigger sintético ───────────────────────────────────────
{
  const ev = cfEv([{ id: AI_FIELD, value: "Venda" }]);
  const body = encodeTriggerBody(ev);
  check("encode cf: prefixo + genérico (sem valor)", body === "__reactive_trigger__:custom_field_changed:activated", body);
  check("encode cf: NÃO vaza o valor do campo", !body.includes("Venda"));
  check("isReactiveTriggerBody true", isReactiveTriggerBody(body) === true);
  const parsed = parseTriggerBody(body);
  check("parse cf: kind custom_field_changed", parsed?.kind === "custom_field_changed");
}
{
  const tagEv: ReactiveTriggerContext = { locationId: LOC, contactId: "c1", kind: "tag_added", key: "VIP" };
  const body = encodeTriggerBody(tagEv);
  check("encode tag: roundtrip", body === "__reactive_trigger__:tag_added:VIP");
  check("parse tag: kind+key", parseTriggerBody(body)?.kind === "tag_added" && parseTriggerBody(body)?.key === "VIP");
}

// ── extractContactCustomFieldEvent contra PAYLOAD REAL (CONTACTUPDATE) ───────
{
  // Shape real capturado em prod (inbound_webhook_samples, Alves Cury).
  const realBody: Record<string, unknown> = {
    id: "Utgwe33818i84A2nhzhd",
    type: "ContactUpdate",
    locationId: LOC,
    firstName: "Agnes",
    customFields: [
      { id: AI_FIELD, value: "Off" },
      { id: "HLfdapc4fX07SdVg92L6", value: "WhatsApp" },
      { id: "tUpk31fRxXs2bhxXYMh5", value: "Primeiro Encontro" },
    ],
  };
  const ev = extractContactCustomFieldEvent(realBody);
  check("extract: retorna evento", ev !== null);
  check("extract: kind custom_field_changed", ev?.kind === "custom_field_changed");
  check("extract: contactId (top-level id)", ev?.contactId === "Utgwe33818i84A2nhzhd");
  check("extract: locationId", ev?.locationId === LOC);
  check("extract: 3 customFields", ev?.customFields?.length === 3);
  check("extract: campo AI presente c/ valor", !!ev?.customFields?.find((f) => f.id === AI_FIELD && f.value === "Off"));
  // Se o campo AI vier "Venda", o sales dispara (integração das 2 partes).
  const vendaBody = { ...realBody, customFields: [{ id: AI_FIELD, value: "Venda" }] };
  const vendaEv = extractContactCustomFieldEvent(vendaBody);
  check("extract+match: Venda dispara sales", !!vendaEv && matchedTriggerKey([salesRule], vendaEv) === `custom_field_changed:${AI_FIELD}:Venda`);
}
{
  check("extract: sem customFields -> null", extractContactCustomFieldEvent({ id: "c1", locationId: LOC }) === null);
  check("extract: sem contactId -> null", extractContactCustomFieldEvent({ locationId: LOC, customFields: [{ id: AI_FIELD, value: "Venda" }] }) === null);
  // valor numérico/bool coeridos pra string; array/objeto viram "".
  const coerced = extractContactCustomFieldEvent({ id: "c1", locationId: LOC, customFields: [{ id: "n", value: 5 }, { id: "b", value: true }, { id: "arr", value: ["a"] }] });
  check("extract: number->'5'", !!coerced?.customFields?.find((f) => f.id === "n" && f.value === "5"));
  check("extract: bool->'true'", !!coerced?.customFields?.find((f) => f.id === "b" && f.value === "true"));
  check("extract: array->''", !!coerced?.customFields?.find((f) => f.id === "arr" && f.value === ""));
}

// ── isLocationProactiveAllowed (allowlist de rollout) ───────────────────────
{
  const prev = process.env.PROACTIVE_EVENTS_LOCATIONS;
  delete process.env.PROACTIVE_EVENTS_LOCATIONS;
  check("allowlist vazia -> todas permitidas", isLocationProactiveAllowed(LOC) === true);
  process.env.PROACTIVE_EVENTS_LOCATIONS = ` ${LOC} , outra `;
  check("allowlist com a loc -> permitido", isLocationProactiveAllowed(LOC) === true);
  check("allowlist sem a loc -> bloqueado", isLocationProactiveAllowed("qualquer") === false);
  check("allowlist setada + loc vazia -> bloqueado", isLocationProactiveAllowed(null) === false);
  if (prev === undefined) delete process.env.PROACTIVE_EVENTS_LOCATIONS;
  else process.env.PROACTIVE_EVENTS_LOCATIONS = prev;
}

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
