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
 * POST genérico pra um endpoint de `/send/*` do Stevo. Header `apikey` +
 * timeout. NÃO lança — devolve {ok, id?, error?}. Reusado por text/button/list.
 * Extrai o ID da mensagem do response (vários formatos, incl. data.Info.ID —
 * que é o `stanzaID` usado pra correlacionar o tap depois).
 */
async function stevoPostJson(
  base: string,
  apiKey: string,
  path: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}${path}`, {
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
        (((json?.data as Record<string, unknown>)?.Info as Record<string, unknown>)
          ?.ID as string) ||
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
 * Envia UMA bolha de texto via Stevo (`/send/text`). Wrapper fino sobre
 * stevoPostJson. Não lança — devolve {ok, id?, error?}.
 */
async function sendOneBubble(
  base: string,
  apiKey: string,
  number: string,
  text: string,
  typingDelayMs: number,
  timeoutMs: number,
): Promise<{ ok: boolean; id?: string; error?: string }> {
  const body: Record<string, unknown> = { number, text };
  if (typingDelayMs > 0) body.delay = typingDelayMs;
  return stevoPostJson(base, apiKey, "/send/text", body, timeoutMs);
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

// ---------------------------------------------------------------------------
// Interativo — botões e listas (v1) · vCard (v2)
// ---------------------------------------------------------------------------

export type StevoButton = { id: string; label: string };
export type StevoListRow = { rowId: string; title: string; description?: string };
export type StevoListSection = { title?: string; rows: StevoListRow[] };

// Limites do WhatsApp (regras duras — truncamos/capamos antes de enviar).
const MAX_BUTTONS = 3;
const MAX_LIST_ROWS = 10;
const BTN_LABEL_MAX = 20;
const ROW_TITLE_MAX = 24;
const ROW_DESC_MAX = 72;
const HEADER_MAX = 60;
const LIST_BTN_MAX = 20;

function truncate(s: string, n: number): string {
  const t = (s || "").trim();
  return t.length <= n ? t : `${t.slice(0, n - 1)}…`;
}

export type StevoButtonParams = {
  serverUrl: string;
  apiKey: string;
  number: string;
  /** Corpo (body) da mensagem. */
  body: string;
  /** Header opcional (acima do body). */
  title?: string;
  /** Footer opcional (abaixo). */
  footer?: string;
  /** Até 3 botões de quick-reply. Excedente é descartado. */
  buttons: StevoButton[];
  timeoutMs?: number;
};

/**
 * Envia uma mensagem de BOTÕES (quick-reply) via Stevo (`/send/button`).
 * `type:"reply"` → o Stevo traduz pra NativeFlow quick_reply (confirmado no
 * probe). O tap volta com `selectedButtonID` = o `id` que passamos aqui.
 * Capa em 3 botões e trunca labels. NÃO lança.
 */
export async function sendStevoButton(p: StevoButtonParams): Promise<StevoSendResult> {
  const base = (p.serverUrl || "").trim().replace(/\/+$/, "");
  const apiKey = (p.apiKey || "").trim();
  const number = normalizeStevoNumber(p.number);
  const timeoutMs = p.timeoutMs ?? 15_000;
  const buttons = (p.buttons || []).slice(0, MAX_BUTTONS).map((b) => ({
    displayText: truncate(b.label, BTN_LABEL_MAX),
    id: b.id,
    type: "reply",
  }));

  if (!base || !apiKey || !number || !p.body?.trim() || buttons.length === 0) {
    return {
      ok: false,
      sent: 0,
      total: 1,
      ids: [],
      error: `params inválidos (base=${!!base} apiKey=${!!apiKey} number=${!!number} body=${!!p.body?.trim()} buttons=${buttons.length})`,
    };
  }

  const payload: Record<string, unknown> = { number, description: p.body.trim(), buttons };
  if (p.title) payload.title = truncate(p.title, HEADER_MAX);
  if (p.footer) payload.footer = truncate(p.footer, HEADER_MAX);

  const r = await stevoPostJson(base, apiKey, "/send/button", payload, timeoutMs);
  return { ok: r.ok, sent: r.ok ? 1 : 0, total: 1, ids: r.id ? [r.id] : [], error: r.error };
}

export type StevoListParams = {
  serverUrl: string;
  apiKey: string;
  number: string;
  body: string;
  title?: string;
  footer?: string;
  /** Label do botão que abre a lista (ex: "Ver opções"). */
  buttonText: string;
  /** Seções com rows. Total de rows capado em 10 (excedente descartado). */
  sections: StevoListSection[];
  timeoutMs?: number;
};

/**
 * Envia uma mensagem de LISTA via Stevo (`/send/list`). O tap volta com
 * `singleSelectReply.selectedRowID` = o `rowId` que passamos. Capa o total em
 * 10 rows (across sections) e trunca títulos/descrições. NÃO lança.
 */
export async function sendStevoList(p: StevoListParams): Promise<StevoSendResult> {
  const base = (p.serverUrl || "").trim().replace(/\/+$/, "");
  const apiKey = (p.apiKey || "").trim();
  const number = normalizeStevoNumber(p.number);
  const timeoutMs = p.timeoutMs ?? 15_000;

  // Capa o total de rows em 10 ao longo das seções; trunca campos.
  let budget = MAX_LIST_ROWS;
  const sections = (p.sections || [])
    .map((sec) => {
      const rows = (sec.rows || []).slice(0, Math.max(0, budget)).map((row) => {
        const r: Record<string, unknown> = {
          rowId: row.rowId,
          title: truncate(row.title, ROW_TITLE_MAX),
        };
        if (row.description) r.description = truncate(row.description, ROW_DESC_MAX);
        return r;
      });
      budget -= rows.length;
      const out: Record<string, unknown> = { rows };
      if (sec.title) out.title = truncate(sec.title, ROW_TITLE_MAX);
      return out;
    })
    .filter((s) => (s.rows as unknown[]).length > 0);

  const totalRows = sections.reduce((n, s) => n + (s.rows as unknown[]).length, 0);

  if (!base || !apiKey || !number || !p.body?.trim() || !p.buttonText?.trim() || totalRows === 0) {
    return {
      ok: false,
      sent: 0,
      total: 1,
      ids: [],
      error: `params inválidos (base=${!!base} apiKey=${!!apiKey} number=${!!number} body=${!!p.body?.trim()} buttonText=${!!p.buttonText?.trim()} rows=${totalRows})`,
    };
  }

  const payload: Record<string, unknown> = {
    number,
    description: p.body.trim(),
    buttonText: truncate(p.buttonText, LIST_BTN_MAX),
    sections,
  };
  if (p.title) payload.title = truncate(p.title, HEADER_MAX);
  if (p.footer) payload.footerText = truncate(p.footer, HEADER_MAX);

  const r = await stevoPostJson(base, apiKey, "/send/list", payload, timeoutMs);
  return { ok: r.ok, sent: r.ok ? 1 : 0, total: 1, ids: r.id ? [r.id] : [], error: r.error };
}
