/**
 * Parser PURO do webhook de RECEBIMENTO do Stevo (canal WhatsApp direto).
 *
 * Pedro 2026-05-20: o recebimento passou a vir do Stevo DIRETO (o webhook do
 * GHL vira fallback). Este módulo é a parte mais pura do pipeline — recebe o
 * body cru do webhook do Stevo e devolve um `ParsedStevoMessage` tipado, ou
 * `null` quando a mensagem deve ser ignorada (evento != Message, fromMe, grupo,
 * conteúdo irreconhecível). SEM I/O: nada de DB, fetch, transcrição. Caller
 * (stevo-handler.ts) que faz o resto.
 *
 * FORMATO REAL do Stevo (capturado em prod via stevo_webhook_samples, fonte de
 * verdade — 4 tipos: texto, documento, imagem, áudio PTT):
 *
 *   { event: "Message", instanceName, instanceToken,
 *     data: {
 *       Info: { ID, Chat, Sender, Type: "text"|"media",
 *               MediaType: ""|"document"|"image"|"ptt",
 *               IsFromMe, IsGroup, PushName, Timestamp },
 *       Message: {
 *         conversation: "<texto>" | extendedTextMessage: { text },
 *         documentMessage: { fileName, mimetype, caption, fileLength },
 *         imageMessage: { mimetype, caption },
 *         audioMessage: { PTT, mimetype, seconds },
 *         base64: "<binário DECRIPTADO em base64>"
 *       } } }
 *
 * IMPORTANTE: o Stevo entrega o binário JÁ DECRIPTADO em `data.Message.base64`.
 * A URL `.enc` do WhatsApp é E2E e NÃO serve. Caller usa Buffer.from(base64,
 * "base64") direto.
 */

// ---------------------------------------------------------------------------
// Tipos de saída
// ---------------------------------------------------------------------------

export type ParsedStevoMessage = {
  /** ID da mensagem no WhatsApp (Info.ID) — usado como ghl_message_id pra dedup. */
  messageId: string;
  /** Telefone do rep normalizado pra +<dígitos> (parte antes de "@" no Sender). */
  phone: string;
  /** Nome do contato no WhatsApp (Info.PushName) — pode ser vazio. */
  pushName: string;
  /** Token da instância Stevo (top-level instanceToken) — pra validar origem.
   *  Dobra como `apikey` no header do envio (Stevo API /send/text). */
  instanceToken: string;
  /** Base URL da instância no Stevo (top-level serverUrl, ex:
   *  "https://smv2-3.stevo.chat"). Usado pra ENVIAR a resposta de volta pela
   *  MESMA instância que recebeu — robusto a migração de servidor do Stevo. */
  serverUrl: string;
} & ParsedStevoContent;

export type ParsedStevoContent =
  | { kind: "text"; text: string }
  | { kind: "document"; base64: string; mimetype: string; fileName: string; caption: string }
  | { kind: "image"; base64: string; mimetype: string; caption: string }
  | { kind: "audio"; base64: string; mimetype: string; seconds: number };

// ---------------------------------------------------------------------------
// Helpers internos
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

/**
 * Normaliza o Sender do Stevo (ex: "17867717077@s.whatsapp.net") pra +<dígitos>.
 * Pega só a parte antes do "@", extrai dígitos e prefixa "+". O Sender do
 * WhatsApp já vem com country code completo (sem ambiguidade BR/US), então não
 * precisamos da heurística de normalizePhone — só prefixar o "+".
 */
function normalizeStevoPhone(sender: string): string {
  const localPart = sender.split("@")[0] || "";
  const digits = localPart.replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

// ---------------------------------------------------------------------------
// Parser principal
// ---------------------------------------------------------------------------

/**
 * Parseia o body do webhook do Stevo. Retorna `null` (ignora) quando:
 *   - body.event !== "Message" (eventos de status/conexão/etc)
 *   - data.Info.IsFromMe === true (eco da nossa própria mensagem → evita loop)
 *   - data.Info.IsGroup === true (não respondemos grupos)
 *   - conteúdo irreconhecível (sem texto/mídia útil) ou sem messageId/phone
 */
export function parseStevoWebhook(body: unknown): ParsedStevoMessage | null {
  const root = asRecord(body);
  if (!root) return null;

  // Só processa eventos de mensagem.
  if (asString(root.event) !== "Message") return null;

  const data = asRecord(root.data);
  if (!data) return null;

  const info = asRecord(data.Info);
  const message = asRecord(data.Message);
  if (!info || !message) return null;

  // Eco da nossa própria mensagem → ignora (evita loop infinito).
  if (info.IsFromMe === true) return null;
  // Grupos não são suportados.
  if (info.IsGroup === true) return null;

  const messageId = asString(info.ID);
  const phone = normalizeStevoPhone(asString(info.Sender));
  if (!messageId || !phone) return null;

  const pushName = asString(info.PushName);
  const instanceToken = asString(root.instanceToken);
  const serverUrl = asString(root.serverUrl);
  const mediaType = asString(info.MediaType).toLowerCase();

  const base = { messageId, phone, pushName, instanceToken, serverUrl };

  // 1. Áudio (PTT / voice note) — MediaType "ptt" ou "audio".
  if (mediaType === "ptt" || mediaType === "audio") {
    const audioMsg = asRecord(message.audioMessage);
    const base64 = asString(message.base64);
    if (audioMsg && base64) {
      const secondsRaw = audioMsg.seconds;
      const seconds = typeof secondsRaw === "number" ? secondsRaw : Number(secondsRaw) || 0;
      return {
        ...base,
        kind: "audio",
        base64,
        mimetype: asString(audioMsg.mimetype) || "audio/ogg",
        seconds,
      };
    }
    // Áudio sem binário decriptado — irreconhecível (não dá pra transcrever).
    return null;
  }

  // 2. Documento (CSV, PDF, XLSX, etc.) — MediaType "document".
  const docMsg = asRecord(message.documentMessage);
  if (docMsg) {
    const base64 = asString(message.base64);
    if (!base64) return null; // sem binário → não dá pra processar
    return {
      ...base,
      kind: "document",
      base64,
      mimetype: asString(docMsg.mimetype),
      fileName: asString(docMsg.fileName),
      caption: asString(docMsg.caption),
    };
  }

  // 3. Imagem — MediaType "image".
  const imgMsg = asRecord(message.imageMessage);
  if (imgMsg) {
    const base64 = asString(message.base64);
    if (!base64) return null; // sem binário → não dá pra processar
    return {
      ...base,
      kind: "image",
      base64,
      mimetype: asString(imgMsg.mimetype) || "image/jpeg",
      caption: asString(imgMsg.caption),
    };
  }

  // 4. Texto — conversation OU extendedTextMessage.text.
  let text = asString(message.conversation);
  if (!text) {
    const ext = asRecord(message.extendedTextMessage);
    if (ext) text = asString(ext.text);
  }
  if (text) {
    return { ...base, kind: "text", text };
  }

  // Nada reconhecível.
  return null;
}
