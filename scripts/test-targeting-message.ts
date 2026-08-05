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

console.log("\n=== conversa ativa: folha message é gatilho de ATIVAÇÃO (Fix Marina 2026-06-18) ===");
// REGRESSÃO direta do bug: follow-up "Florida" não contém a frase, mas a conversa
// já está ativa → folha message vira neutra → agente continua respondendo.
ok("REGRESSÃO: message não bate MAS conversa ativa → neutra → passa",
  evaluateTargetingSet(msgSet, contact, opps, { messageText: "Florida", conversationActive: true }) === true);
// 1º contato (não ativa): a folha message AINDA gateia a ativação (intencional).
ok("1º contato: message bate → ativa (match)",
  evaluateTargetingSet(msgSet, contact, opps, { messageText: "quero um orçamento" }) === true);
ok("1º contato: message não bate → block (gateia ativação)",
  evaluateTargetingSet(msgSet, contact, opps, { messageText: "bom dia" }) === false);
// Combo perfil+mensagem com conversa ativa: sobra só o PERFIL (message neutra).
const tagAndMsg: TargetingRuleSet = {
  version: 2, match: "all",
  groups: [
    { id: "g1", match: "all", rules: [leaf({ type: "tag", tag: "VIP" })] },
    { id: "g2", match: "all", rules: [leaf({ type: "message", message_operator: "contains", message_value: "orçamento" })] },
  ],
};
ok("ativa: tag VIP E (msg neutra) → vale só a tag → passa",
  evaluateTargetingSet(tagAndMsg, contact, opps, { messageText: "qualquer coisa", conversationActive: true }) === true);
const tagAusenteAndMsg: TargetingRuleSet = {
  version: 2, match: "all",
  groups: [
    { id: "g1", match: "all", rules: [leaf({ type: "tag", tag: "nao-existe" })] },
    { id: "g2", match: "all", rules: [leaf({ type: "message", message_operator: "contains", message_value: "orçamento" })] },
  ],
};
ok("ativa NÃO afrouxa perfil: tag ausente E (msg neutra) → block",
  evaluateTargetingSet(tagAusenteAndMsg, contact, opps, { messageText: "qualquer coisa", conversationActive: true }) === false);
// conversationActive ausente = comportamento legado idêntico (folha message vale).
ok("sem conversationActive = legado (message não bate → block)",
  evaluateTargetingSet(msgSet, contact, opps, { messageText: "bom dia" }) === false);

console.log("\n=== acento-insensível (F9 follow-up 2026-06-27) ===");
// deburr nos 2 lados: needle com acento casa texto sem acento e vice-versa.
ok("contains: texto 'orcamento' vs needle 'orçamento' → match",
  matchTextOp("contains", "quero um orcamento", "orçamento") === true);
ok("contains: texto 'orçamento' vs needle 'orcamento' → match",
  matchTextOp("contains", "quero um orçamento", "orcamento") === true);
ok("eq: 'sao paulo' vs 'São Paulo' → match", matchTextOp("eq", "sao paulo", "São Paulo") === true);
ok("in: needle 'atenção' casa texto 'atencao'", matchTextOp("in", "preciso de atencao", ["atenção"]) === true);
// tag + custom_field via avaliador: regra sem acento casa atributo com acento no CRM.
const accentContact = {
  tags: ["Líder", "São Paulo"],
  customFields: [{ key: "cidade", value: "Brasília" }],
};
const evalAccent = (rules: TargetingRule[]) => {
  const set = normalizeTargeting(rules);
  return set ? evaluateTargetingSet(set, accentContact, [], {}) : true;
};
ok("tag: regra 'lider' casa tag 'Líder'", evalAccent([leaf({ type: "tag", tag: "lider" })]) === true);
ok("tag: regra 'Sao Paulo' casa tag 'São Paulo'", evalAccent([leaf({ type: "tag", tag: "Sao Paulo" })]) === true);
ok("custom_field: 'Brasilia' casa 'Brasília'",
  evalAccent([leaf({ type: "custom_field", custom_field_key: "cidade", custom_field_value: "Brasilia" })]) === true);

// ── As regras REAIS da frota (medidas em prod 2026-08-05) ───────────────────
// 8 agent_configs têm regra de ativação acentuada e ativam por FRASE — se o
// acento do lead não bate o da regra, o agente fica MUDO pra aquele lead.
// Sintoma de que o problema era real: na config do Matheus alguém já tinha
// escrito as duas grafias à mão ("Veio de anúncio" E "Veio de anuncio",
// "proteger minha família" E "proteger minha familia"). Com o deburr, uma basta.
console.log("\n=== regras reais da frota (acento) ===");
const frase = (regra: string, lead: string) =>
  evaluateTargetingSet(
    { version: 2, match: "all", groups: [{ id: "g", match: "all", rules: [leaf({ type: "message", message_operator: "contains", message_value: regra })] }] } as TargetingRuleSet,
    { tags: [], customFields: [] },
    [],
    { messageText: lead },
  );
ok(
  "Gian: regra 'renda vitalícia' casa lead que escreve 'renda vitalicia'",
  frase("aposentadoria/renda vitalícia  em dolar", "quero saber de aposentadoria/renda vitalicia  em dolar") === true,
);
ok(
  "Bruna: regra 'mais informações sobre o seguro' casa 'mais informacoes sobre o seguro'",
  frase("Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida",
        "Moro nos EUA e gostaria de mais informacoes sobre o seguro com beneficio em vida") === true,
);
ok(
  "Bruno: regra 'informações de como me tornar agente' casa a grafia sem acento",
  frase("Moro nos EUA e gostaria de mais informações de como me tornar agente financeiro",
        "moro nos eua e gostaria de mais informacoes de como me tornar agente financeiro") === true,
);
ok(
  "Matheus: uma grafia só passa a cobrir as duas ('anúncio' pega 'anuncio')",
  frase("Veio de anúncio", "Veio de anuncio") === true,
);
ok(
  "Jussara: 'Tenho interesse e queria mais informações' casa sem acento",
  frase("Tenho interesse e queria mais informações", "Tenho interesse e queria mais informacoes") === true,
);
ok(
  "não afrouxou de mais: frase diferente segue bloqueada",
  frase("Veio de anúncio", "quanto custa o seguro?") === false,
);

// ── H51: por que o membership durável é indispensável ──────────────────────
console.log("\n=== H51: set REAL da Marina (opener OU tag, trigger_once) ===");
// Espelha o que está salvo em prod (agent 3976b4b6…): match "any" entre o grupo
// de abertura (message "in" ["carreira","entender melhor"]) e o grupo da tag.
const marinaSet: TargetingRuleSet = {
  version: 2,
  match: "any",
  groups: [
    { id: "abertura", match: "any", rules: [leaf({ type: "message", message_operator: "in", message_values: ["carreira", "entender melhor"], case_sensitive: false })] },
    { id: "tag", match: "any", rules: [leaf({ type: "tag", tag: "ia - em atendimento" })] },
  ],
};
const semTag = { tags: ["lead-frio"], customFields: [] };
const comTag = { tags: ["ia - em atendimento"], customFields: [] };
// 1º contato (conversa NÃO ativa): o opener ativa mesmo SEM a tag — mata a
// corrida entre o webhook e a automação que adiciona a tag.
ok("1º contato: opener 'queria entender melhor sobre essa carreira' sem tag → ativa",
  evaluateTargetingSet(marinaSet, semTag, [], { messageText: "Olá Marina, queria entender melhor sobre essa carreira" }) === true);
ok("1º contato: SÓ a tag (sem frase de abertura) → ativa (rede de segurança)",
  evaluateTargetingSet(marinaSet, comTag, [], { messageText: "oi" }) === true);
ok("1º contato: nem opener nem tag → NÃO ativa",
  evaluateTargetingSet(marinaSet, semTag, [], { messageText: "bom dia" }) === false);
// O assert que TRAVA a premissa: num follow-up sem a tag, o avaliador puro
// BLOQUEIA. É exatamente por isso que a Marina é `trigger_once` — o gate do
// processor é bypassado quando a conversa está ativa, e o dono passa a ser o
// membership. Se fosse `gate_ongoing`, este follow-up morreria.
ok("follow-up sem tag: evaluator BLOQUEIA (por isso o membership tem que existir)",
  evaluateTargetingSet(marinaSet, semTag, [], { messageText: "Florida", conversationActive: true }) === false);
ok("follow-up COM a tag → passa mesmo sem trigger_once",
  evaluateTargetingSet(marinaSet, comTag, [], { messageText: "Florida", conversationActive: true }) === true);

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
