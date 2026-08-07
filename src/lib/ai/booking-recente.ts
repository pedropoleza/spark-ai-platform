/**
 * "Este horário já foi agendado agora há pouco?" — respondido pelo NOSSO log,
 * não pelo CRM.
 *
 * Fix bug observado em prod 2026-08-07 (H73, caso Márcia/Five Star; mesma
 * assinatura do caso Marta Lúcia/Liberty em 04/08): o lead confirma, a IA
 * agenda e responde "Agendado!"; o lead manda um "ok" e o modelo RE-EMITE o
 * mesmo `book_appointment`. Nessa segunda passada o horário já não está mais
 * nos free-slots — quem o ocupou foi a própria reunião do turno anterior — o
 * guard H58 barra e o lead recebe "Desculpa, não consegui agendar nesse
 * horário" logo depois de ter sido agendado. Foi a queixa nº 2 da Márcia
 * ("apresenta horários, diz que nenhum está disponível, e marca o cliente").
 *
 * O escape que existia (H61) pergunta ao Spark Leads se o contato já tem
 * appointment naquele instante — e ele falhou nos casos reais: a reunião tinha
 * acabado de ser criada e os endpoints de busca ainda não a devolviam. Por isso
 * a primeira pergunta agora é ao `execution_log`, que é escrito por nós, na
 * mesma transação lógica do booking, sem lag de indexação. O fetch do CRM
 * continua como segunda linha (cobre reunião criada por outro turno/canal).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { isSameSlotInstant } from "@/lib/ai/slot-guard";

/** Janela em que uma re-emissão ainda é "o mesmo booking", não um pedido novo. */
export const JANELA_BOOKING_RECENTE_MS = 15 * 60_000;

export type BookingRecente = { start_time: string; created_at: string };

/**
 * Decide, a partir das linhas de log, se `startTime` já foi agendado com
 * sucesso na janela. PURO — exportado pra teste sem banco.
 */
export function achaBookingNoMesmoInstante(
  linhas: BookingRecente[],
  startTime: string | undefined | null,
  agora: Date,
  janelaMs = JANELA_BOOKING_RECENTE_MS,
): BookingRecente | null {
  if (!startTime) return null;
  for (const l of linhas) {
    const t = Date.parse(l.created_at);
    if (Number.isNaN(t) || agora.getTime() - t > janelaMs) continue;
    if (isSameSlotInstant(l.start_time, startTime)) return l;
  }
  return null;
}

/**
 * Consulta o `execution_log` do MESMO agente+contato. Fail-open: qualquer erro
 * devolve null e o caminho antigo (fetch no CRM) segue valendo — este check só
 * pode EVITAR um erro falso, nunca criar um.
 */
export async function buscaBookingRecente(
  agentId: string,
  contactId: string,
  startTime: string | undefined | null,
  janelaMs = JANELA_BOOKING_RECENTE_MS,
): Promise<BookingRecente | null> {
  if (!startTime || !agentId || !contactId) return null;
  try {
    const supabase = createAdminClient();
    const desde = new Date(Date.now() - janelaMs).toISOString();
    const { data } = await supabase
      .from("execution_log")
      .select("action_payload,created_at")
      .eq("agent_id", agentId)
      .eq("contact_id", contactId)
      .eq("success", true)
      .in("action_type", ["book_appointment", "reschedule_appointment"])
      .gte("created_at", desde)
      .order("created_at", { ascending: false })
      .limit(20);
    const linhas: BookingRecente[] = (data ?? [])
      .map((r) => {
        const p = (r.action_payload ?? {}) as Record<string, unknown>;
        const st = typeof p.start_time === "string" ? p.start_time : "";
        return st ? { start_time: st, created_at: String(r.created_at) } : null;
      })
      .filter((x): x is BookingRecente => x !== null);
    return achaBookingNoMesmoInstante(linhas, startTime, new Date(), janelaMs);
  } catch {
    return null;
  }
}
