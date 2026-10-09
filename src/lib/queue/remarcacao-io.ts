/**
 * H103: a parte com banco e CRM da remarcação pós-handoff. As regras (puras)
 * estão em `remarcacao-pos-handoff.ts`, que fica sem dependência de servidor
 * porque o prompt builder (que também roda no cliente) importa o texto do modo.
 */
import type { createAdminClient } from "@/lib/supabase/admin";
import type { GHLClient } from "@/lib/ghl/client";
import { createNoteOnContact } from "@/lib/ghl/operations";
import { notifyRescheduleToRep } from "@/lib/queue/handoff-notify";
import { JANELA_REMARCACAO_MS, textoDaNota } from "@/lib/queue/remarcacao-pos-handoff";

type Supabase = ReturnType<typeof createAdminClient>;

export async function abrirJanelaDeRemarcacao(
  supabase: Supabase,
  agentId: string,
  contactId: string,
  agora = new Date(),
): Promise<void> {
  const { error } = await supabase
    .from("conversation_state")
    .update({
      reschedule_window_opened_at: agora.toISOString(),
      reschedule_window_until: new Date(agora.getTime() + JANELA_REMARCACAO_MS).toISOString(),
    })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId);
  if (error) console.warn(`[H103] não abriu a janela de remarcação: ${error.message}`);
}

export async function fecharJanelaDeRemarcacao(
  supabase: Supabase,
  agentId: string,
  contactId: string,
): Promise<void> {
  const { error } = await supabase
    .from("conversation_state")
    .update({ reschedule_window_opened_at: null, reschedule_window_until: null })
    .eq("agent_id", agentId)
    .eq("contact_id", contactId);
  if (error) console.warn(`[H103] não fechou a janela de remarcação: ${error.message}`);
}

/**
 * Avisa a equipe de um evento da remarcação: nota interna no contato (o registro
 * que sempre fica, visível no painel do Spark Leads) + mensagem pelo SparkBot
 * pro dono do contato. Nenhuma das duas derruba o turno: o lead já foi
 * atendido quando isto roda.
 */
export async function avisarEquipeDaRemarcacao(p: {
  supabase: Supabase;
  ghlClient: GHLClient;
  agentId: string;
  agenteNome: string;
  locationId: string;
  contactId: string;
  conversationId: string;
  evento: "pedido" | "remarcada" | "desmarcar";
  rotuloAntes: string;
  rotuloDepois?: string | null;
  fuso: string;
  mensagemDoLead?: string | null;
  contato?: { name?: string | null; phone?: string | null; assignedTo?: string | null } | null;
}): Promise<{ nota: boolean; aviso: string }> {
  let nota = false;
  try {
    await createNoteOnContact(
      p.ghlClient,
      p.contactId,
      textoDaNota({
        agente: p.agenteNome,
        evento: p.evento,
        rotuloAntes: p.rotuloAntes,
        rotuloDepois: p.rotuloDepois,
        fuso: p.fuso,
        mensagemDoLead: p.mensagemDoLead,
      }),
    );
    nota = true;
  } catch (err) {
    console.warn(`[H103] nota interna falhou: ${err instanceof Error ? err.message.slice(0, 200) : err}`);
  }

  const r = await notifyRescheduleToRep({
    agentId: p.agentId,
    locationId: p.locationId,
    contactId: p.contactId,
    evento: p.evento,
    contactName: p.contato?.name || null,
    contactPhone: p.contato?.phone || null,
    assignedUserId: p.contato?.assignedTo || null,
    rotuloAntes: p.rotuloAntes,
    rotuloDepois: p.rotuloDepois,
    fuso: p.fuso,
    leadMessage: p.mensagemDoLead,
  });

  const { error } = await p.supabase.from("execution_log").insert({
    agent_id: p.agentId,
    location_id: p.locationId,
    contact_id: p.contactId,
    conversation_id: p.conversationId,
    action_type: "reschedule_team_notice",
    action_payload: { evento: p.evento, nota_interna: nota, aviso: r.reason },
    success: nota || r.notified,
  });
  if (error) console.warn(`[H103] log do aviso falhou: ${error.message}`);
  return { nota, aviso: r.reason };
}
