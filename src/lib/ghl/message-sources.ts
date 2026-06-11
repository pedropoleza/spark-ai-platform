/**
 * Classificação humano × bot das fontes (`source`) de mensagens do Spark Leads.
 *
 * O Spark Leads/GHL carimba cada outbound com um `source`:
 *  - "app"      → rep digitando manualmente no inbox (HUMANO)
 *  - "api"      → envio programático/integração (inclui a própria IA)
 *  - "workflow"/"campaign"/"bulk"/... → automação do GHL (welcome, re-engajamento)
 *
 * Vários pontos do sistema precisam responder "esse outbound foi um HUMANO de
 * verdade ou bot/automação?":
 *  - should-respond gate (queue/lead-history.ts) — não atropelar humano
 *  - rótulo do histórico no prompt (ai/sales-prompt-builder.ts) — "Humano (rep)" × "Bot/sistema"
 *  - anti-pausa F52/F56 (queue/queue-processor.ts) — não pausar a IA no welcome
 *
 * Fonte ÚNICA da verdade pra evitar drift: até 2026-06-10 cada call-site tinha
 * sua própria cópia da lista e elas DIVERGIRAM — o sales-prompt-builder usava o
 * check estreito `source !== "api"` e rotulava o welcome de automação (source
 * "workflow"/"campaign") como "Humano (rep)", contradizendo o gate que (fix
 * e06f409/F56) já o excluía corretamente. Centralizado aqui.
 */

/**
 * Fontes de automação/bot do GHL (workflow, campanha, bulk, integração, etc).
 * NÃO inclui "api": o envio via API é genérico (a própria IA envia por ele) e em
 * contextos como o anti-eco do F52 é discriminado por outro caminho (match do
 * corpo da msg), não pela fonte. Use {@link NON_HUMAN_SOURCES} quando "api"
 * também deve contar como não-humano.
 */
export const AUTOMATION_SOURCES = new Set<string>([
  "workflow",
  "workflows",
  "campaign",
  "campaigns",
  "bulk_actions",
  "bulk",
  "automation",
  "automations",
  "scheduled",
  "integration",
]);

/**
 * Conjunto completo de fontes NÃO-humanas: automação + o "api" genérico. Use
 * quando a pergunta é "esse outbound foi um rep humano?" — rep no inbox tem
 * source "app" (fora do set → humano); qualquer api/automação fica de fora.
 */
export const NON_HUMAN_SOURCES = new Set<string>([...AUTOMATION_SOURCES, "api"]);

/**
 * `true` se o `source` de um outbound indica um HUMANO (rep digitando no inbox
 * do Spark Leads); `false` pra bot/automação/api OU source ausente.
 * Case-insensitive.
 *
 * Espelha o gate do should-respond (lead-history.ts): outbound sem source, ou
 * com source de automação/api, NÃO conta como humano.
 */
export function isHumanOutboundSource(source?: string | null): boolean {
  if (!source) return false;
  return !NON_HUMAN_SOURCES.has(source.toLowerCase());
}
