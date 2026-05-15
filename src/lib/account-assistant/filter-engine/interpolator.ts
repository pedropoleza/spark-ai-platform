/**
 * Filter Engine — template interpolator (H28).
 *
 * Substitui placeholders num template usando dados do contato:
 *  {first_name}              — primeiro nome
 *  {last_name}               — sobrenome
 *  {full_name}               — nome completo
 *  {email}                   — email
 *  {phone}                   — phone E.164
 *  {tags[0]} {tags[i]}       — tag por índice
 *  {custom.field_key}        — valor de custom field por slug ou ID
 *  {opportunity.stage_name}  — stage da opp ativa (mais recente open)
 *  {opportunity.value}       — monetaryValue da opp ativa
 *
 * Fallback configurável quando placeholder não tem valor:
 *  - strict (default): retorna { ok:false, missing: ['campo'] }
 *  - empty: substitui por ""
 *  - placeholder: substitui por "[sem dado]"
 *
 * Validation: parseTemplate(text) → lista de placeholders detectados,
 * útil pra preview ("você usou {tags[3]} mas contatos têm no max 2 tags").
 */

import type { ContactResult } from "./types";
import { getCustomFields } from "./cache";
import type { GHLClient } from "@/lib/ghl/client";

export interface InterpolationContext {
  contact: ContactResult;
  /** Custom fields mapping pra resolver {custom.slug} → valor */
  custom_field_resolver?: Map<string, string>;
  /** Opportunity ativa do contato (mais recente status=open) */
  active_opportunity?: {
    stage_name?: string;
    stage_id?: string;
    monetary_value?: number;
    pipeline_id?: string;
  };
}

export interface InterpolationOptions {
  fallback?: "strict" | "empty" | "placeholder";
  placeholder_text?: string; // se fallback=placeholder
}

export interface InterpolationResult {
  ok: boolean;
  text: string;
  missing: string[];
  found: string[];
}

const PLACEHOLDER_REGEX = /\{([a-z_]+(?:\.[a-z0-9_]+)?(?:\[\d+\])?)\}/gi;

export function interpolate(
  template: string,
  ctx: InterpolationContext,
  options: InterpolationOptions = {},
): InterpolationResult {
  const fallback = options.fallback || "strict";
  const placeholderText = options.placeholder_text || "[sem dado]";

  const missing: string[] = [];
  const found: string[] = [];

  const text = template.replace(PLACEHOLDER_REGEX, (full, key: string) => {
    const value = resolvePlaceholder(key, ctx);
    if (value === undefined || value === null || value === "") {
      missing.push(key);
      if (fallback === "empty") return "";
      if (fallback === "placeholder") return placeholderText;
      return full; // strict: deixa placeholder intacto, marca como missing
    }
    found.push(key);
    return String(value);
  });

  return {
    ok: missing.length === 0,
    text,
    missing,
    found,
  };
}

function resolvePlaceholder(key: string, ctx: InterpolationContext): unknown {
  const c = ctx.contact;

  // tags[N]
  const tagMatch = key.match(/^tags\[(\d+)\]$/);
  if (tagMatch) {
    const idx = parseInt(tagMatch[1], 10);
    return c.tags?.[idx];
  }

  // custom.slug
  if (key.startsWith("custom.")) {
    const slug = key.slice("custom.".length);
    if (ctx.custom_field_resolver) {
      // resolver é mapping de slug → CF id; depois lê do contact.customFields
      const cfId = ctx.custom_field_resolver.get(slug.toLowerCase());
      if (cfId && c.customFields) {
        const cf = c.customFields.find((f) => f.id === cfId || f.key === slug);
        return cf?.value;
      }
    }
    // Fallback: lê direto se contact tem por slug
    if (c.customFields) {
      const cf = c.customFields.find((f) => f.key === slug);
      if (cf) return cf.value;
    }
    return undefined;
  }

  // opportunity.X
  if (key.startsWith("opportunity.")) {
    const sub = key.slice("opportunity.".length);
    if (!ctx.active_opportunity) return undefined;
    switch (sub) {
      case "stage_name": return ctx.active_opportunity.stage_name;
      case "stage_id": return ctx.active_opportunity.stage_id;
      case "value":
      case "monetary_value":
        return ctx.active_opportunity.monetary_value;
      case "pipeline_id":
        return ctx.active_opportunity.pipeline_id;
      default: return undefined;
    }
  }

  // Standard fields
  switch (key.toLowerCase()) {
    case "first_name":
    case "firstname":
      return c.firstName || (c.name ? c.name.split(" ")[0] : undefined);
    case "last_name":
    case "lastname":
      return c.lastName || (c.name && c.name.includes(" ")
        ? c.name.split(" ").slice(1).join(" ")
        : undefined);
    case "full_name":
    case "name":
      return c.name || [c.firstName, c.lastName].filter(Boolean).join(" ");
    case "email":
      return c.email;
    case "phone":
      return c.phone;
    default:
      return undefined;
  }
}

/**
 * Parse template e retorna lista de placeholders únicos. Útil pra
 * preview: bot mostra "esse template usa: {first_name}, {tags[0]}" pro
 * rep validar antes de disparar.
 */
export function parseTemplate(template: string): string[] {
  const set = new Set<string>();
  const regex = new RegExp(PLACEHOLDER_REGEX.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = regex.exec(template)) !== null) {
    set.add(match[1]);
  }
  return Array.from(set);
}

/**
 * Helper pra construir custom_field_resolver pra uma location.
 * Mapeia slug.toLowerCase() → id. Útil pra interpolation sem fetch
 * por contato.
 */
export async function buildCustomFieldResolver(
  ghl: GHLClient,
  location_id: string,
): Promise<Map<string, string>> {
  const cfs = await getCustomFields(ghl, location_id);
  const map = new Map<string, string>();
  for (const cf of cfs) {
    if (cf.fieldKey) map.set(cf.fieldKey.toLowerCase(), cf.id);
    if (cf.name) map.set(cf.name.toLowerCase(), cf.id);
    map.set(cf.id.toLowerCase(), cf.id); // self-reference
  }
  return map;
}
