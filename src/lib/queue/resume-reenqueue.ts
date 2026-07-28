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
    /**
     * MC-4 (review Marcia 2026-07-28): janela custom em ms. O piso fixo de 24h
     * deixou de fora tudo engolido nas primeiras ~16h do blackout de wallet de
     * 40h (19→21/07, jA6u) — ~25-30 contatos sem recuperação. O caller de
     * wallet passa a janela real do episódio; os demais mantêm o default 24h.
     */
    windowMs?: number;
    /**
     * MC-5: marca a conversa como retomada manualmente (ai_resumed_at) ANTES do
     * requeue — o gate de targeting do queue-processor honra manuallyResumed e
     * não re-engole o recovery quando a tag do contato foi flipada (burst de
     * 21/07: 25 leads re-enfileirados morreram TODOS no targeting_skip).
     */
    bypassTargeting?: boolean;
  },
): Promise<{ requeued: number }> {
  const { agentId, contactId, pausedSince, pausedReason } = args;
  try {
    // Sem janela conhecida (conversa não estava pausada / sem ai_paused_at) →
    // nada a recuperar.
    if (!pausedSince) return { requeued: 0 };

    const reasonLc = (pausedReason || "").toLowerCase();
    // Opt-out/STOP: o lead pediu pra parar. Reprocessar = responder a quem pediu
    // silêncio. Não recupera (compliance).
    if (reasonLc.startsWith("opt_out")) return { requeued: 0 };
    // Handoff humano (Fix review 2026-06-18): se a pausa foi porque um humano/2º
    // atendente assumiu (auto_pause:human_message / human_handling), NÃO re-enfileira
    // — o humano pode já ter respondido essas msgs no inbox do GHL (fora do nosso
    // pipeline) e re-responder colidiria. Recupera só pausa de sistema/manual.
    if (reasonLc.includes("human")) return { requeued: 0 };

    const pausedMs = new Date(pausedSince).getTime();
    if (!Number.isFinite(pausedMs)) return { requeued: 0 };

    // Piso = max(início da pausa, agora-janela). Não ressuscita inbound antigo.
    // MC-4: janela custom do caller (wallet passa a duração real do episódio).
    const windowMs = args.windowMs && args.windowMs > 0 ? args.windowMs : REENQUEUE_WINDOW_MS;
    const floorIso = new Date(Math.max(pausedMs, Date.now() - windowMs)).toISOString();
    const nowIso = new Date().toISOString();

    // MC-5: recovery deliberado não pode morrer no targeting (tag flipada
    // durante a pausa). ai_resumed_at ativa o manuallyResumed do gate (GU-6).
    if (args.bypassTargeting) {
      await supabase
        .from("conversation_state")
        .update({ ai_resumed_at: nowIso })
        .eq("agent_id", agentId)
        .eq("contact_id", contactId);
    }

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
