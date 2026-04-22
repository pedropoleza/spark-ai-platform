import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { generateSummaryNote } from "@/lib/queue/summary-note-generator";

export const maxDuration = 60;

export async function POST(
  request: NextRequest,
  { params }: { params: { agentId: string } }
) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Não autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const { contact_id } = body;

  if (!contact_id) {
    return NextResponse.json({ error: "contact_id obrigatório" }, { status: 400 });
  }

  const supabase = createServerClient();

  // Verificar que o agente pertence à location
  const { data: agent } = await supabase
    .from("agents")
    .select("id, agent_configs(ai_model)")
    .eq("id", params.agentId)
    .eq("location_id", session.locationId)
    .single();

  if (!agent) {
    return NextResponse.json({ error: "Agente não encontrado" }, { status: 404 });
  }

  const config = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;

  // Limpar lock anterior se existir (forçar geração) — usa admin para bypass RLS
  const adminDb = createAdminClient();
  await adminDb
    .from("conversation_state")
    .update({ summary_note_id: null })
    .eq("agent_id", params.agentId)
    .eq("contact_id", contact_id);

  try {
    await generateSummaryNote({
      agentId: params.agentId,
      locationId: session.locationId,
      contactId: contact_id,
      conversationId: "",
      companyId: session.companyId,
      triggerReason: "manual",
      aiModel: (config as Record<string, string>)?.ai_model || "gpt-4.1-mini",
    });

    return NextResponse.json({ success: true, message: "Nota gerada com sucesso" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro ao gerar nota" },
      { status: 500 }
    );
  }
}
