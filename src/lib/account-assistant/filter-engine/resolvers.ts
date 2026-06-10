/**
 * Filter Engine — alias resolvers.
 *
 * LLM raramente fornece UUIDs. Resolvers traduzem nomes amigáveis pra
 * IDs reais, usando cache:
 *
 *  - opportunity.stageName: "M3" → stage UUID (via /opportunities/pipelines)
 *  - customField.aap_range → customField.{uuid} via slug match
 *  - assignedTo: "self"/"me"/"eu" → ghl_user_id do rep (já tem helper)
 *  - rep_profile.aliases ({ "M2": "M2 dos 5 ao 20k" }) — expandidos
 *    ANTES de qualquer resolução de stageName
 *
 * Erros (alias not found / ambiguous) viram FilterEngineError com code
 * específico — bot recebe mensagem útil pra corrigir.
 */

import type { FilterExecutionContext, FilterExpression, FilterCondition } from "./types";
import { FilterEngineError, isComposite, isLeaf } from "./types";
import {
  getPipelines,
  getCustomFields,
  getOpportunityCustomFields,
  type CachedCustomField,
} from "./cache";

const SELF_ALIASES = ["self", "me", "eu", "rep", "myself", "self_user"];

// =====================================================================
// Public entry — resolve aliases recursivamente em todo o FEL
// =====================================================================

export interface ResolveResult {
  expr: FilterExpression;
  applied: Record<string, string>;   // alias → resolved value
  warnings: string[];
}

export async function resolveAliases(
  expr: FilterExpression,
  ctx: FilterExecutionContext,
  options: { bypass_cache?: boolean } = {},
): Promise<ResolveResult> {
  const applied: Record<string, string> = {};
  const warnings: string[] = [];

  // Aplica rep_profile.aliases antes (expansão textual em values string)
  // Ex: rep.profile.aliases = { "M2": "M2 dos 5 ao 20k" }
  // Se rep falar "M2", LLM passa value="M2", e aqui expandimos pra "M2 dos 5 ao 20k"
  // (que aí o stage resolver vai buscar matching em pipelines).
  const expanded = expandRepAliases(expr, ctx.rep_aliases || {});

  // Depois resolve aliases técnicos (stageName→stageId, customField slug→id, self→user_id)
  const resolved = await resolveFromExpr(expanded, ctx, applied, warnings, options);

  return { expr: resolved, applied, warnings };
}

// =====================================================================
// Internal: expand rep_profile.aliases (textual)
// =====================================================================

function expandRepAliases(
  expr: FilterExpression,
  aliases: Record<string, string>,
): FilterExpression {
  if (Object.keys(aliases).length === 0) return expr;

  return walk(expr, (cond) => {
    if (typeof cond.value !== "string") return cond;
    const lower = cond.value.toLowerCase().trim();
    // Procura match case-insensitive
    for (const [alias, expansion] of Object.entries(aliases)) {
      if (alias.toLowerCase() === lower) {
        return { ...cond, value: expansion };
      }
    }
    return cond;
  });
}

// =====================================================================
// Internal: resolução técnica (precisa cache)
// =====================================================================

async function resolveFromExpr(
  expr: FilterExpression,
  ctx: FilterExecutionContext,
  applied: Record<string, string>,
  warnings: string[],
  options: { bypass_cache?: boolean },
): Promise<FilterExpression> {
  if (isComposite(expr)) {
    if ("all" in expr) {
      const resolved = await Promise.all(
        expr.all.map((e) => resolveFromExpr(e, ctx, applied, warnings, options)),
      );
      return { all: resolved };
    }
    if ("any" in expr) {
      const resolved = await Promise.all(
        expr.any.map((e) => resolveFromExpr(e, ctx, applied, warnings, options)),
      );
      return { any: resolved };
    }
    if ("not" in expr) {
      const resolved = await resolveFromExpr(expr.not, ctx, applied, warnings, options);
      return { not: resolved };
    }
  }
  if (isLeaf(expr)) {
    return resolveLeaf(expr, ctx, applied, warnings, options);
  }
  throw new FilterEngineError(
    `FilterExpression inválida: ${JSON.stringify(expr).slice(0, 80)}`,
    "INVALID_FEL",
  );
}

async function resolveLeaf(
  cond: FilterCondition,
  ctx: FilterExecutionContext,
  applied: Record<string, string>,
  warnings: string[],
  options: { bypass_cache?: boolean },
): Promise<FilterCondition> {
  // 1) opportunity.stageName → opportunity.stageId
  if (cond.field === "opportunity.stageName") {
    if (typeof cond.value !== "string") {
      throw new FilterEngineError(
        `opportunity.stageName requer value string (got ${typeof cond.value})`,
        "INVALID_VALUE",
        { cond },
      );
    }
    const { stage_id, label } = await resolveStageName(
      cond.value,
      ctx,
      cond.op === "contains" || cond.op === "in",
      options,
    );
    applied[`stageName:${cond.value}`] = `${stage_id} (${label})`;
    return {
      field: "opportunity.stageId",
      op: cond.op === "in" ? "in" : "eq",
      value: stage_id,
    };
  }

  // 2a) opportunity.customField.{slug-or-id} — Pedro 2026-05-15
  // NB-9 (review 2026-06-10): resolve por slug PRIMEIRO; ref só vira id literal
  // se bater num cf.id real. Ver resolveCustomFieldRef pro porquê (bug prod).
  if (cond.field.startsWith("opportunity.customField.")) {
    const ref = cond.field.slice("opportunity.customField.".length);
    const resolvedId = await resolveCustomFieldRef(ref, ctx, options, "opportunity");
    if (!resolvedId) {
      throw new FilterEngineError(
        `Custom field de opportunity '${ref}' não encontrado nesta location. ` +
          `Use describe_filter_capabilities pra ver fields disponíveis.`,
        "ALIAS_NOT_FOUND",
        { slug: ref, model: "opportunity" },
      );
    }
    if (resolvedId === ref) return cond; // ref já era o id real — passa direto
    applied[`opportunity.customField.${ref}`] = resolvedId;
    return {
      field: `opportunity.customField.${resolvedId}` as FilterCondition["field"],
      op: cond.op,
      value: cond.value,
    };
  }

  // 2b) customField.{slug-or-id} (contact) — se for slug, resolve pro id
  // NB-9 (review 2026-06-10): slug-first, ver resolveCustomFieldRef.
  if (cond.field.startsWith("customField.")) {
    const ref = cond.field.slice("customField.".length);
    const resolvedId = await resolveCustomFieldRef(ref, ctx, options, "contact");
    if (!resolvedId) {
      throw new FilterEngineError(
        `Custom field de contact '${ref}' não encontrado nesta location. ` +
          `Use describe_filter_capabilities pra ver fields disponíveis. ` +
          `Se '${ref}' for um custom field de OPPORTUNITY, use 'opportunity.customField.${ref}' no field.`,
        "ALIAS_NOT_FOUND",
        { slug: ref, model: "contact" },
      );
    }
    if (resolvedId === ref) return cond; // ref já era o id real — passa direto
    applied[`customField.${ref}`] = resolvedId;
    return {
      field: `customField.${resolvedId}` as FilterCondition["field"],
      op: cond.op,
      value: cond.value,
    };
  }

  // 3) assignedTo 'self' → rep ghl_user_id
  if (
    (cond.field === "assignedTo" || cond.field === "opportunity.assignedTo") &&
    typeof cond.value === "string" &&
    SELF_ALIASES.includes(cond.value.toLowerCase().trim())
  ) {
    const repUserId = await resolveSelfUserId(ctx);
    if (!repUserId) {
      throw new FilterEngineError(
        "Não consegui resolver 'self' pro ghl_user_id do rep nesta location.",
        "ALIAS_NOT_FOUND",
      );
    }
    applied[`assignedTo:self`] = repUserId;
    return { ...cond, value: repUserId };
  }

  // 4) Arrays com 'self' embutido
  if (
    (cond.field === "assignedTo" || cond.field === "opportunity.assignedTo") &&
    Array.isArray(cond.value)
  ) {
    const expanded: string[] = [];
    for (const v of cond.value) {
      const s = String(v).toLowerCase().trim();
      if (SELF_ALIASES.includes(s)) {
        const repUserId = await resolveSelfUserId(ctx);
        if (repUserId) expanded.push(repUserId);
      } else {
        expanded.push(String(v));
      }
    }
    return { ...cond, value: expanded };
  }

  return cond;
}

// =====================================================================
// Resolver helpers
// =====================================================================

async function resolveStageName(
  raw: string,
  ctx: FilterExecutionContext,
  allow_multiple: boolean,
  options: { bypass_cache?: boolean },
): Promise<{ stage_id: string; label: string }> {
  const pipelines = await getPipelines(ctx.ghl_client, ctx.location_id, options);
  const q = raw.toLowerCase().trim();
  const exact: Array<{ stage_id: string; label: string }> = [];
  const partial: typeof exact = [];

  for (const p of pipelines) {
    for (const s of p.stages) {
      const sn = (s.name || "").toLowerCase().trim();
      if (!sn) continue;
      const label = `${p.name} → ${s.name}`;
      if (sn === q) exact.push({ stage_id: s.id, label });
      else if (sn.includes(q) || q.includes(sn)) partial.push({ stage_id: s.id, label });
    }
  }

  const matches = exact.length > 0 ? exact : partial;
  if (matches.length === 0) {
    throw new FilterEngineError(
      `Stage '${raw}' não encontrado em nenhum pipeline. Use describe_filter_capabilities ou list_pipelines pra ver opções.`,
      "ALIAS_NOT_FOUND",
      { stage_name: raw },
    );
  }
  if (matches.length > 1 && !allow_multiple) {
    const list = matches
      .slice(0, 8)
      .map((m) => `${m.label} (id: ${m.stage_id})`)
      .join("; ");
    throw new FilterEngineError(
      `Stage '${raw}' tem ${matches.length} matches: ${list}. Passe stageId direto ou use stageName mais específico.`,
      "ALIAS_AMBIGUOUS",
      { stage_name: raw, matches },
    );
  }
  return matches[0];
}

/**
 * Resolve um ref de custom field (slug / fieldKey / name humano OU um id já
 * resolvido) pro id REAL do GHL desta location. Retorna o id ou null.
 *
 * NB-9 (review 2026-06-10): ANTES, resolveLeaf decidia "isto já é id?" por um
 * heurístico de SHAPE (`looksLikeGhlUuid` = /^[A-Za-z0-9]{18,}$/) ANTES de tentar
 * resolver o slug. Isso classificava errado qualquer fieldKey/slug SEM separador
 * com 18+ chars (`averageannualpremiumrange`, `clientpolicyanniversary`,
 * `policyanniversarydate`) como id, PULAVA o resolver e mandava o slug cru
 * downstream. Resultado em prod (silencioso, zero erro):
 *   - contact CF + op server-side (eq): compiler manda `customFieldId=<slug>`
 *     pro contacts_search_v2 → GHL devolve 0 matches SEM erro.
 *   - opportunity CF / ops client-side: extractFieldValue faz
 *     `cfs.find(c => c.id === ref)` → undefined em toda linha → 0 matches.
 * GHL gera fieldKey com `_` (espaços→underscore), então campos multi-palavra
 * escapavam; campos de 1 palavra longa ou key manual/importada caíam no bug.
 *
 * Fix: a lista de CFs da location é a FONTE DA VERDADE (e já re-fetch quando o
 * cache está stale). Tenta resolver por slug/fieldKey/name PRIMEIRO; só trata o
 * ref como id literal se ele bater num `cf.id` real. Senão devolve null → caller
 * dispara ALIAS_NOT_FOUND (erro útil, não zero silencioso). Elimina o
 * falso-positivo (slug≥18 tratado como id) E o falso-negativo (id curto/qualquer
 * shape tratado como slug → ALIAS_NOT_FOUND espúrio).
 */
async function resolveCustomFieldRef(
  ref: string,
  ctx: FilterExecutionContext,
  options: { bypass_cache?: boolean },
  model: "contact" | "opportunity",
): Promise<string | null> {
  const cfs =
    model === "opportunity"
      ? await getOpportunityCustomFields(ctx.ghl_client, ctx.location_id, options)
      : await getCustomFields(ctx.ghl_client, ctx.location_id, options);

  // 1) slug / fieldKey / name → id
  const bySlug = matchCustomFieldBySlug(cfs, ref);
  if (bySlug) return bySlug.id;

  // 2) ref já é um id real desta location? (passa direto)
  if (cfs.some((cf) => cf.id === ref)) return ref;

  // 3) nem slug conhecido nem id conhecido
  return null;
}

/**
 * Match puro de um slug/fieldKey/name contra a lista de CFs (sem fetch).
 * Ordem: fieldKey exato (com/sem prefix model) → name exato → name parcial.
 */
function matchCustomFieldBySlug(
  cfs: CachedCustomField[],
  slug: string,
): CachedCustomField | null {
  const q = slug.toLowerCase().trim();
  // GHL fieldKey vem com prefix model (ex: 'opportunity.policy_anniversary')
  // — tira prefix antes de comparar pra match user-friendly:
  // user passou 'policy_anniversary', cf.fieldKey é 'opportunity.policy_anniversary'.
  const stripPrefix = (s: string): string => {
    const lower = s.toLowerCase();
    if (lower.startsWith("contact.")) return lower.slice("contact.".length);
    if (lower.startsWith("opportunity.")) return lower.slice("opportunity.".length);
    return lower;
  };
  // Match exato no fieldKey (com OU sem prefix)
  for (const cf of cfs) {
    if ((cf.fieldKey || "").toLowerCase() === q) return cf;
    if (stripPrefix(cf.fieldKey || "") === q) return cf;
  }
  for (const cf of cfs) {
    if ((cf.name || "").toLowerCase() === q) return cf;
  }
  // Partial em name
  for (const cf of cfs) {
    if ((cf.name || "").toLowerCase().includes(q)) return cf;
  }
  return null;
}

async function resolveSelfUserId(ctx: FilterExecutionContext): Promise<string | null> {
  // Acessa rep via DB ou cache de identity? Conservador: caller deve injetar
  // rep_id no context; aqui retornamos null se context não tiver.
  // Em prática, executor injeta via `rep_aliases.__self_user_id` quando
  // applicable. Caller real (tools) usa getRepGhlUserId que já existe.
  return (ctx.rep_aliases?.["__self_user_id"] || null) || null;
}

// =====================================================================
// Helpers
// =====================================================================

/** Walk recursivamente, aplicando transform a cada FilterCondition leaf. */
function walk(
  expr: FilterExpression,
  transform: (cond: FilterCondition) => FilterCondition,
): FilterExpression {
  if (isComposite(expr)) {
    if ("all" in expr) return { all: expr.all.map((e) => walk(e, transform)) };
    if ("any" in expr) return { any: expr.any.map((e) => walk(e, transform)) };
    if ("not" in expr) return { not: walk(expr.not, transform) };
  }
  if (isLeaf(expr)) return transform(expr);
  return expr;
}
