/**
 * Cliente Stevo de GRUPOS de WhatsApp (group campaigns — Pedro 2026-06-18).
 *
 * Irmã de stevo-send.ts. Cobre o que a feature de campanha em grupo precisa:
 *  - listStevoGroups(): GET /group/list → grupos do número + MEMBROS embutidos +
 *    flag IsAnnounce (só-admin-posta). Confirmado ao vivo (scripts/probe-stevo-groups.ts).
 *  - sendGroupText(): POST /send/text com number = JID do grupo ("xxx@g.us") +
 *    formatJid:true. Reusa stevoPostJson (mesmo header apikey / timeout / no-throw
 *    do DM). O JID é preservado por normalizeStevoNumber (fix 2026-06-18).
 *
 * NÃO decide SE pode enviar (gate de instância dedicada + termos vive na tool /
 * runner). Aqui é só o "como": fetch, parse defensivo, cache leve, sem lançar.
 *
 * Spec (swagger StevoManager v2):
 *   GET  {serverUrl}/group/list           Header apikey: <instanceToken>
 *   POST {serverUrl}/send/text            { number:"<jid>@g.us", text, formatJid:true, delay? }
 */

import { stevoPostJson } from "./stevo-send";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface StevoGroupParticipant {
  /** JID do membro ("17867717077@s.whatsapp.net" ou "@lid"). */
  jid: string;
  /** Telefone derivado do JID (+DDI), ou null pra JID @lid sem dígitos. */
  phone: string | null;
  isAdmin: boolean;
  isSuperAdmin: boolean;
}

export interface StevoGroup {
  /** JID do grupo ("...@g.us") — endereço de envio. */
  jid: string;
  /** Nome (subject) do grupo. */
  name: string;
  /** Quantos membros (do ParticipantCount ou do tamanho do array). */
  participantCount: number;
  /** true = só admins postam (IsAnnounce). Posts de não-admin falham. */
  isAnnounce: boolean;
  /** true = só admins editam infos do grupo (IsLocked). Não bloqueia post. */
  isLocked: boolean;
  /** JID do dono, quando disponível. */
  ownerJid: string | null;
  /** Membros embutidos (pode vir vazio se a instância não sincronizou). */
  participants: StevoGroupParticipant[];
}

export type ListGroupsResult =
  | { ok: true; groups: StevoGroup[] }
  | { ok: false; error: string };

// ---------------------------------------------------------------------------
// Cache leve (evita martelar /group/list em list→preview→schedule no mesmo fluxo)
// ---------------------------------------------------------------------------

const GROUP_CACHE_TTL_MS = 60_000;
type CacheEntry = { groups: StevoGroup[]; ts: number };
// Chave = serverUrl + "|" + instanceToken (token NÃO é logado em lugar nenhum).
const groupCache = new Map<string, CacheEntry>();

// ---------------------------------------------------------------------------
// Helpers de parse (defensivos — a forma exata do JSON do Stevo varia)
// ---------------------------------------------------------------------------

/** "17867717077@s.whatsapp.net" → "+17867717077". null se não houver dígitos. */
function jidToPhone(jid: string): string | null {
  const local = (jid || "").split("@")[0] || "";
  const digits = local.replace(/\D/g, "");
  return digits.length >= 8 ? `+${digits}` : null;
}

function asBool(v: unknown): boolean {
  return v === true || v === "true" || v === 1 || v === "1";
}

function parseParticipant(raw: unknown): StevoGroupParticipant | null {
  if (typeof raw === "string") {
    return { jid: raw, phone: jidToPhone(raw), isAdmin: false, isSuperAdmin: false };
  }
  if (raw && typeof raw === "object") {
    const p = raw as Record<string, unknown>;
    const jid = (p.JID || p.jid || p.id || p.Id) as string | undefined;
    if (!jid) return null;
    const isSuper = asBool(p.IsSuperAdmin ?? p.isSuperAdmin ?? p.superAdmin);
    const isAdmin = isSuper || asBool(p.IsAdmin ?? p.isAdmin ?? p.admin);
    return { jid, phone: jidToPhone(jid), isAdmin, isSuperAdmin: isSuper };
  }
  return null;
}

export function parseGroup(raw: unknown): StevoGroup | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as Record<string, unknown>;
  const jid = (g.JID || g.jid || g.id || g.Id) as string | undefined;
  if (!jid || !/@g\.us$/i.test(jid)) return null; // só grupos reais
  const name = ((g.Name || g.name || g.subject || g.Subject || "") as string).trim() || jid;
  const participantsRaw = (g.Participants || g.participants || []) as unknown[];
  const participants = Array.isArray(participantsRaw)
    ? participantsRaw.map(parseParticipant).filter((p): p is StevoGroupParticipant => p !== null)
    : [];
  const countField = g.ParticipantCount ?? g.participantCount;
  const participantCount =
    typeof countField === "number" ? countField : participants.length;
  return {
    jid,
    name,
    participantCount,
    isAnnounce: asBool(g.IsAnnounce ?? g.isAnnounce ?? g.announce),
    isLocked: asBool(g.IsLocked ?? g.isLocked ?? g.locked),
    ownerJid: (g.OwnerJID || g.ownerJid || g.owner || null) as string | null,
    participants,
  };
}

// ---------------------------------------------------------------------------
// GET genérico (no-throw, timeout, header apikey) — pro /group/list
// ---------------------------------------------------------------------------

async function stevoGetJson(
  base: string,
  apiKey: string,
  path: string,
  timeoutMs: number,
): Promise<{ ok: boolean; json?: unknown; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
      method: "GET",
      headers: { "Content-Type": "application/json", apikey: apiKey },
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      };
    }
    const json = await res.json().catch(() => null);
    return { ok: true, json };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.includes("abort") ? `timeout após ${timeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// API pública
// ---------------------------------------------------------------------------

/**
 * Lista os grupos do número da instância (com membros embutidos). Cache 60s por
 * (serverUrl, token). NÃO lança. `forceRefresh` ignora o cache.
 */
export async function listStevoGroups(
  serverUrl: string,
  instanceToken: string,
  opts: { timeoutMs?: number; forceRefresh?: boolean } = {},
): Promise<ListGroupsResult> {
  const base = (serverUrl || "").trim().replace(/\/+$/, "");
  const apiKey = (instanceToken || "").trim();
  const timeoutMs = opts.timeoutMs ?? 20_000;
  if (!base || !apiKey) return { ok: false, error: "instância Stevo sem serverUrl/token" };

  const cacheKey = `${base}|${apiKey}`;
  if (!opts.forceRefresh) {
    const hit = groupCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < GROUP_CACHE_TTL_MS) {
      return { ok: true, groups: hit.groups };
    }
  }

  const r = await stevoGetJson(base, apiKey, "/group/list", timeoutMs);
  if (!r.ok) return { ok: false, error: r.error || "falha ao listar grupos" };

  // Acha o array de grupos (raiz, ou data/groups/results).
  const j = r.json as Record<string, unknown> | unknown[] | null;
  const arr: unknown[] = Array.isArray(j)
    ? j
    : ((j as Record<string, unknown>)?.data as unknown[]) ||
      ((j as Record<string, unknown>)?.groups as unknown[]) ||
      ((j as Record<string, unknown>)?.results as unknown[]) ||
      [];
  const groups = arr.map(parseGroup).filter((g): g is StevoGroup => g !== null);

  groupCache.set(cacheKey, { groups, ts: Date.now() });
  return { ok: true, groups };
}

/**
 * Acha 1 grupo por JID (a partir do cache/list). null se não existir.
 */
export async function findStevoGroup(
  serverUrl: string,
  instanceToken: string,
  jid: string,
): Promise<StevoGroup | null> {
  const r = await listStevoGroups(serverUrl, instanceToken);
  if (!r.ok) return null;
  return r.groups.find((g) => g.jid === jid) || null;
}

/**
 * Envia UM texto a um grupo via Stevo (`/send/text` com formatJid:true). Reusa
 * stevoPostJson (header apikey / timeout / extração de id / no-throw). O JID é
 * preservado por normalizeStevoNumber, mas aqui mandamos o JID CRU direto (não
 * passamos pelo splitter de bolhas — post de grupo é 1 mensagem inteira). NÃO lança.
 */
export async function sendGroupText(
  serverUrl: string,
  instanceToken: string,
  groupJid: string,
  text: string,
  opts: { timeoutMs?: number; typingDelayMs?: number } = {},
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const base = (serverUrl || "").trim().replace(/\/+$/, "");
  const apiKey = (instanceToken || "").trim();
  const jid = (groupJid || "").trim();
  const timeoutMs = opts.timeoutMs ?? 20_000;

  if (!base || !apiKey || !/@g\.us$/i.test(jid)) {
    return {
      ok: false,
      error: `params inválidos (base=${!!base} apiKey=${!!apiKey} jidGrupo=${/@g\.us$/i.test(jid)})`,
    };
  }
  if (!text || !text.trim()) return { ok: false, error: "texto vazio" };

  const body: Record<string, unknown> = { number: jid, text: text.trim(), formatJid: true };
  if (opts.typingDelayMs && opts.typingDelayMs > 0) body.delay = opts.typingDelayMs;

  return stevoPostJson(base, apiKey, "/send/text", body, timeoutMs);
}

/** Limpa o cache de grupos (testes / após sync). */
export function clearGroupCache(): void {
  groupCache.clear();
}
