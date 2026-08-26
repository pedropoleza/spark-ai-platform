/**
 * H81 — folha de EXCLUSÃO nunca pode ser GATILHO reativo.
 *
 * O achatamento em `handleReactiveTrigger` junta as folhas de todos os grupos
 * (entrada + exclusão) numa lista só. Antes deste fix, `matchedTriggerKey` só
 * olhava `type === "tag" && ev.key === rule.tag` — então, com o gate real da
 * Bianca no ar, marcar um contato como `client` faria o agente de RECRUTAMENTO
 * abrir conversa proativa com um CLIENTE. É o incidente da Jussara entrando
 * pela porta dos fundos, disparado pela regra que existe pra impedi-lo.
 *
 *   npx tsx scripts/test-reactive-trigger-negate.ts
 */
import { matchedTriggerKey } from "@/lib/account-assistant/proactive/reactive-trigger";
import type { TargetingRule } from "@/types/agent";

// Achatado exatamente como o runtime faz: groups.flatMap(g => g.rules).
const GATE_SEGUIDORES: TargetingRule[] = [
  // g-entrada
  { id: "ent-tag-seguidor", type: "tag", tag: "novo seguidor" },
  { id: "ent-tag-sdr", type: "tag", tag: "ia-ligada" },
  // g-organico
  { id: "org", type: "attribution", attribution_field: "sessionSource", attribution_operator: "not_contains", attribution_value: "Paid", attribution_scope: "first" },
  // g-exclusao (H81)
  { id: "exc-0", type: "tag", tag: "client", negate: true },
  { id: "exc-1", type: "tag", tag: "cliente", negate: true },
  { id: "exc-2", type: "tag", tag: "contato pessoal", negate: true },
  { id: "exc-3", type: "tag", tag: "pessoal bia", negate: true },
  { id: "exc-4", type: "tag", tag: "membro da agencia", negate: true },
  { id: "exc-5", type: "tag", tag: "ia-desligada", negate: true },
];

const ev = (key: string) => ({ locationId: "L", contactId: "C", kind: "tag_added" as const, key });

const casos: Array<[string, string, string | null]> = [
  ["tag de entrada DISPARA (novo seguidor)", "novo seguidor", "tag_added:novo seguidor"],
  ["tag da SDR DISPARA (ia-ligada)", "ia-ligada", "tag_added:ia-ligada"],
  ["tag EXCLUÍDA não dispara (client)", "client", null],
  ["tag EXCLUÍDA não dispara (cliente)", "cliente", null],
  ["tag EXCLUÍDA não dispara (contato pessoal)", "contato pessoal", null],
  ["tag EXCLUÍDA não dispara (pessoal bia)", "pessoal bia", null],
  ["tag EXCLUÍDA não dispara (membro da agencia)", "membro da agencia", null],
  ["DESLIGAR não pode LIGAR (ia-desligada)", "ia-desligada", null],
  ["tag qualquer não dispara", "qualificada", null],
];

let fail = 0;
for (const [nome, tag, esperado] of casos) {
  const got = matchedTriggerKey(GATE_SEGUIDORES, ev(tag));
  const ok = got === esperado;
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${nome} → ${got === null ? "não dispara" : got}${ok ? "" : `  (esperado ${esperado === null ? "não disparar" : esperado})`}`);
}

// Regressão: sem negate, nada muda.
const legado: TargetingRule[] = [{ id: "t", type: "tag", tag: "VIP" }];
const r1 = matchedTriggerKey(legado, ev("VIP"));
const ok1 = r1 === "tag_added:VIP";
if (!ok1) fail++;
console.log(`${ok1 ? "✅" : "❌"} regressão: regra legada sem negate segue disparando → ${r1}`);

console.log(fail === 0 ? `\n✅ ${casos.length + 1}/${casos.length + 1}` : `\n❌ ${fail} falha(s)`);
process.exit(fail === 0 ? 0 : 1);
