/**
 * Guard rail do targeting v2 (Pedro 2026-06-17): prova que (a) o avaliador novo
 * reproduz o AND legado pra regras flat (paridade — back-compat), (b) os
 * operadores de texto funcionam, (c) grupos E/OU compõem certo, (d) folha
 * message é NEUTRA sem texto / em proativo. PURO, sem GHL.
 *   npx tsx -r tsconfig-paths/register scripts/test-targeting-message.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { normalizeTargeting, evaluateTargetingSet } from "../src/lib/queue/targeting";
import { matchTextOp } from "../src/lib/account-assistant/filter-engine/text-ops";
import type { TargetingRule, TargetingRuleSet } from "../src/types/agent";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

const contact = {
  tags: ["VIP", "lead-quente"],
  customFields: [{ key: "plano", value: "gold" }],
};
const opps = [{ pipelineId: "pipe1", pipelineStageId: "stage1" }];
const leaf = (r: Partial<TargetingRule>): TargetingRule => ({ id: Math.random().toString(36).slice(2), type: "tag", ...r } as TargetingRule);
const evalFlat = (rules: TargetingRule[], opts = {}) => {
  const set = normalizeTargeting(rules);
  return set ? evaluateTargetingSet(set, contact, opps, opts) : true;
};

console.log("\n=== normalizeTargeting (back-compat) ===");
ok("null → null", normalizeTargeting(null) === null);
ok("[] → null (sem regra)", normalizeTargeting([]) === null);
const norm1 = normalizeTargeting([leaf({ type: "tag", tag: "VIP" })]);
ok("flat → 1 grupo 'all'", !!norm1 && norm1.match === "all" && norm1.groups.length === 1 && norm1.groups[0].match === "all");
const v2: TargetingRuleSet = { version: 2, match: "any", groups: [{ id: "g", match: "all", rules: [leaf({ type: "tag", tag: "x" })] }] };
ok("v2 passthrough (match any)", normalizeTargeting(v2)?.match === "any");

console.log("\n=== PARIDADE AND legado (tag/custom_field/pipeline_stage) ===");
ok("tag presente → ok", evalFlat([leaf({ type: "tag", tag: "VIP" })]) === true);
ok("tag case-insensitive (vip vs VIP) → ok", evalFlat([leaf({ type: "tag", tag: "vip" })]) === true);
ok("tag ausente → block", evalFlat([leaf({ type: "tag", tag: "nao-existe" })]) === false);
ok("AND: 2 tags, só 1 presente → block", evalFlat([leaf({ type: "tag", tag: "VIP" }), leaf({ type: "tag", tag: "nao-existe" })]) === false);
ok("AND: 2 tags ambas presentes → ok", evalFlat([leaf({ type: "tag", tag: "VIP" }), leaf({ type: "tag", tag: "lead-quente" })]) === true);
ok("custom_field valor exato → ok", evalFlat([leaf({ type: "custom_field", custom_field_key: "plano", custom_field_value: "gold" })]) === true);
ok("custom_field valor errado → block", evalFlat([leaf({ type: "custom_field", custom_field_key: "plano", custom_field_value: "silver" })]) === false);
ok("custom_field só-existe (sem valor) → ok", evalFlat([leaf({ type: "custom_field", custom_field_key: "plano" })]) === true);
ok("pipeline_stage match → ok", evalFlat([leaf({ type: "pipeline_stage", pipeline_stage_id: "stage1", pipeline_id: "pipe1" })]) === true);
ok("pipeline_stage outro → block", evalFlat([leaf({ type: "pipeline_stage", pipeline_stage_id: "stageX" })]) === false);
ok("folha malformada (tag sem tag) → neutra → ok", evalFlat([leaf({ type: "tag" })]) === true);

console.log("\n=== matchTextOp (operadores de texto) ===");
ok("contains", matchTextOp("contains", "Quero um orçamento agora", "orçamento") === true);
ok("contains case-insensitive", matchTextOp("contains", "ORÇAMENTO", "orçamento") === true);
ok("contains negativo", matchTextOp("contains", "oi tudo bem", "orçamento") === false);
ok("eq (igual exato)", matchTextOp("eq", "  Sim  ", "sim") === true);
ok("eq negativo (substring não conta)", matchTextOp("eq", "sim quero", "sim") === false);
ok("not_contains", matchTextOp("not_contains", "quero falar", "cancelar") === true);
ok("starts_with", matchTextOp("starts_with", "Quero info", "quero") === true);
ok("ends_with", matchTextOp("ends_with", "manda o preço", "preço") === true);
ok("in (contains-any) bate", matchTextOp("in", "tenho interesse no plano", ["orçamento", "interesse", "preço"]) === true);
ok("in (contains-any) não bate", matchTextOp("in", "bom dia", ["orçamento", "preço"]) === false);
ok("matches_regex", matchTextOp("matches_regex", "ligar 11 98765-4321", "\\d{2}\\s?\\d{4,5}-\\d{4}") === true);
ok("matches_regex inválida → false (não lança)", matchTextOp("matches_regex", "abc", "(") === false);
ok("case_sensitive respeitado", matchTextOp("contains", "ORÇAMENTO", "orçamento", { caseSensitive: true }) === false);

console.log("\n=== folha message no avaliador ===");
const msgSet: TargetingRuleSet = { version: 2, match: "all", groups: [{ id: "g", match: "all", rules: [leaf({ type: "message", message_operator: "contains", message_value: "orçamento" })] }] };
ok("message sem texto → neutra → passa", evaluateTargetingSet(msgSet, contact, opps, {}) === true);
ok("message em proativo → neutra → passa", evaluateTargetingSet(msgSet, contact, opps, { messageText: "orçamento", isProactive: true }) === true);
ok("message com texto que bate → match", evaluateTargetingSet(msgSet, contact, opps, { messageText: "quero um orçamento" }) === true);
ok("message com texto que NÃO bate → block", evaluateTargetingSet(msgSet, contact, opps, { messageText: "bom dia" }) === false);

console.log("\n=== composição E/OU ===");
// (tag VIP) E (mensagem contém 'orçamento' OU começa com 'quero')
const andOr: TargetingRuleSet = {
  version: 2, match: "all",
  groups: [
    { id: "g1", match: "all", rules: [leaf({ type: "tag", tag: "VIP" })] },
    { id: "g2", match: "any", rules: [
      leaf({ type: "message", message_operator: "contains", message_value: "orçamento" }),
      leaf({ type: "message", message_operator: "starts_with", message_value: "quero" }),
    ] },
  ],
};
ok("E/OU: vip + 'quero isso' (starts_with) → ok", evaluateTargetingSet(andOr, contact, opps, { messageText: "quero isso" }) === true);
ok("E/OU: vip + 'me vê o orçamento' (contains) → ok", evaluateTargetingSet(andOr, contact, opps, { messageText: "me vê o orçamento" }) === true);
ok("E/OU: vip + 'bom dia' (nenhum) → block", evaluateTargetingSet(andOr, contact, opps, { messageText: "bom dia" }) === false);
// OU no topo: (tag X) OU (mensagem contém 'preço')
const orTop: TargetingRuleSet = {
  version: 2, match: "any",
  groups: [
    { id: "g1", match: "all", rules: [leaf({ type: "tag", tag: "nao-existe" })] },
    { id: "g2", match: "all", rules: [leaf({ type: "message", message_operator: "contains", message_value: "preço" })] },
  ],
};
ok("OU topo: tag falha mas mensagem bate → ok", evaluateTargetingSet(orTop, contact, opps, { messageText: "qual o preço?" }) === true);
ok("OU topo: tag falha e mensagem falha → block", evaluateTargetingSet(orTop, contact, opps, { messageText: "oi" }) === false);

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
