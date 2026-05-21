/**
 * Acompanhamento Guiado (outreach 1-por-vez) — FORGE-3 2026-05-21.
 *
 * Estado stateful: o rep manda mensagem pra uma LISTA de contatos UM POR VEZ,
 * confirmando/editando/pulando cada um. Resolve o travamento do lote grande
 * (timeout 60s) — cada passo é 1 contato (turno pequeno). Cursor = primeiro item
 * `pending` por position (derivado do DB, sem drift). Tudo gated por env.
 *
 * Camada de DADOS + máquina de estado. O ENVIO (send/schedule pro contato) e a
 * orquestração ficam nas tools (guided-outreach tools), não aqui.
 */

import { createAdminClient } from "@/lib/supabase/admin";

/** Gate da feature. Default OFF — liga no smoke supervisionado. */
export function isGuidedOutreachEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.GUIDED_OUTREACH_ENABLED?.trim() || "");
}

export type GuidedItemStatus = "pending" | "sent" | "skipped";

export interface GuidedItem {
  id: string;
  position: number;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  suggested_message: string | null;
  final_message: string | null;
  status: GuidedItemStatus;
}

export interface GuidedSession {
  id: string;
  rep_id: string;
  location_id: string;
  agent_id: string;
  goal: string | null;
  status: "active" | "completed" | "cancelled";
  send_mode: "now" | "scheduled";
  schedule_anchor_at: string | null;
  total: number;
  sent_count: number;
  skipped_count: number;
}

export interface NewContact {
  contact_id: string;
  contact_name?: string | null;
  contact_phone?: string | null;
}

/**
 * Cria uma sessão guiada + os itens (position 1..N, todos pending).
 * Retorna a sessão + o primeiro contato (cursor inicial).
 */
export async function createGuidedSession(input: {
  repId: string;
  locationId: string;
  agentId: string;
  goal?: string | null;
  sendMode?: "now" | "scheduled";
  scheduleAnchorAt?: string | null;
  contacts: NewContact[];
}): Promise<{ session: GuidedSession; first: GuidedItem | null } | null> {
  const sb = createAdminClient();
  const contacts = input.contacts.filter((c) => c.contact_id);
  if (contacts.length === 0) return null;

  const { data: sess, error: sErr } = await sb
    .from("guided_outreach_sessions")
    .insert({
      rep_id: input.repId,
      location_id: input.locationId,
      agent_id: input.agentId,
      goal: input.goal ?? null,
      status: "active",
      send_mode: input.sendMode ?? "now",
      schedule_anchor_at: input.scheduleAnchorAt ?? null,
      total: contacts.length,
    })
    .select("*")
    .single();
  if (sErr || !sess) {
    console.warn("[guided] createSession falhou:", sErr?.message);
    return null;
  }

  const rows = contacts.map((c, i) => ({
    session_id: sess.id,
    position: i + 1,
    contact_id: c.contact_id,
    contact_name: c.contact_name ?? null,
    contact_phone: c.contact_phone ?? null,
    status: "pending" as const,
  }));
  const { error: iErr } = await sb.from("guided_outreach_items").insert(rows);
  if (iErr) {
    console.warn("[guided] insert items falhou:", iErr.message);
    await sb.from("guided_outreach_sessions").delete().eq("id", sess.id);
    return null;
  }

  const first = await getCurrentItem(sess.id);
  return { session: sess as GuidedSession, first };
}

/** Sessão ATIVA do rep (1 por vez), ou null. */
export async function getActiveSession(repId: string): Promise<GuidedSession | null> {
  const sb = createAdminClient();
  const { data } = await sb
    .from("guided_outreach_sessions")
    .select("*")
    .eq("rep_id", repId)
    .eq("status", "active")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as GuidedSession | null) ?? null;
}

/** Cursor: primeiro item `pending` por position. null = acabou. */
export async function getCurrentItem(sessionId: string): Promise<GuidedItem | null> {
  const sb = createAdminClient();
  const { data } = await sb
    .from("guided_outreach_items")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .order("position", { ascending: true })
    .limit(1)
    .maybeSingle();
  return (data as GuidedItem | null) ?? null;
}

/**
 * Marca UM item (atomic, idempotente: só sai de `pending` 1×). Retorna o item
 * marcado (ou null se já não estava pending — race/double-tap). O ENVIO é feito
 * pelo caller ANTES de marcar (confirm). Contadores são computados de getSessionProgress.
 */
export async function markItem(
  itemId: string,
  status: "sent" | "skipped",
  finalMessage?: string | null,
): Promise<GuidedItem | null> {
  const sb = createAdminClient();
  const { data: updated } = await sb
    .from("guided_outreach_items")
    .update({
      status,
      final_message: finalMessage ?? null,
      decided_at: new Date().toISOString(),
    })
    .eq("id", itemId)
    .eq("status", "pending") // idempotência anti double-tap
    .select("*");
  if (!updated || updated.length === 0) return null;
  return updated[0] as GuidedItem;
}

/** Progresso da sessão: contagem por status (fonte de verdade = itens). */
export async function getSessionProgress(
  sessionId: string,
): Promise<{ total: number; sent: number; skipped: number; pending: number }> {
  const sb = createAdminClient();
  const { data } = await sb
    .from("guided_outreach_items")
    .select("status")
    .eq("session_id", sessionId);
  const items = (data as { status: GuidedItemStatus }[] | null) ?? [];
  const sent = items.filter((i) => i.status === "sent").length;
  const skipped = items.filter((i) => i.status === "skipped").length;
  const pending = items.filter((i) => i.status === "pending").length;
  return { total: items.length, sent, skipped, pending };
}

/** Marca a sessão como completed se não há mais pendentes. Retorna true se completou. */
export async function completeIfDone(sessionId: string): Promise<boolean> {
  const next = await getCurrentItem(sessionId);
  if (next) return false;
  const sb = createAdminClient();
  await sb
    .from("guided_outreach_sessions")
    .update({ status: "completed", updated_at: new Date().toISOString() })
    .eq("id", sessionId)
    .eq("status", "active");
  return true;
}

/** Cancela a sessão ativa do rep. Retorna a sessão cancelada (ou null). */
export async function cancelActiveSession(repId: string): Promise<GuidedSession | null> {
  const sb = createAdminClient();
  const active = await getActiveSession(repId);
  if (!active) return null;
  await sb
    .from("guided_outreach_sessions")
    .update({ status: "cancelled", updated_at: new Date().toISOString() })
    .eq("id", active.id);
  return active;
}

/** Pega itens pendentes de uma sessão (pro Modo B / progresso). */
export async function getPendingItems(sessionId: string): Promise<GuidedItem[]> {
  const sb = createAdminClient();
  const { data } = await sb
    .from("guided_outreach_items")
    .select("*")
    .eq("session_id", sessionId)
    .eq("status", "pending")
    .order("position", { ascending: true });
  return (data as GuidedItem[] | null) ?? [];
}

// ── pura/testável: escalonamento de horário (scheduled) ──
/** Horário do contato i (0-based) a partir da âncora, +stepMin por contato. */
export function staggeredAt(anchorISO: string, indexFromNow: number, stepMin = 2): string {
  const base = Date.parse(anchorISO);
  const t = Number.isFinite(base) ? base : Date.now();
  return new Date(t + indexFromNow * stepMin * 60_000).toISOString();
}
