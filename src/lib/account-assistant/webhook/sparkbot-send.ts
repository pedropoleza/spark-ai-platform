/**
 * Envio de respostas do SparkBot pro rep via GHL.
 *
 * Extraído de webhook-handler.ts na V2.2 (decomposição do god-file, ver
 * _planning/_review-2026-05-19/B1-arquitetura.md §4). Inclui o splitter de
 * mensagens (`---` → múltiplas bolhas) e o fallback de canal SMS↔WhatsApp.
 *
 * Comportamento preservado BYTE-A-BYTE em relação às funções que moravam no
 * handler (`splitResponseIntoMessages`, `sendSingleMessageToRep`,
 * `sendResponseToRep`) — só mudaram de arquivo.
 */

import { GHLClient } from "@/lib/ghl/client";
import { pickOutboundChannel, fallbackChannel } from "../outbound-channel";

/**
 * Splitter: bot pode escrever resposta com `---` em linha sozinha pra
 * sinalizar break entre mensagens. No WhatsApp, vira múltiplas bolhas
 * (mais legível que bolha gigante). Web UI ignora — renderiza como hr.
 *
 * Limita a 3 partes por turn pra evitar spam. Cada parte recebe trim.
 * Linhas com só `---` ou `***` (qualquer comprimento >= 3) são separadores.
 */
export function splitResponseIntoMessages(text: string): string[] {
  if (!text) return [];
  // Regex: linha contendo APENAS 3+ dashes/asterisks (pode ter espaços ao redor)
  const SPLITTER_REGEX = /^\s*[-*]{3,}\s*$/m;
  const parts = text
    .split(/\r?\n/)
    .reduce<string[][]>((acc, line) => {
      if (SPLITTER_REGEX.test(line)) {
        if (acc.length === 0) acc.push([]);
        acc.push([]);
      } else {
        if (acc.length === 0) acc.push([]);
        acc[acc.length - 1].push(line);
      }
      return acc;
    }, [])
    .map((lines) => lines.join("\n").trim())
    .filter((s) => s.length > 0);

  // Sem splitter → retorna msg única
  if (parts.length === 0) return [text.trim()].filter((s) => s.length > 0);
  // Cap em 3 partes
  return parts.slice(0, 3);
}

/**
 * Envia resposta pro rep via GHL.
 *
 * Default agora é SMS (Stevo/Evolution roteia pro WhatsApp do rep) porque
 * a WhatsApp Business API ainda tá em review. Quando liberada, basta setar
 * ASSISTANT_OUTBOUND_CHANNEL=auto e implementar checkConversationWindow.
 *
 * Mantém fallback pra outro canal em caso de falha (ex: SMS provider down →
 * tenta WhatsApp; ou WhatsApp 24h-window fechada → tenta SMS).
 *
 * Suporta SPLITTER: se text contém linhas `---`, manda múltiplas mensagens
 * separadas (delay 300ms entre) — cada uma vira uma bolha distinta no
 * WhatsApp. Bot decide via system prompt (channel='whatsapp' instructions).
 */
export async function sendResponseToRep(
  client: GHLClient,
  contactId: string,
  conversationId: string,
  incomingType: string,
  text: string,
): Promise<void> {
  const messages = splitResponseIntoMessages(text);
  for (let i = 0; i < messages.length; i++) {
    if (i > 0) {
      // Delay entre mensagens — garante ordem visual no WhatsApp
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    await sendSingleMessageToRep(client, contactId, conversationId, incomingType, messages[i]);
  }
}

async function sendSingleMessageToRep(
  client: GHLClient,
  contactId: string,
  conversationId: string,
  incomingType: string,
  text: string,
): Promise<void> {
  const tryType = pickOutboundChannel(incomingType);
  const payload: Record<string, unknown> = {
    type: tryType,
    contactId,
    message: text,
  };
  if (conversationId) payload.conversationId = conversationId;

  try {
    await client.post("/conversations/messages", payload);
  } catch (err) {
    const fb = fallbackChannel(tryType);
    console.warn(
      `[Sparkbot] send failed on ${tryType} — trying fallback ${fb}:`,
      err instanceof Error ? err.message : err,
    );
    try {
      await client.post("/conversations/messages", {
        type: fb,
        contactId,
        message: text,
        ...(conversationId ? { conversationId } : {}),
      });
    } catch (err2) {
      console.error("[Sparkbot] send fallback also failed:", err2 instanceof Error ? err2.message : err2);
    }
  }
}
