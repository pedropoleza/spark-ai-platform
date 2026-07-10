/**
 * "Contato em foco" + buffer de contatos recentes (H45, 2026-06-26).
 * F2/F3: lê o contact_id mais recente persistido na metadata das msgs (setado pelos proativos
 * F1/F8) — direto do DB, cobrindo os 2 caminhos inbound (webhook+stevo) sem threading.
 * F10: ring buffer rep_identities.profile.recent_contacts, populado por tool-results de contato.
 * Tudo fail-soft: erro nunca quebra o turno (no pior caso, sem herança = comportamento de hoje).
 */
import type { SupabaseClient } from "@supabase/supabase-js";

export interface FocusContact {
  id: string;
  name?: string;
  source: "proactive" | "tool_result" | "mention";
  when?: string;
}

export interface ActiveContactContext {
  /** Contato mais provável "em foco" agora (proativo recente OU último resolvido). */
  focus: FocusContact | null;
  /** Outros contatos recentes do rep (pista pro resolver/herança). */
  recent: Array<{ id: string; name?: string }>;
}

const FOCUS_WINDOW_MS = 3 * 60 * 60 * 1000; // 3h: além disso, "em foco" não faz sentido
const RECENT_CAP = 5;

/**
 * F2/F3: monta o contexto de contato ativo a partir do que JÁ foi persistido (fonte REAL,
 * nunca inferência). Escopo: (rep, hub_location) + active_location quando disponível.
 */
export async function getActiveContactContext(
  supabase: SupabaseClient,
  repId: string,
  opts: {
    hubLocationId?: string | null;
    activeLocationId?: string | null;
    recentContacts?: Array<{ id: string; name?: string }>;
  } = {},
): Promise<ActiveContactContext> {
  let focus: FocusContact | null = null;
  try {
    const sinceIso = new Date(Date.now() - FOCUS_WINDOW_MS).toISOString();
    let q = supabase
      .from("sparkbot_messages")
      .select("metadata, created_at, active_location_id")
      .eq("rep_id", repId) // rep_id é a chave forte; hub é refinamento opcional
      .not("metadata->>contact_id", "is", null)
      .gte("created_at", sinceIso)
      .order("created_at", { ascending: false })
      .limit(5);
    if (opts.hubLocationId) q = q.eq("hub_location_id", opts.hubLocationId);
    const r = await q;
    const rows = (r.data || []) as Array<{ metadata?: Record<string, unknown>; created_at?: string; active_location_id?: string | null }>;
    // Prioriza a msg mais recente cuja active_location bate (ou sem filtro se não veio).
    const match =
      rows.find((m) => !opts.activeLocationId || m.active_location_id === opts.activeLocationId) || rows[0];
    const cid = match?.metadata?.contact_id;
    if (typeof cid === "string" && cid) {
      const cname = match?.metadata?.contact_name;
      focus = {
        id: cid,
        name: typeof cname === "string" ? cname : undefined,
        source: "proactive",
        when: match?.created_at,
      };
    }
  } catch {
    // fail-soft: sem foco
  }

  const recent = (opts.recentContacts || []).filter((c) => c.id && c.id !== focus?.id).slice(0, RECENT_CAP);
  // Se não há foco de proativo mas há recente, o mais recente vira o foco (pista mais fraca).
  if (!focus && recent.length) {
    focus = { id: recent[0].id, name: recent[0].name, source: "tool_result" };
  }
  return { focus, recent };
}

/** F3: renderiza o bloco "CONTATO EM CONTEXTO" pro runtime context (user message, não-cacheada). */
export function renderContactInFocusBlock(ctx: ActiveContactContext): string {
  if (!ctx.focus && !ctx.recent.length) return "";
  const lines: string[] = ["# CONTATO EM CONTEXTO"];
  if (ctx.focus) {
    const orig = ctx.focus.source === "proactive" ? "eu te avisei sobre ele num proativo" : "você acabou de resolver ele aqui";
    if (ctx.focus.name) {
      lines.push(
        `Provável contato em jogo agora: ${ctx.focus.name} (pista de id: ${ctx.focus.id}) — ${orig}.`,
        `Se o rep falar "ele/ela/follow-up/marca/lembra dele" SEM nomear outro contato, é PROVAVELMENTE esse.`,
        `IMPORTANTE: trate como PISTA — valide com get_contact(${ctx.focus.id}), confirme inline que o nome bate ("é a ${ctx.focus.name}, certo?") e SÓ então aja. NUNCA afirme feito/agendado sem o id validado.`,
      );
    } else {
      // Sem nome salvo a defesa "confirme o nome" não tem âncora → NÃO crava o contato.
      lines.push(
        `Possível contato recente (id ${ctx.focus.id}) — ${orig} — mas o NOME não foi salvo.`,
        `Se o rep se referir a "ele/ela" sem nomear: chame get_contact(${ctx.focus.id}) pra descobrir o nome e CONFIRME com o rep ("é a Fulana, certo?") antes de agir. NÃO assuma que é esse contato sem o rep confirmar o nome.`,
      );
    }
  }
  if (ctx.recent.length) {
    lines.push(`Outros contatos recentes: ${ctx.recent.map((c) => `${c.name || "?"} (${c.id})`).join(", ")}.`);
  }
  return lines.join("\n");
}

/**
 * F10: registra um contato resolvido no ring buffer rep_identities.profile.recent_contacts.
 * Best-effort: lê o profile, prepende (dedupe por id), capa em RECENT_CAP, grava. Fail-soft.
 */
export async function recordRecentContact(
  supabase: SupabaseClient,
  repId: string,
  contact: { id: string; name?: string },
  source: FocusContact["source"] = "tool_result",
): Promise<void> {
  if (!contact?.id) return;
  const entry = { id: contact.id, name: contact.name || null, source, last_ref_at: new Date().toISOString() };
  try {
    // H47-F1 (2026-07-10): RPC atômico (migration 00121) — o read-modify-write
    // antigo raceava com outros writers do profile JSONB (prefs, notified-lists);
    // o RPC toca SÓ a chave recent_contacts numa sentença. Fallback pro caminho
    // legado se a migration ainda não rodou (PGRST202 = function not found).
    const rpc = await supabase.rpc("append_recent_contact", {
      p_rep_id: repId,
      p_entry: entry,
      p_cap: RECENT_CAP,
    });
    if (!rpc.error) return;
    if (rpc.error.code !== "PGRST202") {
      console.warn("[active-contact] append_recent_contact RPC falhou:", rpc.error.message);
    }
    // Fallback legado (best-effort, sabidamente race-prone — só até a 00121 aplicar).
    const r = await supabase.from("rep_identities").select("profile").eq("id", repId).single();
    const profile = ((r.data?.profile as Record<string, unknown>) || {}) as Record<string, unknown>;
    const prev = Array.isArray(profile.recent_contacts) ? (profile.recent_contacts as Array<Record<string, unknown>>) : [];
    const next = [entry, ...prev.filter((c) => c && c.id !== contact.id)].slice(0, RECENT_CAP);
    await supabase
      .from("rep_identities")
      .update({ profile: { ...profile, recent_contacts: next } })
      .eq("id", repId);
  } catch {
    // fail-soft
  }
}

/** Lê o buffer recent_contacts do profile (sem nova query se o profile já veio no rep). */
export function readRecentContacts(profile: unknown): Array<{ id: string; name?: string }> {
  const p = (profile || {}) as Record<string, unknown>;
  const arr = Array.isArray(p.recent_contacts) ? (p.recent_contacts as Array<Record<string, unknown>>) : [];
  return arr
    .filter((c) => c && typeof c.id === "string")
    .map((c) => ({ id: String(c.id), name: typeof c.name === "string" ? c.name : undefined }));
}
