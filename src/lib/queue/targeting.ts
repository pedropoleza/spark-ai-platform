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
  AttributionField,
  AttributionScope,
} from "@/types/agent";
import { GHLClient } from "@/lib/ghl/client";
import { matchTextOp, type TextOp } from "@/lib/account-assistant/filter-engine/text-ops";
import { deburr } from "@/lib/account-assistant/contact-resolver/normalize";

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
   * true quando a conversa JÁ está ativa (o agente já respondeu ao menos 1×
   * neste segmento). Folhas type="message" são GATILHO DE ATIVAÇÃO (1º contato)
   * — uma vez a conversa ativa, NÃO devem re-bloquear follow-ups (a resposta do
   * lead "Florida"/"sim" não contém a frase de abertura). Fix bug observado em
   * prod 2026-06-18 (caso Marina): folha message única silenciava todo follow-up.
   * Folhas de PERFIL (tag/custom_field/pipeline_stage) continuam valendo (são
   * atributo do contato, não conteúdo de 1 msg).
   */
  conversationActive?: boolean;
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
  // Origem do contato (Pedro 2026-08-11). Vem no MESMO GET /contacts/{id} que
  // este módulo já faz — filtrar por anúncio não custa chamada extra.
  attributionSource?: Record<string, unknown> | null;
  lastAttributionSource?: Record<string, unknown> | null;
}

/** Campos de atribuição considerados pelo seletor `any`. */
const CAMPOS_ATRIBUICAO = [
  "sessionSource", "medium", "campaign", "campaignId", "adId", "adSetId",
  "utmCampaign", "utmMedium", "utmContent", "referrer", "url",
] as const;

/**
 * Texto a comparar numa folha `attribution`.
 *
 * `any` concatena todos os campos preenchidos — é o que atende "só quero saber
 * se veio de anúncio, qualquer coisa preenchida serve". Campo específico devolve
 * só ele. String vazia = ausente (o Spark Leads devolve `null` nos campos que
 * não se aplicam, ex: `adId: null` em contato orgânico).
 */
export function valorDeAtribuicao(
  contact: GhlContact | null | undefined,
  field: AttributionField = "any",
  scope: AttributionScope = "first",
): string {
  const fonte = (scope === "last" ? contact?.lastAttributionSource : contact?.attributionSource) || {};
  const ler = (k: string): string => {
    const v = (fonte as Record<string, unknown>)[k];
    return v === null || v === undefined ? "" : String(v).trim();
  };
  if (field === "any") {
    return CAMPOS_ATRIBUICAO.map(ler).filter(Boolean).join(" | ");
  }
  return ler(field);
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
      // case-insensitive + trim + acento-insensível (F9 follow-up 2026-06-27):
      // deburr nos dois lados → tag salva "Líder" casa o "lider" do GHL e vice-versa.
      const want = deburr(rule.tag);
      const tags = extractTags(contact).map((t) => deburr(t));
      return tags.includes(want) ? "match" : "no_match";
    }
    case "custom_field": {
      if (!rule.custom_field_key) return "neutral";
      const value = extractCustomField(contact, rule.custom_field_key);
      if (!rule.custom_field_value) {
        // Sem valor esperado = só precisa existir / ser não-vazio.
        return value ? "match" : "no_match";
      }
      // deburr nos dois lados (F9 follow-up): "São Paulo" salvo casa "Sao Paulo" no CRM.
      return deburr(value) === deburr(rule.custom_field_value)
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
      // Neutra quando: sem texto do lead (pill/contexto sem msg), fluxo proativo,
      // OU conversa já ativa (folha message é gatilho de ATIVAÇÃO no 1º contato —
      // não re-bloqueia follow-ups; ver TargetingOpts.conversationActive).
      if (!opts.messageText || opts.isProactive || opts.conversationActive) return "neutral";
      if (!rule.message_operator) return "neutral";
      const val =
        rule.message_operator === "in"
          ? rule.message_values ?? []
          : rule.message_value ?? "";
      // Needle vazio → NEUTRA (defesa em profundidade, review 2026-06-18). Sem
      // isso, matchTextOp("contains", t, "") casaria QUALQUER msg (catch-all) e
      // "not_contains" com "" bloquearia tudo. A UI já limpa folha vazia
      // (cleanTargetingRules), mas uma regra salva via API direta furava.
      const needleEmpty = Array.isArray(val) ? !val.some((v) => v.trim()) : !val.trim();
      if (needleEmpty) return "neutral";
      return matchTextOp(rule.message_operator as TextOp, opts.messageText, val, {
        caseSensitive: rule.case_sensitive,
      })
        ? "match"
        : "no_match";
    }
    case "attribution": {
      // Pedro 2026-08-11: "veio de anúncio?" sem depender de tag aplicada por
      // workflow. Diferente da folha `message`, esta NÃO é neutra em conversa
      // ativa nem em proativo — a origem do contato não muda com o turno.
      const op = rule.attribution_operator;
      if (!op) return "neutral";
      const texto = valorDeAtribuicao(
        contact,
        rule.attribution_field || "any",
        rule.attribution_scope || "first",
      );

      if (op === "is_set") return texto ? "match" : "no_match";
      if (op === "not_set") return texto ? "no_match" : "match";

      const val = op === "in" ? rule.attribution_values ?? [] : rule.attribution_value ?? "";
      // Needle vazio → NEUTRA (mesma defesa da folha `message`): sem isso,
      // "contains" com "" casaria qualquer contato e "not_contains" bloquearia
      // todos. Quem quer só presença usa is_set/not_set, que é explícito.
      const needleEmpty = Array.isArray(val) ? !val.some((v) => v.trim()) : !val.trim();
      if (needleEmpty) return "neutral";

      // Sem atribuição nenhuma: só "not_contains" faz sentido dar match (o
      // contato realmente NÃO contém aquilo). Os demais são no_match — evita
      // que contato sem origem entre por acidente num filtro de anúncio.
      if (!texto) return op === "not_contains" ? "match" : "no_match";

      return matchTextOp(op as TextOp, texto, val, { caseSensitive: rule.case_sensitive })
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
    // `attribution` lê do próprio contato (attributionSource) — sem ele aqui, o
    // GET nem aconteceria e a regra de origem nunca casaria em produção.
    const needsContact =
      types.has("tag") || types.has("custom_field") || types.has("attribution");
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
