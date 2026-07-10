/**
 * resolveContact (H45, 2026-06-26) — camada determinística de resolução de contato.
 * Escada de baixo custo (para no 1º hit forte), tolerante a typo/acento/nome-completo/telefone,
 * com SCORE de confiança. Reusa o GET /contacts/?query (proven) com VARIANTES de termo
 * (nome completo → primeiro → último) e ranqueia client-side — em vez do GET single-term cru que
 * falha em "Fernanda Lira" (caso âncora). Devolve {best, score, gap, sole} pro caller decidir
 * a confidence (auto-confirma / confirma-nome / lista / "não achei").
 *
 * Decisões de score (hardening pós-review adversarial 2026-06-26):
 * - `score` = similaridade PURA (base). Recência NÃO entra no score — só desempata ordem.
 * - `gap` = base[0]-base[1] quando há ≥2 candidatos; com 1 só, gap=0 (sole não é dominância).
 * - telefone: E.164 completo igual = 1.0; só sufixo = ≤0.7 (nunca habilita "high" sozinho).
 * - nome ausente ("(sem nome)") NÃO é tokenizado (não casa query 'nome'/'sem').
 */
import type { GHLClient } from "@/lib/ghl/client";
import { searchContactsList } from "@/lib/ghl/operations";
import { normalizePhone } from "../identity";
import { nameScore, nameTokens, phoneDigits, phoneSuffixScore, looksLikePhone } from "./normalize";

export interface ResolvedContact {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  tags: string[];
  last_activity: string | null;
}

export interface ResolveResult {
  best: ResolvedContact | null;
  /** Confiança 0..1 do best — similaridade PURA (sem boost de recência). */
  score: number;
  /** Distância pro 2º colocado (base). 0 quando só há 1 candidato (sole). */
  gap: number;
  /** true quando o GHL devolveu um único candidato plausível (gap não é evidência de dominância). */
  sole: boolean;
  alternatives: Array<ResolvedContact & { score: number }>;
  method: "phone" | "name" | "empty";
  tried: string[];
}

interface RawContact {
  id?: string;
  firstName?: string; lastName?: string; contactName?: string; name?: string;
  email?: string; phone?: string; tags?: string[]; lastActivity?: string; dateUpdated?: string;
}

interface Scored extends ResolvedContact { score: number; _rec: number }

function realName(c: RawContact): string {
  // NÃO inclui placeholder "(sem nome)" — só nome real do cadastro.
  return [c.firstName, c.lastName].filter(Boolean).join(" ") || c.contactName || c.name || "";
}
function displayName(c: RawContact): string {
  return realName(c) || "(sem nome)";
}
function toResolved(c: RawContact): ResolvedContact {
  return {
    id: String(c.id),
    name: displayName(c),
    email: c.email || null,
    phone: c.phone || null,
    tags: c.tags || [],
    last_activity: c.lastActivity || c.dateUpdated || null,
  };
}

async function ghlGet(client: GHLClient, locationId: string, term: string, limit: number): Promise<RawContact[]> {
  try {
    const res = (await searchContactsList(client, locationId, term, limit)) as { contacts?: RawContact[] };
    return (res.contacts || []).filter((c) => c.id);
  } catch {
    return [];
  }
}

/** Recência → desempate de ORDEM apenas (nunca entra no score/confidence). */
function recencyRank(c: ResolvedContact, recentIds?: Set<string>): number {
  if (recentIds?.has(c.id)) return 3;
  if (!c.last_activity) return 0;
  const t = Date.parse(c.last_activity);
  if (Number.isNaN(t)) return 0;
  const days = (Date.now() - t) / 86400000;
  return days < 7 ? 2 : days < 30 ? 1 : 0;
}

/** Score de telefone: E.164 completo igual = 1.0; só sufixo nunca passa de 0.7. */
function phoneScore(queryE164Digits: string, queryDigits: string, candPhone: unknown): number {
  if (!candPhone) return 0;
  const cand = phoneDigits(candPhone);
  if (!cand) return 0;
  if (queryE164Digits && queryE164Digits === cand) return 1; // número completo idêntico
  const suf = phoneSuffixScore(queryDigits, cand);
  return suf >= 1 ? 0.7 : suf >= 0.9 ? 0.6 : suf > 0 ? 0.5 : 0; // sufixo: forte mas não "high"
}

export async function resolveContact(
  client: GHLClient,
  locationId: string,
  rawQuery: string,
  opts: { defaultCountry?: "US" | "BR"; recentContactIds?: Set<string>; limit?: number } = {},
): Promise<ResolveResult> {
  const query = (rawQuery || "").trim();
  const cap = Math.min(opts.limit || 25, 50);
  const tried: string[] = [];
  const byId = new Map<string, RawContact>();
  const add = (list: RawContact[]) => { for (const c of list) if (c.id && !byId.has(String(c.id))) byId.set(String(c.id), c); };
  const recent = opts.recentContactIds;

  // Ordena por score (base) desc; desempata por recência só quando os scores estão coladinhos.
  const rank = (a: Scored, b: Scored) =>
    Math.abs(a.score - b.score) < 0.03 ? b._rec - a._rec : b.score - a.score;

  // ===== RAMO TELEFONE =====
  if (looksLikePhone(query)) {
    const e164 = normalizePhone(query, opts.defaultCountry || "US");
    const e164Digits = phoneDigits(e164);
    const digits = phoneDigits(query);
    const terms = [...new Set([e164, digits, digits.slice(-10)].filter((t) => t && t.length >= 7))] as string[];
    // H47-F1 (2026-07-10): variantes em PARALELO (eram 3 awaits em série — latência pura;
    // os GETs são independentes e o dedup por Map preserva a prioridade pela ORDEM do add).
    const phoneResults = await Promise.all(terms.map((t) => ghlGet(client, locationId, t, cap)));
    terms.forEach((t, i) => { tried.push(t); add(phoneResults[i]); });
    const scored: Scored[] = [...byId.values()]
      .map((c) => {
        const r = toResolved(c);
        return { ...r, score: Number(phoneScore(e164Digits, digits, c.phone).toFixed(3)), _rec: recencyRank(r, recent) };
      })
      .filter((c) => c.score > 0)
      .sort(rank);
    return finalize(scored, "phone", tried);
  }

  // ===== RAMO NOME =====
  const tokens = nameTokens(query);
  const variants = [...new Set([query, tokens[0], tokens[tokens.length - 1]].filter((t): t is string => !!t && t.length >= 2))];
  // H47-F1 (2026-07-10): idem ramo telefone — variantes em paralelo, ordem preservada no add.
  const nameResults = await Promise.all(variants.map((v) => ghlGet(client, locationId, v, cap)));
  variants.forEach((v, i) => { tried.push(v); add(nameResults[i]); });

  const scored: Scored[] = [...byId.values()]
    .map((c) => {
      const r = toResolved(c);
      const rn = realName(c);
      const base = rn ? nameScore(query, rn) : 0; // "(sem nome)" não pontua por nome
      return { ...r, score: Number(base.toFixed(3)), _rec: recencyRank(r, recent) };
    })
    .filter((c) => c.score >= 0.34) // piso de plausibilidade
    .sort(rank);

  return finalize(scored, scored.length ? "name" : "empty", tried);
}

function finalize(scored: Scored[], method: ResolveResult["method"], tried: string[]): ResolveResult {
  const best = scored[0] || null;
  // gap só é evidência de dominância quando HÁ 2º colocado; com 1 só, gap=0.
  const gap = scored.length >= 2 ? Number((scored[0].score - scored[1].score).toFixed(3)) : 0;
  return {
    best: best ? { id: best.id, name: best.name, email: best.email, phone: best.phone, tags: best.tags, last_activity: best.last_activity } : null,
    score: best?.score ?? 0,
    gap,
    sole: scored.length === 1,
    alternatives: scored.slice(0, 5).map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone, tags: c.tags, last_activity: c.last_activity, score: c.score })),
    method: best ? method : "empty",
    tried,
  };
}
