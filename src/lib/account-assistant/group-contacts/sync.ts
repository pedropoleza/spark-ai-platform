/**
 * Descoberta + cache + resolução de contatos-grupo (H46, 2026-06-28).
 *
 * Descoberta: Filter Engine `email contains '@g.us'` (server-side, suportado —
 * `capabilities.ts`), re-validado pelo `detectGroupContact` (defende contra
 * `contains` casar "x@g.us.algo"). Só os com JID real (reason=email_jid) entram no
 * cache `group_contacts` (disparáveis). O cache evita pull-all a cada turno (o cap
 * 5000 do filter-engine perderia grupos dispersos entre milhares de contatos).
 *
 * Auto-heal de `locations`: o ENVIO depende de `locations.company_id`
 * (bulk-runner/followup-runner retornam "location não sincronizada" sem ele). O
 * sync garante o upsert mínimo (não-clobber) — pré-requisito do disparo.
 */
import type { ToolContext } from "../tools/types";
import type { ContactResult } from "../filter-engine/types";
import { executeContactsFilter } from "../filter-engine/executor";
import { deburr } from "../contact-resolver/normalize";
import { detectGroupContact } from "./detector";
import {
  upsertGroupContacts,
  listActiveGroupContacts,
  archiveMissingGroupContacts,
  getGroupContactsFreshness,
  type GroupContactUpsert,
  type GroupContactRow,
} from "@/lib/repositories/group-contacts.repo";
import { createAdminClient } from "@/lib/supabase/admin";

const GROUP_CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6h: 1ª chamada do dia paga o sync
const SYNC_PULL_CAP = 3000; // teto defensivo do pull de descoberta

export interface GroupTarget {
  contact_id: string;
  jid: string;
  name: string;
}

// ───────────────────────── helpers PUROS (testáveis) ─────────────────────────

/** Cache stale? (vazio, sem timestamp, ou mais velho que o TTL). */
export function isGroupCacheStale(
  maxLastSynced: string | null,
  count: number,
  nowMs: number,
  ttlMs: number = GROUP_CACHE_TTL_MS,
): boolean {
  if (count === 0 || !maxLastSynced) return true;
  const t = Date.parse(maxLastSynced);
  return Number.isNaN(t) || nowMs - t >= ttlMs;
}

/**
 * ContactResult → linha do cache. SÓ contatos com JID real (reason=email_jid)
 * viram grupo disparável; nome-sufixo sem email NÃO entra (não é endereçável).
 */
export function groupUpsertFromContact(
  c: ContactResult,
  locationId: string,
): GroupContactUpsert | null {
  const sig = detectGroupContact({
    email: c.email,
    firstName: c.firstName,
    lastName: c.lastName,
    name: c.name,
    tags: c.tags,
  });
  if (sig.reason !== "email_jid" || !sig.jid) return null;
  const name =
    (c.name && c.name.trim()) ||
    [c.firstName, c.lastName].filter(Boolean).join(" ").trim() ||
    null;
  return {
    location_id: locationId,
    contact_id: c.id,
    jid: sig.jid,
    group_name: name,
    tags: Array.isArray(c.tags) && c.tags.length ? c.tags : null,
    member_count: null,
  };
}

/**
 * Casa um nome dito pelo rep contra os grupos do cache: exato (deburr) →
 * startsWith → includes. Devolve o melhor único, ou null se 0/ambíguo no exato.
 */
export function matchGroupByName(
  groups: GroupContactRow[],
  rawName: string,
): GroupContactRow | null {
  const q = deburr(rawName);
  if (!q) return null;
  // JID literal? casa direto.
  const byJid = groups.find((g) => deburr(g.jid) === q);
  if (byJid) return byJid;
  const named = groups.map((g) => ({ g, n: deburr(g.group_name || "") })).filter((x) => x.n);
  const exact = named.filter((x) => x.n === q);
  if (exact.length === 1) return exact[0].g;
  if (exact.length > 1) return null; // ambíguo no exato
  const starts = named.filter((x) => x.n.startsWith(q));
  if (starts.length === 1) return starts[0].g;
  const includes = named.filter((x) => x.n.includes(q));
  if (includes.length === 1) return includes[0].g;
  return null;
}

function toTarget(g: GroupContactRow): GroupTarget {
  return { contact_id: g.contact_id, jid: g.jid, name: g.group_name || g.jid };
}

const ALL_RE = /^(all|todos|todos os grupos|todos os meus grupos|meus grupos)$/i;

// ───────────────────────── I/O ─────────────────────────

/** Auto-heal: garante `locations` tem a row (pré-req do envio). Não-clobber, fail-soft. */
async function ensureLocationSynced(ctx: ToolContext): Promise<void> {
  if (!ctx.locationId || !ctx.companyId) return;
  try {
    const db = createAdminClient();
    await db.from("locations").upsert(
      {
        location_id: ctx.locationId,
        company_id: ctx.companyId,
        timezone: ctx.rep.timezone || "America/New_York",
      },
      { onConflict: "location_id", ignoreDuplicates: true },
    );
  } catch (e) {
    console.warn("[group-sync] auto-heal locations falhou (best-effort):", e instanceof Error ? e.message : e);
  }
}

/** Descobre os contatos-grupo da location via GHL e materializa no cache. */
export async function syncGroupContacts(
  ctx: ToolContext,
): Promise<{ ok: boolean; count: number; truncated?: boolean; error?: string }> {
  await ensureLocationSynced(ctx);
  try {
    const result = await executeContactsFilter(
      { field: "email", op: "contains", value: "@g.us" },
      {
        rep_id: ctx.rep.id,
        location_id: ctx.locationId,
        company_id: ctx.companyId,
        ghl_client: ctx.ghlClient,
        consumer_tool: "group_contacts_sync",
      },
      { limit: SYNC_PULL_CAP, skip_audit: true },
    );
    if (result.status !== "ok") {
      return { ok: false, count: 0, error: result.message || "filter falhou" };
    }
    const rows = (result.items || [])
      .map((c) => groupUpsertFromContact(c, ctx.locationId))
      .filter((r): r is GroupContactUpsert => r !== null);

    await upsertGroupContacts(rows);
    await archiveMissingGroupContacts(ctx.locationId, rows.map((r) => r.contact_id));
    if (result.hit_safety_cap) {
      console.warn(`[group-sync] hit cap em ${ctx.locationId} — grupos podem faltar (${rows.length} achados)`);
    }
    return { ok: true, count: rows.length, truncated: result.hit_safety_cap };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn("[group-sync] falhou:", msg);
    return { ok: false, count: 0, error: msg };
  }
}

/** Lê o cache; re-sincroniza se stale (ou forçado). Fonte única do cockpit/targeting. */
export async function getGroupContacts(
  ctx: ToolContext,
  opts?: { forceRefresh?: boolean },
): Promise<GroupContactRow[]> {
  const fresh = await getGroupContactsFreshness(ctx.locationId);
  if (opts?.forceRefresh || isGroupCacheStale(fresh.maxLastSynced, fresh.count, Date.now())) {
    await syncGroupContacts(ctx);
  }
  return listActiveGroupContacts(ctx.locationId);
}

/**
 * Resolve os alvos pedidos pelo rep → `{contact_id, jid, name}[]` + nomes não-achados.
 * Modos: ['all'] (todos, ou da tag), JIDs/nomes literais.
 */
export async function resolveGroupTargets(
  ctx: ToolContext,
  names: string[],
  opts?: { groupTag?: string | null },
): Promise<{ targets: GroupTarget[]; notFound: string[] }> {
  const all = await getGroupContacts(ctx);

  const cleaned = (names || []).map((n) => String(n || "").trim()).filter(Boolean);
  if (cleaned.length === 1 && ALL_RE.test(cleaned[0])) {
    let list = all;
    if (opts?.groupTag) {
      const t = deburr(opts.groupTag);
      list = all.filter((g) => (g.tags || []).some((x) => deburr(x).includes(t)));
    }
    return { targets: list.map(toTarget), notFound: [] };
  }

  const targets: GroupTarget[] = [];
  const notFound: string[] = [];
  const seen = new Set<string>();
  for (const raw of cleaned) {
    const m = matchGroupByName(all, raw);
    if (m && !seen.has(m.contact_id)) {
      seen.add(m.contact_id);
      targets.push(toTarget(m));
    } else if (!m) {
      notFound.push(raw);
    }
  }
  return { targets, notFound };
}
