/**
 * Targeting rules enforcement — F27 (Pedro 2026-05-28) + composição E/OU e
 * filtro por mensagem (Pedro 2026-06-17).
 *
 * Bug histórico (F27): o wizard/detail-view salvavam `targeting_rules` mas o
 * runtime nunca avaliava → agente respondia a TODOS. Este módulo fecha o gap.
 *
 * v2 (2026-06-17): além de tag/custom_field/pipeline_stage (atributos do
 * contato), agora suporta type="message" (CONTEÚDO da mensagem do lead, com
 * operadores: contains/eq/starts_with/etc — ver text-ops.ts) E composição
 * E/OU explícita por GRUPOS. Back-compat TOTAL: um array flat legado é lido
 * como 1 grupo "all" (= AND, idêntico ao runtime antigo) por normalizeTargeting.
 *
 * Fail-OPEN por padrão (erro de fetch GHL → ok:true; gate de runtime não pode
 * silenciar o agente). O ROTEADOR do webhook chama com failMode:"closed"
 * (errar = "não escolhe ESTE agente, tenta o próximo").
 */
import type {
  TargetingRule,
  TargetingRules,
  TargetingRuleSet,
  TargetingGroup,
} from "@/types/agent";
import { GHLClient } from "@/lib/ghl/client";
import { matchTextOp, type TextOp } from "@/lib/account-assistant/filter-engine/text-ops";

export interface TargetingMatch {
  ok: boolean;
  reason?: string;
}

export interface TargetingOpts {
  /** Texto do inbound do lead — necessário pras folhas type="message". */
  messageText?: string;
  /**
   * true em fluxo PROATIVO (o aggregatedBody é instrução nossa, não fala do
   * lead) → folhas message viram NEUTRAS pra não casar a própria instrução.
   */
  isProactive?: boolean;
  /**
   * "open" (default): erro de fetch / dados faltando → ok:true (gate de runtime
   * — não silencia o agente). "closed": → ok:false (roteador do webhook — não
   * escolhe o agente errado pro lead).
   */
  failMode?: "open" | "closed";
}

interface GhlContact {
  tags?: Array<string | { name?: string }>;
  customFields?: Array<{ id?: string; key?: string; value?: unknown }>;
  customField?: Array<{ id?: string; key?: string; value?: unknown }>;
}

interface GhlOpp {
  pipelineId?: string;
  pipelineStageId?: string;
  stageId?: string;
}

function extractTags(contact: GhlContact | null | undefined): string[] {
  if (!contact?.tags) return [];
  return contact.tags
    .map((t) => (typeof t === "string" ? t : t?.name || ""))
    .filter(Boolean) as string[];
}

function extractCustomField(
  contact: GhlContact | null | undefined,
  key: string,
): string {
  const fields = contact?.customFields || contact?.customField || [];
  if (!Array.isArray(fields)) return "";
  const found = fields.find((f) => f?.id === key || f?.key === key);
  return found?.value != null ? String(found.value) : "";
}

/**
 * Normaliza o que está salvo (array flat legado OU set v2) num TargetingRuleSet.
 * FONTE ÚNICA de leitura. Array flat → 1 grupo "all" (AND — reproduz byte-a-byte
 * o runtime legado). null / vazio → null (= sem regra = responde a todos).
 */
export function normalizeTargeting(
  raw: TargetingRules | null | undefined,
): TargetingRuleSet | null {
  if (!raw) return null;
  if (Array.isArray(raw)) {
    if (raw.length === 0) return null;
    return { version: 2, match: "all", groups: [{ id: "legacy", match: "all", rules: raw }] };
  }
  // Set v2 explícito.
  if (raw.version === 2 && Array.isArray(raw.groups)) {
    const groups = raw.groups.filter(
      (g) => g && Array.isArray(g.rules) && g.rules.length > 0,
    );
    if (groups.length === 0) return null;
    return { version: 2, match: raw.match === "any" ? "any" : "all", groups };
  }
  return null;
}

// Resultado de uma folha: match / no_match / neutral (folha malformada ou
// message sem texto — não conta na composição, igual ao `continue` legado).
type LeafResult = "match" | "no_match" | "neutral";

function evalLeaf(
  rule: TargetingRule,
  contact: GhlContact | null,
  opps: GhlOpp[],
  opts: TargetingOpts,
): LeafResult {
  switch (rule.type) {
    case "tag": {
      if (!rule.tag) return "neutral";
      // case-insensitive + trim (GHL normaliza tags pra lowercase).
      const want = rule.tag.trim().toLowerCase();
      const tags = extractTags(contact).map((t) => t.trim().toLowerCase());
      return tags.includes(want) ? "match" : "no_match";
    }
    case "custom_field": {
      if (!rule.custom_field_key) return "neutral";
      const value = extractCustomField(contact, rule.custom_field_key);
      if (!rule.custom_field_value) {
        // Sem valor esperado = só precisa existir / ser não-vazio.
        return value ? "match" : "no_match";
      }
      return value.trim().toLowerCase() ===
        rule.custom_field_value.trim().toLowerCase()
        ? "match"
        : "no_match";
    }
    case "pipeline_stage": {
      if (!rule.pipeline_stage_id) return "neutral";
      const m = opps.some((o) => {
        const stageOk =
          (o.pipelineStageId || o.stageId) === rule.pipeline_stage_id;
        const pipelineOk = !rule.pipeline_id || o.pipelineId === rule.pipeline_id;
        return stageOk && pipelineOk;
      });
      return m ? "match" : "no_match";
    }
    case "message": {
      // Sem texto do lead (pill/contexto sem msg) ou fluxo proativo → neutra.
      if (opts.messageText == null || opts.isProactive) return "neutral";
      if (!rule.message_operator) return "neutral";
      const val =
        rule.message_operator === "in"
          ? rule.message_values ?? []
          : rule.message_value ?? "";
      return matchTextOp(rule.message_operator as TextOp, opts.messageText, val, {
        caseSensitive: rule.case_sensitive,
      })
        ? "match"
        : "no_match";
    }
    default:
      return "neutral";
  }
}

function evalGroup(
  group: TargetingGroup,
  contact: GhlContact | null,
  opps: GhlOpp[],
  opts: TargetingOpts,
): LeafResult {
  const results = group.rules
    .map((r) => evalLeaf(r, contact, opps, opts))
    .filter((r): r is "match" | "no_match" => r !== "neutral");
  if (results.length === 0) return "neutral"; // só folhas neutras = grupo neutro
  if (group.match === "any") {
    return results.some((r) => r === "match") ? "match" : "no_match";
  }
  return results.every((r) => r === "match") ? "match" : "no_match"; // "all"
}

/**
 * Avaliador PURO (sem I/O) — exportado pra teste. Recebe o contato/opps já
 * buscados + os opts. `all` = todos os grupos batem; `any` = qualquer grupo.
 * Grupos neutros (só folhas malformadas/sem-texto) são ignorados → se TUDO é
 * neutro, passa (= sem regra efetiva), preservando o legado.
 */
export function evaluateTargetingSet(
  set: TargetingRuleSet,
  contact: GhlContact | null,
  opps: GhlOpp[],
  opts: TargetingOpts = {},
): boolean {
  const results = set.groups
    .map((g) => evalGroup(g, contact, opps, opts))
    .filter((r): r is "match" | "no_match" => r !== "neutral");
  if (results.length === 0) return true;
  if (set.match === "any") return results.some((r) => r === "match");
  return results.every((r) => r === "match"); // "all"
}

/** Quais tipos de folha existem na árvore (pra decidir o fetch GHL). */
function collectLeafTypes(set: TargetingRuleSet): Set<string> {
  const types = new Set<string>();
  for (const g of set.groups) for (const r of g.rules) types.add(r.type);
  return types;
}

/**
 * Verifica se um contato (+ a mensagem, opcional) bate as regras de ativação.
 *
 * @param contactId GHL contact id
 * @param rules `agent_configs.targeting_rules` (array legado OU set v2)
 * @param companyId / locationId — pra GHLClient
 * @param opts messageText (folhas message), isProactive, failMode
 */
export async function checkContactMatchesTargeting(
  contactId: string,
  rules: TargetingRules | null | undefined,
  companyId: string,
  locationId: string,
  opts: TargetingOpts = {},
): Promise<TargetingMatch> {
  const failClosed = opts.failMode === "closed";
  const set = normalizeTargeting(rules);
  if (!set) return { ok: true }; // sem regras = responde a todos (legado)

  if (!contactId || !companyId || !locationId) {
    // Sem dados suficientes — fail conforme o modo (gate=open, roteador=closed).
    return { ok: !failClosed };
  }

  try {
    const client = new GHLClient(companyId, locationId);
    const types = collectLeafTypes(set);
    const needsContact = types.has("tag") || types.has("custom_field");
    const needsOpps = types.has("pipeline_stage");

    const [contactRes, oppsRes] = await Promise.all([
      needsContact
        ? client.get(`/contacts/${contactId}`).catch(() => null)
        : Promise.resolve(null),
      needsOpps
        ? client
            .get(
              `/opportunities/search?contactId=${contactId}&locationId=${locationId}&limit=100`,
            )
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const contact: GhlContact | null =
      contactRes &&
      typeof contactRes === "object" &&
      "contact" in (contactRes as Record<string, unknown>)
        ? ((contactRes as { contact: GhlContact }).contact ?? null)
        : (contactRes as GhlContact | null);

    const opps: GhlOpp[] =
      oppsRes &&
      typeof oppsRes === "object" &&
      "opportunities" in (oppsRes as Record<string, unknown>)
        ? ((oppsRes as { opportunities: GhlOpp[] }).opportunities ?? [])
        : Array.isArray(oppsRes)
          ? (oppsRes as GhlOpp[])
          : [];

    const ok = evaluateTargetingSet(set, contact, opps, opts);
    return ok ? { ok: true } : { ok: false, reason: "regras de ativação não casaram" };
  } catch (err) {
    // Fail conforme o modo. Gate de runtime = open (não silencia o agente);
    // roteador = closed (não escolhe agente errado).
    console.warn(
      `[targeting] check falhou (fail-${failClosed ? "closed" : "open"}):`,
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return { ok: !failClosed };
  }
}
