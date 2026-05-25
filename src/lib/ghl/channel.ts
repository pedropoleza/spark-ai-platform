/**
 * Mapeamento de CANAL ↔ tipo de mensagem do GHL (fonte única).
 *
 * Antes estava duplicado: `channelToMessageType` em action-executor.ts +
 * reaction-engine.ts (idênticos), e `detectChannel` inline no webhook. Centralizado
 * aqui pra um canal novo (ex: futuro) ser adicionado num lugar só.
 *
 * - `detectChannel`  : INBOUND  — type/customData do GHL → canal canônico.
 * - `channelToMessageType` : OUTBOUND — canal canônico → `type` do POST /conversations/messages.
 *
 * Canais canônicos: "SMS" | "WhatsApp" | "Instagram" | "Email".
 */

/** OUTBOUND: canal canônico → tipo de mensagem do GHL (espelha o canal de entrada na resposta). */
export function channelToMessageType(channel?: string): string {
  switch (channel) {
    case "WhatsApp":
      return "WhatsApp";
    case "Instagram":
      return "IG";
    case "Email":
      return "Email";
    default:
      return "SMS";
  }
}

/** INBOUND: messageType/customData.channel do GHL → canal canônico. */
export function detectChannel(messageType: string, customChannel?: string): string {
  if (customChannel) {
    const ch = customChannel.toLowerCase();
    if (ch.includes("whatsapp") || ch.includes("wa")) return "WhatsApp";
    if (ch.includes("instagram") || ch.includes("ig")) return "Instagram";
    if (ch.includes("email")) return "Email";
    if (ch.includes("sms")) return "SMS";
  }
  const mt = messageType?.toUpperCase() || "";
  if (mt.includes("WHATSAPP")) return "WhatsApp";
  if (mt.includes("INSTAGRAM") || mt === "TYPE_IG" || mt === "IG") return "Instagram";
  if (mt.includes("EMAIL")) return "Email";
  if (mt.includes("FB") || mt.includes("FACEBOOK")) return "Instagram";
  return "SMS";
}
