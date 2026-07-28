/**
 * Entrada do SparkBot vinda da engine própria (SparkZap). H57.
 *
 * NÃO reimplementa o parser: traduz o ENVELOPE e entrega ao `parseStevoWebhook`,
 * que já lê os 8 formatos reais (texto, áudio PTT, imagem, documento, vCard, tap
 * de botão nos DOIS shapes, seleção de lista). Um parser só = os fixes de prod
 * de meses (templateButtonReplyMessage, vCard do caso Caua…) valem pros dois
 * transportes de graça.
 *
 * Aceita DOIS envelopes:
 *   (a) já traduzido pela ponte do Spark OS — `{event:"Message", data:{…},
 *       transport:"sparkzap"}` (é o caminho normal: o OS resolve LID→telefone
 *       com o `wa_lid_map`, que só ele tem);
 *   (b) cru do engine — `{type:"Message", event:{Info,Message}, instanceName}`.
 *       Serve pra apontar a sessão do engine DIRETO pra cá se um dia o Pedro
 *       quiser tirar o hop. ⚠️ Neste caminho, DM em endereçamento LID sem
 *       `SenderAlt` no payload não tem como virar telefone aqui — o parser
 *       devolve null e a rota registra o motivo (o hop pelo OS resolve isso).
 */

import { parseStevoWebhook, type ParsedStevoMessage } from "./stevo-parser";

type Dict = Record<string, unknown>;

function asRecord(v: unknown): Dict | null {
  return v && typeof v === "object" ? (v as Dict) : null;
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const PHONE_SUFFIX = "@s.whatsapp.net";

function isLid(v: string): boolean {
  return v.endsWith("@lid");
}

function isPhoneJid(v: string): boolean {
  return v.endsWith(PHONE_SUFFIX) || v.endsWith("@c.us");
}

/**
 * Normalização LID de ÚLTIMO RECURSO (envelope cru, caminho (b)): usa só o que
 * vem no próprio payload — `SenderAlt`/`RecipientAlt`. Sem tabela de LID aqui
 * (ela mora no Spark OS); o que não resolve vira `null` lá em cima, com log.
 */
function normalizeInfoFromPayload(info: Dict): Dict {
  const out: Dict = { ...info };
  const chat = asString(out.Chat);
  const sender = asString(out.Sender);
  const senderAlt = asString(out.SenderAlt);
  const recipientAlt = asString(out.RecipientAlt);
  const fromMe = out.IsFromMe === true;

  if (isLid(chat)) {
    if (fromMe && isPhoneJid(recipientAlt)) out.Chat = recipientAlt;
    else if (!fromMe && isPhoneJid(senderAlt)) out.Chat = senderAlt;
  }
  if (isLid(sender)) {
    if (isPhoneJid(senderAlt)) {
      out.Sender = senderAlt;
      out.SenderAlt = sender;
    } else if (!fromMe && out.IsGroup !== true && isPhoneJid(asString(out.Chat))) {
      out.Sender = asString(out.Chat);
      out.SenderAlt = sender;
    }
  }
  return out;
}

export type SparkZapParseFailure =
  | "not_a_message"
  | "unresolved_lid"
  | "not_processable";

export type SparkZapParseResult =
  | { ok: true; parsed: ParsedStevoMessage }
  | { ok: false; reason: SparkZapParseFailure };

/**
 * Normaliza o corpo recebido pra o shape do Stevo e parseia.
 * Devolve o motivo da recusa (em vez de só `null`) pra a rota conseguir
 * DISTINGUIR "evento que não interessa" de "mensagem perdida por LID" — sem
 * isso, o LID não resolvido seria um descarte silencioso (o mesmo bug que a
 * ponte do OS existe pra evitar).
 */
export function parseSparkZapWebhook(body: unknown): SparkZapParseResult {
  const root = asRecord(body);
  if (!root) return { ok: false, reason: "not_a_message" };

  let stevoShaped: Dict;

  if (asString(root.event) === "Message" && asRecord(root.data)) {
    // (a) já traduzido pela ponte.
    stevoShaped = root;
  } else if (asString(root.type) === "Message") {
    // (b) envelope cru do engine.
    const event = asRecord(root.event) ?? {};
    const data: Dict = { ...event };
    const info = asRecord(data.Info);
    if (info) data.Info = normalizeInfoFromPayload(info);
    stevoShaped = {
      event: "Message",
      instanceName: asString(root.instanceName),
      instanceToken: "",
      serverUrl: "",
      data,
    };
  } else {
    return { ok: false, reason: "not_a_message" };
  }

  const info = asRecord(asRecord(stevoShaped.data)?.Info) ?? {};
  const chat = asString(info.Chat);
  const sender = asString(info.Sender);
  if (isLid(chat) || isLid(sender)) {
    // O `resolveSenderPhone` devolveria "" e a mensagem sumiria sem rastro.
    return { ok: false, reason: "unresolved_lid" };
  }

  const parsed = parseStevoWebhook(stevoShaped);
  if (!parsed) return { ok: false, reason: "not_processable" };

  // Marca o transporte: é por ele que o handler decide por onde RESPONDER
  // (o SparkZap não devolve serverUrl/apikey como o Stevo faz).
  return { ok: true, parsed: { ...parsed, transport: "sparkzap" } };
}
