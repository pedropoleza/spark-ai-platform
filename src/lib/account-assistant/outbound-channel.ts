/**
 * Decide o canal de saída (SMS vs WhatsApp) pra mensagens proativas e
 * respostas do Sparkbot pro rep.
 *
 * CONTEXTO:
 * - Hoje (2026-05-02): WhatsApp Business API da Meta tá em review.
 *   Pedro plugou Stevo (Evolution) como SMS provider no GHL —
 *   mensagens com type='SMS' são roteadas via Evolution e chegam no
 *   WhatsApp do rep. Então TUDO precisa sair como SMS por enquanto.
 *
 * - Futuro: quando WhatsApp API for liberado:
 *   1. Se janela aberta (último inbound do contato < 24h) → type='WhatsApp'
 *   2. Se fechada ou erro → fallback type='SMS' (Evolution)
 *
 * Como ativar o futuro: setar env var ASSISTANT_OUTBOUND_CHANNEL='auto'
 * (vai exigir implementar o window check em pickWindowAwareChannel).
 *
 * Override: env var ASSISTANT_OUTBOUND_CHANNEL aceita:
 *   - 'SMS' (default) — sempre SMS, pro caso Stevo+Evolution agora
 *   - 'WhatsApp' — sempre WhatsApp (quando API liberada e quiser forçar)
 *   - 'auto' — ainda não implementado, fallback pra SMS
 *   - 'incoming' — espelha o type da msg recebida (comportamento legado)
 */

export type OutboundChannel = "SMS" | "WhatsApp";

/**
 * Pega o canal padrão de saída.
 *
 * @param incomingType - opcional. Type da msg que originou (pra modo
 *   'incoming'/legado). Pode ser undefined se não há contexto inbound
 *   (ex: proativo agendado).
 */
export function pickOutboundChannel(incomingType?: string): OutboundChannel {
  const override = (process.env.ASSISTANT_OUTBOUND_CHANNEL || "SMS").toLowerCase();

  if (override === "whatsapp") return "WhatsApp";
  if (override === "sms") return "SMS";

  // 'incoming' = espelha o type recebido (comportamento legado pré-Evolution)
  if (override === "incoming" && incomingType) {
    return incomingType.toUpperCase().includes("WHATSAPP") ? "WhatsApp" : "SMS";
  }

  // 'auto' = futuro window-aware. Por ora cai pra SMS pois ainda não
  // implementamos checkConversationWindow().
  if (override === "auto") {
    // TODO(future): when WhatsApp API liberado:
    // 1. await checkConversationWindow(contactId, locationId)
    // 2. if openWindow: return "WhatsApp"
    return "SMS";
  }

  return "SMS";
}

/**
 * Helper pra fallback: dado o canal preferido, retorna o "outro" pra
 * tentar caso o primeiro falhe.
 */
export function fallbackChannel(preferred: OutboundChannel): OutboundChannel {
  return preferred === "WhatsApp" ? "SMS" : "WhatsApp";
}
