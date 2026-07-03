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
  /** Nome da instância no Stevo (top-level instanceName, ex: "sparkbot").
   *  Só pra audit/logs e pra popular stevo_instances. */
  instanceName: string;
} & ParsedStevoContent;

export type ParsedStevoContent =
  | { kind: "text"; text: string }
  | { kind: "document"; base64: string; mimetype: string; fileName: string; caption: string }
  | { kind: "image"; base64: string; mimetype: string; caption: string }
  | { kind: "audio"; base64: string; mimetype: string; seconds: number }
  /**
   * Resposta a botão/lista (o rep TOCOU). Normalizada pra texto: `text` é o que
   * ele "disse" (label do botão / título da row). `selectionId` é o ID estável
   * que definimos no envio (selectedButtonID / selectedRowID) e `replyToStanzaId`
   * é o ID da mensagem original (correlação/recência). O handler converte isso
   * num turno de texto normal — o miolo (gate H8, coherence) não muda.
   */
  | {
      kind: "interactive";
      interactiveType: "button" | "list";
      text: string;
      selectionId: string;
      replyToStanzaId: string;
      /** Texto da PERGUNTA original que o rep respondeu (de contextInfo.
       *  quotedMessage). Amarra o tap à ação certa quando há várias confirmações
       *  pendentes — o handler injeta isso no turno pro LLM não se confundir. */
      quotedText: string;
    };

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

/**
 * Resolve o telefone do rep com segurança. Só trata como TELEFONE um JID de
 * número (@s.whatsapp.net / @c.us) ou dígitos puros. Se o Info.Sender vier como
 * @lid (LID-addressing — opaco, NÃO é telefone) ou @g.us (grupo), cai pro
 * Info.Chat (em 1:1 traz o JID com o número real). Se nenhum for telefone,
 * retorna "" — NUNCA fabrica "+<lid>" (que dropava/corrompia o rep). Fix do
 * review 2026-05-20.
 */
function resolveSenderPhone(sender: string, chat: string): string {
  const isPhoneJid = (jid: string) =>
    /@(s\.whatsapp\.net|c\.us)$/i.test(jid) || /^\+?\d{6,}$/.test(jid.trim());
  if (isPhoneJid(sender)) return normalizeStevoPhone(sender);
  if (isPhoneJid(chat)) return normalizeStevoPhone(chat);
  return "";
}

/**
 * Extrai o texto da PERGUNTA original de um quotedMessage (o que o rep tocou).
 * Cobre os formatos do Stevo: NativeFlow (interactiveMessage.body.text),
 * listMessage.description/title, buttonsMessage legado, e texto puro. Tira
 * marcação *negrito*, normaliza espaços e trunca em 200 chars.
 */
function extractQuotedText(qm: Record<string, unknown> | null): string {
  if (!qm) return "";
  let t = "";
  const im = asRecord(qm.interactiveMessage);
  if (im) {
    const body = asRecord(im.body);
    if (body) t = asString(body.text);
  }
  if (!t) {
    const lm = asRecord(qm.listMessage);
    if (lm) t = asString(lm.description) || asString(lm.title);
  }
  if (!t) {
    const bm = asRecord(qm.buttonsMessage);
    if (bm) t = asString(bm.contentText) || asString(bm.text);
  }
  if (!t) {
    t = asString(qm.conversation) || asString(asRecord(qm.extendedTextMessage)?.text);
  }
  t = t.replace(/\*/g, "").replace(/\s+/g, " ").trim();
  return t.length > 200 ? `${t.slice(0, 199)}…` : t;
}

/**
 * Extrai {nome, telefone} de um vCard do WhatsApp (contato compartilhado).
 * Formato real (prod): `FN:<nome>` + `TEL;type=CELL;waid=<digitos>:<telefone>`.
 * Telefone = valor após o 1º `:` da linha TEL (o "waid=..." não tem `:`);
 * fallback pro waid como E.164. Fix prod 2026-07-03 (caso Caua/Wilker Fifa).
 */
function parseVcard(vcard: string): { name: string; phone: string } {
  let name = "";
  let phone = "";
  for (const raw of (vcard || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (/^FN:/i.test(line)) name = line.slice(3).trim();
    else if (/^TEL/i.test(line)) {
      const colon = line.indexOf(":");
      if (colon >= 0) phone = line.slice(colon + 1).trim();
      if (!phone) {
        const waid = line.match(/waid=(\d+)/i);
        if (waid) phone = `+${waid[1]}`;
      }
    }
  }
  return { name, phone };
}

/**
 * Coleta os contatos compartilhados de uma mensagem: `contactMessage` (1) ou
 * `contactsArrayMessage.contacts[]` (vários). Prioriza `displayName`; cai pro FN
 * do vCard. Devolve [] quando não há contato.
 */
function collectSharedContacts(message: Record<string, unknown>): Array<{ name: string; phone: string }> {
  const out: Array<{ name: string; phone: string }> = [];
  const push = (raw: Record<string, unknown> | null) => {
    if (!raw) return;
    const parsed = parseVcard(asString(raw.vcard));
    const name = (asString(raw.displayName) || parsed.name).trim();
    const phone = parsed.phone.trim();
    if (name || phone) out.push({ name: name || "(sem nome)", phone: phone || "(sem telefone)" });
  };
  push(asRecord(message.contactMessage));
  const arr = asRecord(message.contactsArrayMessage);
  if (arr && Array.isArray(arr.contacts)) {
    for (const c of arr.contacts) push(asRecord(c));
  }
  return out;
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
  const phone = resolveSenderPhone(asString(info.Sender), asString(info.Chat));
  if (!messageId || !phone) return null;

  const pushName = asString(info.PushName);
  const instanceToken = asString(root.instanceToken);
  const serverUrl = asString(root.serverUrl);
  const instanceName = asString(root.instanceName);
  const mediaType = asString(info.MediaType).toLowerCase();

  const base = { messageId, phone, pushName, instanceToken, serverUrl, instanceName };

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

  // 3b. Resposta interativa — tap em BOTÃO (buttonsResponseMessage) ou seleção
  // de LISTA (listResponseMessage). Normaliza pra texto + carrega o ID estável
  // e o stanzaID da msg original. (Formato real capturado em prod 2026-05-20.)
  const btnResp = asRecord(message.buttonsResponseMessage);
  if (btnResp) {
    const resp = asRecord(btnResp.Response) || asRecord(btnResp.response);
    const display =
      asString(resp?.SelectedDisplayText) ||
      asString(resp?.selectedDisplayText) ||
      asString(btnResp.selectedDisplayText);
    const selectionId =
      asString(btnResp.selectedButtonID) || asString(btnResp.selectedButtonId);
    const ctx = asRecord(btnResp.contextInfo);
    const stanza = asString(ctx?.stanzaID) || asString(ctx?.stanzaId);
    const quotedText = extractQuotedText(asRecord(ctx?.quotedMessage));
    const textVal = display || selectionId;
    if (textVal) {
      return {
        ...base,
        kind: "interactive",
        interactiveType: "button",
        text: textVal,
        selectionId,
        replyToStanzaId: stanza,
        quotedText,
      };
    }
  }

  // 3c. Tap em botão no formato TEMPLATE/NATIVE-FLOW (templateButtonReplyMessage).
  // Fix bug observado em prod 2026-06-18 (Matheus Curty, +1 732…): alguns clientes
  // de WhatsApp (Business/versões) mandam o tap como `templateButtonReplyMessage`
  // com Info.Type="text"/MediaType="" — NÃO como buttonsResponseMessage. Sem este
  // ramo, o "Aceito ✅" era descartado, terms_accepted_at nunca gravava e o rep
  // ficava em LOOP de termos (toda msg reenviava os termos). selectedID carrega o
  // ID estável (terms_accept/terms_reject). Mesmo shape dos outros taps.
  const tplResp = asRecord(message.templateButtonReplyMessage);
  if (tplResp) {
    const selectionId =
      asString(tplResp.selectedID) || asString(tplResp.selectedId);
    const display = asString(tplResp.selectedDisplayText);
    const ctx = asRecord(tplResp.contextInfo);
    const stanza = asString(ctx?.stanzaID) || asString(ctx?.stanzaId);
    const quotedText = extractQuotedText(asRecord(ctx?.quotedMessage));
    const textVal = display || selectionId;
    if (textVal) {
      return {
        ...base,
        kind: "interactive",
        interactiveType: "button",
        text: textVal,
        selectionId,
        replyToStanzaId: stanza,
        quotedText,
      };
    }
  }

  const listResp = asRecord(message.listResponseMessage);
  if (listResp) {
    const sel = asRecord(listResp.singleSelectReply);
    const selectionId =
      asString(sel?.selectedRowID) || asString(sel?.selectedRowId);
    const display = asString(listResp.title);
    const ctx = asRecord(listResp.contextInfo);
    const stanza = asString(ctx?.stanzaID) || asString(ctx?.stanzaId);
    const quotedText = extractQuotedText(asRecord(ctx?.quotedMessage));
    const textVal = display || selectionId;
    if (textVal) {
      return {
        ...base,
        kind: "interactive",
        interactiveType: "list",
        text: textVal,
        selectionId,
        replyToStanzaId: stanza,
        quotedText,
      };
    }
  }

  // 3d. Contato compartilhado (vCard). WhatsApp manda Info.MediaType "vcard" com
  // Message.contactMessage.{vcard,displayName} (1 contato) ou
  // Message.contactsArrayMessage.contacts[] (vários). SEM este ramo o cartão caía
  // no "nada reconhecível" → era DESCARTADO: o rep compartilhava um contato e o
  // bot NEM VIA (resolvia "ele/esse" pro último contato conhecido e agia na pessoa
  // errada). Fix prod 2026-07-03 (caso Caua Botelho / Wilker Fifa). Normaliza pra
  // TEXTO nome+telefone → o LLM age (achar/criar contato, pôr no funil) usando a
  // resolução de contato normal.
  const sharedContacts = collectSharedContacts(message);
  if (sharedContacts.length > 0) {
    const text =
      sharedContacts.length === 1
        ? `📇 Contato compartilhado: ${sharedContacts[0].name} — ${sharedContacts[0].phone}`
        : `📇 Contatos compartilhados:\n${sharedContacts.map((c) => `• ${c.name} — ${c.phone}`).join("\n")}`;
    return { ...base, kind: "text", text };
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
