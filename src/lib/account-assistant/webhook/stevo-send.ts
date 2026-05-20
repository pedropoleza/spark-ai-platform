/**
 * Envio de respostas do SparkBot via API do Stevo (StevoManager v2).
 *
 * Pedro 2026-05-20 (fase 2 do novo fluxo): o envio passa a sair pela API do
 * Stevo DIRETO (`POST {serverUrl}/send/text`), em vez de ir pelo GHL. Combina
 * com o recebimento via webhook do Stevo (stevo-handler.ts) — assim o mesmo
 * canal cuida de ida e volta, sem depender do GHL.
 *
 * Spec (swagger StevoManager v2 — https://smv2-3.stevo.chat/swagger/doc.json):
 *   POST {serverUrl}/send/text
 *   Header:  apikey: <instanceToken>           // o MESMO token que vem no webhook
 *   Body:    { number: "<digitos+DDI>", text: "<msg>", delay?: <ms> }
 *   Resp:    JSON com o status/ID da mensagem.
 *
 * IMPORTANTE: a base URL e o apikey vêm do PRÓPRIO inbound (parsed.serverUrl +
 * parsed.instanceToken). Mandar pela mesma instância que recebeu é robusto a
 * migração de servidor do Stevo (smv2-1/2/3…) — não fica hardcoded. Há fallback
 * via env (STEVO_API_BASE / STEVO_SEND_APIKEY) pra paths sem inbound (proativo).
 *
 * Este módulo NÃO decide SE envia — quem decide é o handler (gate
 * STEVO_SEND_ENABLED). Aqui é só o "como": payload, headers, splitter, retries
 * suaves e tratamento de erro sem lançar (o handler roda em waitUntil).
 */

import { splitResponseIntoMessages } from "./sparkbot-send";

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export type StevoSendResult = {
  /** true se TODAS as bolhas foram aceitas pelo Stevo. */
  ok: boolean;
  /** Quantas bolhas (mensagens) foram efetivamente enviadas com sucesso. */
  sent: number;
  /** Total de bolhas que tentamos enviar (após o splitter). */
  total: number;
  /** IDs retornados pelo Stevo, quando disponíveis (1 por bolha enviada). */
  ids: string[];
  /** Primeira mensagem de erro, se houve falha em alguma bolha. */
  error?: string;
};

export type StevoSendParams = {
  /** Base URL da instância (ex: "https://smv2-3.stevo.chat"). */
  serverUrl: string;
  /** apikey = instanceToken da instância. */
  apiKey: string;
  /** Telefone destino — aceita "+1786…", "1786…" ou com "@s.whatsapp.net". */
  number: string;
  /** Texto da resposta (pode conter `---` pra virar múltiplas bolhas). */
  text: string;
  /**
   * "Typing delay" (ms) que o Stevo simula antes de mandar cada bolha. Default
   * 0 (sem delay) — previsível pro primeiro cutover. Pode subir depois pra dar
   * sensação humana. NÃO confundir com o gap client-side entre bolhas (abaixo).
   */
  typingDelayMs?: number;
  /** Timeout por request (ms). Default 15s. */
  timeoutMs?: number;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Normaliza o número pro formato que o Stevo espera: só dígitos, com DDI.
 * O webhook entrega o Sender como "17867717077@s.whatsapp.net" e o parser
 * normaliza pra "+17867717077"; aqui tiramos o "+", "@…" e qualquer não-dígito.
 */
export function normalizeStevoNumber(raw: string): string {
  const localPart = (raw || "").split("@")[0] || "";
  return localPart.replace(/\D/g, "");
}

/** Gap client-side entre bolhas — garante ORDEM visual no WhatsApp. */
const INTER_BUBBLE_GAP_MS = 350;

// ---------------------------------------------------------------------------
// Envio
// ---------------------------------------------------------------------------

/**
 * Envia UMA bolha via Stevo. Não lança — devolve {ok, id?, error?}.
 */
async function sendOneBubble(
  base: string,
  apiKey: string,
  number: string,
  text: string,
  typingDelayMs: number,
  timeoutMs: number,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const url = `${base}/send/text`;
  const body: Record<string, unknown> = { number, text };
  if (typingDelayMs > 0) body.delay = typingDelayMs;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: apiKey,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      };
    }
    // Resposta de sucesso: tenta extrair um ID de mensagem (formato varia).
    let id: string | undefined;
    try {
      const json = (await res.json()) as Record<string, unknown>;
      id =
        (json?.id as string) ||
        (json?.messageId as string) ||
        ((json?.key as Record<string, unknown>)?.id as string) ||
        undefined;
    } catch {
      /* corpo não-JSON em sucesso — ok, sem ID */
    }
    return { ok: true, id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.includes("abort") ? `timeout após ${timeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Envia a resposta do bot via Stevo. Aplica o MESMO splitter do GHL (`---` →
 * múltiplas bolhas, cap 3), com gap entre bolhas pra preservar ordem. Robusto:
 * nunca lança; agrega o resultado de cada bolha.
 */
export async function sendStevoText(params: StevoSendParams): Promise<StevoSendResult> {
  const base = (params.serverUrl || "").trim().replace(/\/+$/, "");
  const apiKey = (params.apiKey || "").trim();
  const number = normalizeStevoNumber(params.number);
  const typingDelayMs = params.typingDelayMs ?? 0;
  const timeoutMs = params.timeoutMs ?? 15_000;

  if (!base || !apiKey || !number) {
    return {
      ok: false,
      sent: 0,
      total: 0,
      ids: [],
      error: `params inválidos (base=${!!base} apiKey=${!!apiKey} number=${!!number})`,
    };
  }

  const bubbles = splitResponseIntoMessages(params.text);
  if (bubbles.length === 0) {
    return { ok: false, sent: 0, total: 0, ids: [], error: "texto vazio — nada a enviar" };
  }

  const ids: string[] = [];
  let sent = 0;
  let firstError: string | undefined;

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, INTER_BUBBLE_GAP_MS));
    const r = await sendOneBubble(base, apiKey, number, bubbles[i], typingDelayMs, timeoutMs);
    if (r.ok) {
      sent++;
      if (r.id) ids.push(r.id);
    } else if (!firstError) {
      firstError = r.error;
      // Falhou uma bolha → não insiste nas próximas (evita resposta pela metade
      // repetida em caso de retry). Loga e para.
      console.warn(`[stevo-send] bolha ${i + 1}/${bubbles.length} falhou: ${r.error}`);
      break;
    }
  }

  return {
    ok: sent === bubbles.length,
    sent,
    total: bubbles.length,
    ids,
    error: firstError,
  };
}
