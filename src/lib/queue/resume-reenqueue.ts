import type { createAdminClient } from "@/lib/supabase/admin";

/**
 * Recupera inbounds engolidos durante uma pausa de IA.
 *
 * Fix bug observado em prod 2026-06-18 (caso Marina, contato Jd22al…): quando a
 * IA está pausada (`conversation_state.ai_paused_at`), o gate do queue-processor
 * pula o inbound (`return`) e o `finally` (queue-processor.ts:206-213) o marca
 * `completed` — e NENHUM resume reprocessa mensagem `completed` (o re-enqueue do
 * processor só pega `failed`). Resultado: o lead respondeu "Florida" durante uma
 * pausa espúria e a IA NUNCA respondeu, nem depois do resume.
 *
 * Ao RETOMAR a IA (resume manual / "passa a bola pra IA" / ativar agente),
 * re-enfileiramos os inbounds recebidos DURANTE a janela de pausa
 * (`received_at >= pausedSince`) que ficaram `completed` sem resposta. O
 * queue-processor agrupa por agente+contato, então N mensagens viram 1 turno
 * coerente.
 *
 * Compliance: NÃO recupera quando a pausa foi opt-out/STOP — o lead pediu pra
 * parar; reprocessar e responder violaria o opt-out (LGPD).
 *
 * Cap defensivo: só recupera inbound da janela [pausedSince, agora] limitado às
 * últimas 24h — evita ressuscitar conversa parada há dias quando o resume vem
 * muito depois.
 *
 * Fail-soft: qualquer erro só loga (warn); NUNCA quebra o resume.
 */
const REENQUEUE_WINDOW_MS = 24 * 60 * 60 * 1000; // 24h

export async function reenqueueInboundsSincePause(
  supabase: ReturnType<typeof createAdminClient>,
  args: {
    agentId: string;
    contactId: string;
    pausedSince: string | null | undefined;
    pausedReason: string | null | undefined;
  },
): Promise<{ requeued: number }> {
  const { agentId, contactId, pausedSince, pausedReason } = args;
  try {
    // Sem janela conhecida (conversa não estava pausada / sem ai_paused_at) →
    // nada a recuperar.
    if (!pausedSince) return { requeued: 0 };

    // Opt-out/STOP: o lead pediu pra parar. Reprocessar = responder a quem pediu
    // silêncio. Não recupera (compliance).
    if ((pausedReason || "").toLowerCase().startsWith("opt_out")) return { requeued: 0 };

    const pausedMs = new Date(pausedSince).getTime();
    if (!Number.isFinite(pausedMs)) return { requeued: 0 };

    // Piso = max(início da pausa, agora-24h). Não ressuscita inbound antigo.
    const floorIso = new Date(Math.max(pausedMs, Date.now() - REENQUEUE_WINDOW_MS)).toISOString();
    const nowIso = new Date().toISOString();

    const { data, error } = await supabase
      .from("message_queue")
      .update({ status: "pending", process_after: nowIso })
      .eq("agent_id", agentId)
      .eq("contact_id", contactId)
      .eq("message_direction", "inbound")
      .eq("status", "completed")
      .gte("received_at", floorIso)
      .select("id");

    if (error) {
      console.warn(`[resume-reenqueue] falhou contact=${contactId}: ${error.message}`);
      return { requeued: 0 };
    }

    const n = data?.length ?? 0;
    if (n > 0) {
      console.log(
        `[resume-reenqueue] re-enfileirados ${n} inbound(s) engolidos na pausa — contact=${contactId} agent=${agentId} desde=${floorIso} reason=${pausedReason || "?"}`,
      );
    }
    return { requeued: n };
  } catch (err) {
    console.warn(`[resume-reenqueue] exceção contact=${contactId}: ${err instanceof Error ? err.message : err}`);
    return { requeued: 0 };
  }
}
