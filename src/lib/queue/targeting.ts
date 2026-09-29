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

/**
 * H81 (caso Bianca 2026-08-26): aplica `negate` sobre a folha crua.
 *
 * NEUTRO NUNCA É INVERTIDO — é a propriedade de segurança inteira desta função.
 * Folha neutra significa "malformada / não se aplica a este turno" (tag vazia,
 * folha `message` sem texto do lead, operador ausente). Invertê-la transformaria
 * uma regra quebrada num catch-all que atende TODO MUNDO — exatamente o estrago
 * que a exclusão existe pra impedir.
 */
function evalLeaf(
  rule: TargetingRule,
  contact: GhlContact | null,
  opps: GhlOpp[],
  opts: TargetingOpts,
): LeafResult {
  const raw = evalLeafRaw(rule, contact, opps, opts);
  if (!rule.negate || raw === "neutral") return raw;
  return raw === "match" ? "no_match" : "match";
}

function evalLeafRaw(
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

/**
 * Composição E/OU com o avaliador de folha como parâmetro. É a MESMA regra de
 * sempre (neutro não conta; grupo só de neutras é neutro; set só de neutros
 * passa) e existe pra que a projeção de exclusão (H97) componha a árvore com a
 * semântica idêntica à do gate completo, sem uma segunda cópia da lógica.
 */
type AvaliadorDeFolha = (rule: TargetingRule) => LeafResult;

function composeGroup(group: TargetingGroup, folha: AvaliadorDeFolha): LeafResult {
  const results = group.rules
    .map((r) => folha(r))
    .filter((r): r is "match" | "no_match" => r !== "neutral");
  if (results.length === 0) return "neutral"; // só folhas neutras = grupo neutro
  if (group.match === "any") {
    return results.some((r) => r === "match") ? "match" : "no_match";
  }
  return results.every((r) => r === "match") ? "match" : "no_match"; // "all"
}

function composeSet(set: TargetingRuleSet, folha: AvaliadorDeFolha): boolean {
  const results = set.groups
    .map((g) => composeGroup(g, folha))
    .filter((r): r is "match" | "no_match" => r !== "neutral");
  if (results.length === 0) return true;
  if (set.match === "any") return results.some((r) => r === "match");
  return results.every((r) => r === "match"); // "all"
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
  return composeSet(set, (r) => evalLeaf(r, contact, opps, opts));
}

/* ── H97: a exclusão vale mesmo quando o targeting é pulado ───────────────
 *
 * Fix bug observado em prod 2026-09-28 (conta da Jussara, agente a297dadc):
 * em `trigger_once` com conversa já ativa o queue-processor pula o targeting
 * INTEIRO (H51), e o runner de follow-up nunca olhou targeting nenhum. Então a
 * exclusão do H81 ("não atender quem tem a tag active client") só barrava a
 * PRIMEIRA mensagem: quem virou cliente depois de entrar seguia atendido, e a
 * IA respondeu clientes com apólice prometendo coisas a eles.
 *
 * Inclusão e exclusão são coisas diferentes. A folha de inclusão é a PORTA (o
 * trigger_once existe justamente pra não reavaliá-la a cada turno); a folha de
 * exclusão é um atributo do CONTATO que pode passar a valer depois da entrada
 * (virou cliente). Por isso aqui só a exclusão é avaliada.
 */

export interface ExclusaoResultado {
  /** true = alguma folha de exclusão barra este contato. */
  excluded: boolean;
  /** Folhas de exclusão que casaram com o contato, legíveis (vão pro execution_log). */
  motivos: string[];
  /** Preenchido quando não deu pra avaliar. Fail-open: `excluded` vem false. */
  erro?: string;
}

/** Folhas marcadas como EXCLUIR (negate) em qualquer grupo. */
export function folhasDeExclusao(set: TargetingRuleSet): TargetingRule[] {
  return set.groups.flatMap((g) => g.rules.filter((r) => r?.negate === true));
}

/** Descrição curta da condição de uma folha, pro execution_log. */
export function descreveFolha(rule: TargetingRule): string {
  switch (rule.type) {
    case "tag":
      return `tag "${rule.tag ?? ""}"`;
    case "custom_field":
      return rule.custom_field_value
        ? `campo ${rule.custom_field_key} = "${rule.custom_field_value}"`
        : `campo ${rule.custom_field_key} preenchido`;
    case "pipeline_stage":
      return `etapa ${rule.pipeline_stage_id}${rule.pipeline_id ? ` (pipeline ${rule.pipeline_id})` : ""}`;
    case "attribution":
      return `origem ${rule.attribution_field || "any"} ${rule.attribution_operator ?? ""} "${
        rule.attribution_operator === "in"
          ? (rule.attribution_values ?? []).join(", ")
          : rule.attribution_value ?? ""
      }"`;
    case "message":
      return `mensagem ${rule.message_operator ?? ""} "${rule.message_value ?? ""}"`;
    default:
      return String(rule.type);
  }
}

/**
 * Avaliador PURO da exclusão (sem I/O), exportado pra teste.
 *
 * Projeção sobre a MESMA árvore do gate: folha de inclusão conta como "match"
 * (o contato já passou pela porta; reavaliá-la é o que o trigger_once evita) e
 * folha de exclusão é avaliada de verdade pelo `evalLeaf`, que preserva o H81
 * (neutro nunca é invertido). O contato é barrado quando a árvore não passa
 * nem com toda a inclusão satisfeita.
 *
 * Duas consequências de propósito:
 *  - Nunca barra quem o gate completo deixaria passar com as mesmas tags: a
 *    árvore é E/OU de folhas, então virar inclusão pra "match" só pode ajudar.
 *    Sem essa garantia, a exclusão podia recriar o "responde a 1ª e morre"
 *    (H51/H96) numa árvore com exclusão dentro de grupo OU.
 *  - Na forma que a frota usa (grupo só de exclusões ligado por E ao resto)
 *    vale como veto puro: qualquer tag excluída presente barra.
 *
 * Folha `message` é neutra aqui (`conversationActive`): conteúdo de mensagem é
 * gatilho de ENTRADA, igual à inclusão por frase. O que vale sempre é atributo
 * do contato (tag, campo, etapa, origem).
 */
export function avaliarExclusao(
  set: TargetingRuleSet,
  contact: GhlContact | null,
  opps: GhlOpp[],
): { excluded: boolean; motivos: string[] } {
  if (folhasDeExclusao(set).length === 0) return { excluded: false, motivos: [] };
  const opts: TargetingOpts = { conversationActive: true };
  const casaram: TargetingRule[] = [];
  const passa = composeSet(set, (r) => {
    if (!r) return "neutral"; // folha nula = malformada = neutra
    if (!r.negate) return "match";
    const res = evalLeaf(r, contact, opps, opts);
    if (res === "no_match") casaram.push(r); // negada e no_match = o contato TEM a condição
    return res;
  });
  if (passa) return { excluded: false, motivos: [] };
  return { excluded: true, motivos: casaram.map(descreveFolha) };
}

function contatoDaResposta(res: unknown): GhlContact | null {
  if (!res || typeof res !== "object") return null;
  if ("contact" in (res as Record<string, unknown>)) {
    return (res as { contact?: GhlContact | null }).contact ?? null;
  }
  return res as GhlContact;
}

function oppsDaResposta(res: unknown): GhlOpp[] {
  if (res && typeof res === "object" && "opportunities" in (res as Record<string, unknown>)) {
    return (res as { opportunities?: GhlOpp[] }).opportunities ?? [];
  }
  return Array.isArray(res) ? (res as GhlOpp[]) : [];
}

/**
 * O contato está EXCLUÍDO do público deste agente? (H97)
 *
 * Pra usar onde o targeting completo NÃO roda: turno de conversa ativa em
 * `trigger_once`, turno com retomada manual e runner de follow-up.
 *
 * Sem regra ou sem folha de exclusão = zero I/O (os agentes sem `negate` não
 * pagam nada). `opts.contact` reaproveita um contato já buscado pelo caller (o
 * runner já faz o GET pro DND); sem ele, busca `GET /contacts/{id}`.
 *
 * FAIL-OPEN de verdade: se o GET falhar, a resposta é "não excluído" e o erro
 * vem em `erro`. Diferente do `checkContactMatchesTargeting`, aqui erro de
 * fetch NÃO vira "contato sem tags" (lá o `.catch(() => null)` faria uma folha
 * negada de origem `not_set` barrar por erro). Um problema nosso de leitura
 * nunca cala a IA.
 */
export async function checkContactExclusion(
  contactId: string,
  rules: TargetingRules | null | undefined,
  companyId: string | null | undefined,
  locationId: string,
  opts: { contact?: object | null } = {},
): Promise<ExclusaoResultado> {
  const naoExcluido = (erro?: string): ExclusaoResultado =>
    erro ? { excluded: false, motivos: [], erro } : { excluded: false, motivos: [] };

  const set = normalizeTargeting(rules);
  if (!set) return naoExcluido();
  const exclusoes = folhasDeExclusao(set);
  if (exclusoes.length === 0) return naoExcluido();

  const tipos = new Set(exclusoes.map((r) => r.type));
  const precisaContato = tipos.has("tag") || tipos.has("custom_field") || tipos.has("attribution");
  const precisaOpps = tipos.has("pipeline_stage");
  // Só exclusão por mensagem (neutra aqui) ou tipo desconhecido: nada a buscar.
  if (!precisaContato && !precisaOpps) return naoExcluido();

  let contato: GhlContact | null = (opts.contact as GhlContact | null | undefined) ?? null;
  const buscarContato = precisaContato && !contato;
  if (!contactId || !locationId || ((buscarContato || precisaOpps) && !companyId)) {
    return naoExcluido("sem dados pra avaliar a exclusão");
  }

  try {
    let opps: GhlOpp[] = [];
    if (buscarContato || precisaOpps) {
      const client = new GHLClient(companyId as string, locationId);
      const [contatoRes, oppsRes] = await Promise.all([
        buscarContato ? client.get<unknown>(`/contacts/${contactId}`) : Promise.resolve(null),
        precisaOpps
          ? client.get<unknown>(
              `/opportunities/search?contactId=${contactId}&locationId=${locationId}&limit=100`,
            )
          : Promise.resolve(null),
      ]);
      if (buscarContato) {
        contato = contatoDaResposta(contatoRes);
        if (!contato) return naoExcluido("contato veio vazio do Spark Leads");
      }
      opps = oppsDaResposta(oppsRes);
    }
    return avaliarExclusao(set, contato, opps);
  } catch (err) {
    const msg = err instanceof Error ? err.message.slice(0, 200) : String(err);
    console.warn(`[targeting] exclusão não avaliada (fail-open): ${msg}`);
    return naoExcluido(msg);
  }
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
