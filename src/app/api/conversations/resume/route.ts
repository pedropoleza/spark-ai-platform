import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { reenqueueInboundsSincePause } from "@/lib/queue/resume-reenqueue";

/**
 * Retoma a IA de uma conversa de lead pausada: limpa ai_paused_at/
 * ai_paused_reason e volta status pra 'active' (inverso do auto-pause do
 * webhook). Ação iniciada pelo admin, reversível. Usado pela aba "Pausadas"
 * do /hub (feedback Pedro 1c).
 *
 * Anti-IDOR: confere que o agente pertence à location da sessão antes de mexer.
 */
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json().catch(() => ({}));
  const agentId = String(body.agent_id || "");
  const contactId = String(body.contact_id || "");
  if (!agentId || !contactId) {
    return NextResponse.json({ error: "agent_id e contact_id obrigatórios" }, { status: 400 });
  }

  const supabase = createAdminClient();
  const { data: agent } = await supabase
    .from("agents")
    .select("id, location_id")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent || agent.location_id !== session.locationId) {
    return NextResponse.json({ error: "Agente não encontrado ou sem acesso" }, { status: 403 });
  }

  // Captura a janela de pausa ANTES de limpar — pra recuperar inbounds engolidos
  // durante a pausa (Fix bug observado em prod 2026-06-18, caso Marina).
  const { data: prevState } = await supabase
    .from("conversation_state")
    .select("ai_paused_at, ai_paused_reason")
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .eq("location_id", session.locationId)
    .maybeSingle();

  const nowIso = new Date().toISOString();
  const { error } = await supabase
    .from("conversation_state")
    // ai_resumed_at: override "passa a bola pra IA" (GU-6) — também faz a IA
    // atender a msg recuperada mesmo que o targeting (folha message) não bata.
    .update({ status: "active", ai_paused_at: null, ai_paused_reason: null, ai_resumed_at: nowIso, updated_at: nowIso })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId)
    .eq("location_id", session.locationId);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  // Recupera inbounds que chegaram durante a pausa e foram engolidos (marcados
  // completed sem resposta). Fail-soft: não quebra o resume.
  await reenqueueInboundsSincePause(supabase, {
    agentId,
    contactId,
    pausedSince: prevState?.ai_paused_at,
    pausedReason: prevState?.ai_paused_reason,
  });

  return NextResponse.json({ ok: true });
}
