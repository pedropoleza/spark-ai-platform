/**
 * Envio das respostas do SparkBot pela engine própria (SparkZap), via Spark OS.
 * H57 — plano em `_planning/sparkzap-transporte/PLANO.md`; contrato da porta em
 * `spark-os/_planning/WA_RICH_MESSAGES_GUIDE.md`.
 *
 * ESPELHA `stevo-send.ts` de propósito: mesmas funções (texto/botão/lista),
 * mesmo `StevoSendResult`, mesmo splitter `---` → múltiplas bolhas. Assim o
 * `stevo-handler` troca de transporte com um `if`, sem reescrever o fluxo (e o
 * rollback é uma env var).
 *
 * A PORTA é `POST /api/ingest/wa/send` do Spark OS (bearer da fonte 'sparkbot').
 * Ela NÃO fala com o engine direto: valida o payload (limites reais do
 * WhatsApp), ENFILEIRA no pacer do SparkZap (durabilidade + antiban + espelho)
 * e dispara o dreno na sequência — a mensagem sai em segundos. Resposta
 * `{ok:true, outboxId}` = ACEITA na fila; `{ok:true, duplicate:true}` = a mesma
 * `dedupeKey` já tinha entrado (sucesso — retry de lambda não duplica bolha).
 *
 * ⚠️ TRUNCAMOS labels AQUI (botão ≤20, row ≤24/72) porque o `rich.ts` do OS
 * REJEITA em vez de truncar — sem isso, um label de 22 chars viraria 422 e o
 * rep receberia o fallback de texto à toa.
 */

import { splitResponseIntoMessages } from "./sparkbot-send";
import { sparkZapEndpoint } from "./wa-transport";
import { smartRowTitle, type StevoSendResult, type StevoButton, type StevoListSection } from "./stevo-send";

/** Gap client-side entre bolhas — garante ORDEM visual no WhatsApp. */
const INTER_BUBBLE_GAP_MS = 350;
const DEFAULT_TIMEOUT_MS = 20_000;

// Limites do WhatsApp (mesmos do stevo-send/rich.ts do OS).
const BTN_LABEL_MAX = 20;
const ROW_TITLE_MAX = 24;
const ROW_DESC_MAX = 72;
const HEADER_MAX = 60;
const BODY_MAX = 1024;

/** Trunca por CODE POINT (não parte emoji/surrogate no meio). */
function truncate(s: string, n: number): string {
  const t = (s || "").trim();
  const cp = Array.from(t);
  return cp.length <= n ? t : `${cp.slice(0, n - 1).join("")}…`;
}

interface BridgeResponse {
  ok?: boolean;
  outboxId?: string;
  duplicate?: boolean;
  error?: string;
}

interface BridgeOutcome {
  ok: boolean;
  id?: string;
  error?: string;
  /** true no 422 (payload recusado pela validação do OS) — retentar IGUAL não
   *  resolve; o chamador troca pra texto. */
  unsupported?: boolean;
}

/**
 * POST na porta do OS. NÃO lança — devolve `{ok, id?, error?}` (mesmo contrato
 * do `stevoPostJson`), porque o chamador roda em background e precisa decidir o
 * fallback em vez de explodir.
 */
async function bridgePost(
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<BridgeOutcome> {
  const cfg = sparkZapEndpoint();
  if (!cfg) {
    return { ok: false, error: "SPARK_OS_WA_URL/SPARK_OS_WA_TOKEN não configurados" };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.token}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text().catch(() => "");
    let json: BridgeResponse = {};
    try {
      json = text ? (JSON.parse(text) as BridgeResponse) : {};
    } catch {
      /* corpo não-JSON */
    }
    if (!res.ok || json.ok === false) {
      return {
        ok: false,
        unsupported: res.status === 422,
        error:
          json.error ||
          `HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      };
    }
    // ACEITA na fila (outboxId) ou duplicate (já tinha entrado) — os dois são
    // sucesso do ponto de vista do bot.
    return { ok: true, id: json.outboxId || undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.includes("abort") ? `timeout após ${timeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

export type SparkZapTextParams = {
  /** Location (hub) dona do número do SparkBot no SparkZap. */
  locationId: string;
  /** Telefone destino (E.164). */
  number: string;
  /** Texto da resposta (pode conter `---` pra virar múltiplas bolhas). */
  text: string;
  /** Base da chave de idempotência — normalmente o messageId do inbound. */
  dedupeKey?: string | null;
  /** 1 = resposta a rep esperando (default) · 3 = proativo. */
  priority?: number;
  timeoutMs?: number;
};

/**
 * Envia a resposta em texto. Aplica o MESMO splitter do Stevo/GHL (`---` →
 * múltiplas bolhas, cap), com gap entre bolhas. Nunca lança.
 */
export async function sendSparkZapText(p: SparkZapTextParams): Promise<StevoSendResult> {
  const number = (p.number || "").trim();
  if (!number || !p.locationId) {
    return { ok: false, sent: 0, total: 0, ids: [], error: "número/locationId vazio" };
  }
  const bubbles = splitResponseIntoMessages(p.text);
  if (bubbles.length === 0) {
    return { ok: false, sent: 0, total: 0, ids: [], error: "texto vazio — nada a enviar" };
  }

  const ids: string[] = [];
  let sent = 0;
  let firstError: string | undefined;

  for (let i = 0; i < bubbles.length; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, INTER_BUBBLE_GAP_MS));
    const r = await bridgePost(
      {
        locationId: p.locationId,
        to: number,
        kind: "text",
        text: bubbles[i],
        priority: p.priority ?? 1,
        ...(p.dedupeKey ? { dedupeKey: `${p.dedupeKey}:${i}` } : {}),
      },
      p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    if (r.ok) {
      sent++;
      if (r.id) ids.push(r.id);
    } else {
      firstError = r.error;
      // Mesma política do Stevo: falhou uma bolha, para (evita resposta pela
      // metade duplicada num retry).
      console.warn(`[sparkzap-send] bolha ${i + 1}/${bubbles.length} falhou: ${r.error}`);
      break;
    }
  }

  return { ok: sent === bubbles.length, sent, total: bubbles.length, ids, error: firstError };
}

export type SparkZapButtonParams = {
  locationId: string;
  number: string;
  body: string;
  title?: string;
  footer?: string;
  buttons: StevoButton[];
  dedupeKey?: string | null;
  timeoutMs?: number;
};

/**
 * Botões de resposta rápida (cap 3, labels truncados a 20). O clique volta pelo
 * webhook com o `id` daqui (selectedButtonID) — o parser já lê os dois formatos.
 * Se o OS recusar o payload (422), devolve `unsupported` e o chamador cai pro
 * texto com opções numeradas.
 */
export async function sendSparkZapButton(
  p: SparkZapButtonParams,
): Promise<StevoSendResult & { unsupported?: boolean }> {
  const r = await bridgePost(
    {
      locationId: p.locationId,
      to: p.number,
      kind: "buttons",
      priority: 1,
      payload: {
        body: truncate(p.body, BODY_MAX),
        ...(p.title ? { title: truncate(p.title, HEADER_MAX) } : {}),
        ...(p.footer ? { footer: truncate(p.footer, HEADER_MAX) } : {}),
        buttons: (p.buttons || []).slice(0, 3).map((b) => ({
          title: truncate(b.label, BTN_LABEL_MAX),
          id: b.id,
        })),
      },
      ...(p.dedupeKey ? { dedupeKey: `${p.dedupeKey}:btn` } : {}),
    },
    p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return {
    ok: r.ok,
    sent: r.ok ? 1 : 0,
    total: 1,
    ids: r.id ? [r.id] : [],
    error: r.error,
    unsupported: r.unsupported,
  };
}

export type SparkZapListParams = {
  locationId: string;
  number: string;
  body: string;
  title?: string;
  footer?: string;
  buttonText: string;
  sections: StevoListSection[];
  dedupeKey?: string | null;
  timeoutMs?: number;
};

/**
 * Lista de opções (cap 10 rows no total; títulos com o truncamento INTELIGENTE
 * do H47-F2 — preserva o último sobrenome de homônimos). `rowId` volta no tap.
 */
export async function sendSparkZapList(
  p: SparkZapListParams,
): Promise<StevoSendResult & { unsupported?: boolean }> {
  let budget = 10;
  const sections = (p.sections || [])
    .map((s) => {
      const rows = (s.rows || []).slice(0, Math.max(0, budget)).map((row) => ({
        title: smartRowTitle(row.title, ROW_TITLE_MAX),
        ...(row.description ? { description: truncate(row.description, ROW_DESC_MAX) } : {}),
        rowId: row.rowId,
      }));
      budget -= rows.length;
      return {
        ...(s.title ? { title: truncate(s.title, ROW_TITLE_MAX) } : {}),
        rows,
      };
    })
    .filter((s) => s.rows.length > 0);

  const r = await bridgePost(
    {
      locationId: p.locationId,
      to: p.number,
      kind: "list",
      priority: 1,
      payload: {
        body: truncate(p.body, BODY_MAX),
        buttonText: truncate(p.buttonText || "Ver opções", BTN_LABEL_MAX),
        ...(p.title ? { title: truncate(p.title, HEADER_MAX) } : {}),
        ...(p.footer ? { footer: truncate(p.footer, HEADER_MAX) } : {}),
        sections,
      },
      ...(p.dedupeKey ? { dedupeKey: `${p.dedupeKey}:list` } : {}),
    },
    p.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );
  return {
    ok: r.ok,
    sent: r.ok ? 1 : 0,
    total: 1,
    ids: r.id ? [r.id] : [],
    error: r.error,
    unsupported: r.unsupported,
  };
}
