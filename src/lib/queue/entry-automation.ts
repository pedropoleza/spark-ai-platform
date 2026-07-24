/**
 * Silêncio na entrada quando a conta usa AUTOMAÇÃO pra receber o lead
 * (healthcheck five star ricos 2026-07-23, caso Kayla/Márcia).
 *
 * Contexto: a location tem uma automação (GHL) que, no 1º contato, já manda
 * saudação + um ÁUDIO explicando o produto + a lista de dados necessários. O
 * agente de vendas (cego pra essa automação — lead_history OFF) respondia a
 * MESMA primeira mensagem do lead, explicando o produto de novo e pedindo os
 * mesmos dados = duplicação da recepção. Piorou quando um anúncio novo passou a
 * injetar "quero entender como funciona" como 1ª mensagem (→ a IA explicava).
 *
 * Decisão (Pedro + suporte, 2026-07-23): a automação é DONA da entrada. A IA
 * NÃO responde a 1ª mensagem; entra só a partir da RESPOSTA real do lead pra
 * concluir (coletar o que falta + agendar). Se o lead não responder, o próprio
 * follow-up cobra os dados.
 *
 * Este módulo é a lógica PURA da decisão (sem I/O) pra ser testável. O
 * queue-processor chama `shouldSuppressEntry` no gate e, se true, pula o turno
 * da IA, marca `entry_suppressed_at`, agenda o follow-up e audita.
 */

/**
 * Salvaguarda: a 1ª mensagem já traz DADO (data de nascimento, idade, telefone)
 * ou PEDIDO DE HORÁRIO? Nesse caso NÃO silencia — o lead já adiantou algo real e
 * ignorá-lo seria pior que a duplicação.
 *
 * Conservador de propósito (bias pró-silêncio): só considera "tem sinal" em
 * evidência CLARA. Um falso-negativo (silenciar quem mandou dado) só atrasa 1
 * mensagem (a IA assume no próximo turno / o follow-up cobra); um falso-positivo
 * (não silenciar a mensagem do anúncio) traz de volta a duplicação que estamos
 * corrigindo. Tira URLs antes (link de anúncio fb.me tem dígitos e daria falso
 * positivo).
 */
export function messageHasIntakeSignal(text: string): boolean {
  if (!text || typeof text !== "string") return false;
  // Remove URLs e a linha-tag do anúncio ("📢 Veio de anúncio (facebook): ...").
  const s = text
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/\b(fb\.me|wa\.me)\/\S+/gi, " ");

  // Data de nascimento (dd/mm, dd/mm/aaaa, dd-mm-aaaa)
  if (/\b\d{1,2}[\/\-.]\d{1,2}(?:[\/\-.]\d{2,4})?\b/.test(s)) return true;
  // Ano de nascimento (19xx / 20xx)
  if (/\b(?:19|20)\d{2}\b/.test(s)) return true;
  // Idade ("45 anos", "tenho 60")
  if (/\b\d{1,3}\s*anos?\b/i.test(s)) return true;
  if (/\btenho\s+\d{1,3}\b/i.test(s)) return true;
  // Telefone / número longo (após tirar URL)
  if (/\b\d{5,}\b/.test(s)) return true;
  // Pedido de horário / agendamento
  if (
    /\b(agendar|agenda|marcar|remarcar|hor[aá]rio|que horas|dispon[ií]vel|pode ser (?:hoje|amanh[ãa]|segunda|ter[çc]a|quarta|quinta|sexta|s[áa]bado|domingo))\b/i.test(
      s,
    )
  )
    return true;

  return false;
}

export interface SuppressEntryInput {
  /** config.entry_by_automation do agente. */
  enabled: boolean | null | undefined;
  /** A IA já respondeu ≥1× neste segmento (last_ai_response_at || message_count>0). */
  conversationActive: boolean;
  /** conversation_state.entry_suppressed_at — já silenciamos a entrada antes? */
  entrySuppressedAt: string | null | undefined;
  /** Texto agregado da mensagem atual do lead. */
  messageText: string;
  /** Fluxo proativo (dispatcher/cron) NÃO é entrada de lead — nunca silencia. */
  isProactive?: boolean;
}

/**
 * Deve silenciar a IA nesta mensagem (deixar a automação ser dona da entrada)?
 * TRUE só quando: flag ON, é a PRIMEIRA mensagem (conversa não-ativa e ainda não
 * silenciamos a entrada), não é proativo, e a mensagem NÃO traz dado/horário.
 */
export function shouldSuppressEntry(input: SuppressEntryInput): boolean {
  if (!input.enabled) return false;
  if (input.isProactive) return false;
  if (input.conversationActive) return false; // já é conversa em andamento
  if (input.entrySuppressedAt) return false; // já silenciamos a entrada → agora a IA assume
  if (messageHasIntakeSignal(input.messageText)) return false; // lead já adiantou dado/horário
  return true;
}
