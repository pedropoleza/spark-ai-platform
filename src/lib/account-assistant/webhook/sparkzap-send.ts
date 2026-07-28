/**
 * Envio das respostas do SparkBot pela engine própria (SparkZap), via Spark OS.
 * H57 — plano em `_planning/sparkzap-transporte/PLANO.md`.
 *
 * ESPELHA `stevo-send.ts` de propósito: mesmas funções (texto/botão/lista),
 * mesmo `StevoSendResult`, mesmo splitter `---` → múltiplas bolhas. Assim o
 * `stevo-handler` troca de transporte com um `if`, sem reescrever o fluxo (e o
 * rollback é uma env var).
 *
 * DIFERENÇA de arquitetura: aqui NÃO falamos com a engine direto. Falamos com a
 * ponte no Spark OS (`POST /api/integrations/wa/agent-send`, bearer por fonte),
 * que resolve a sessão e guarda o token do WhatsApp. Um control plane só — um
 * lugar só pra revogar, pausar ou trocar o número.
 *
 * IDEMPOTÊNCIA: cada bolha manda um `dedupe_key` derivado do id da mensagem que
 * originou o turno (+ índice da bolha). O handler roda em `waitUntil` e pode ser
 * reexecutado; sem a chave, o rep receberia a resposta duas vezes.
 */

import { splitResponseIntoMessages } from "./sparkbot-send";
import { sparkZapEndpoint } from "./wa-transport";
import type { StevoSendResult, StevoButton, StevoListSection } from "./stevo-send";

/** Gap client-side entre bolhas — garante ORDEM visual no WhatsApp. */
const INTER_BUBBLE_GAP_MS = 350;
const DEFAULT_TIMEOUT_MS = 20_000;

type SendKind = "text" | "buttons" | "list";

interface BridgeResponse {
  status?: string;
  wa_message_id?: string | null;
  error?: string;
}

interface BridgeOutcome {
  ok: boolean;
  id?: string;
  error?: string;
  /** true quando a ponte recusou o INTERATIVO (SparkZap ainda sem botão/lista). */
  unsupported?: boolean;
}

/**
 * POST na ponte. NÃO lança — devolve `{ok, id?, error?}` (mesmo contrato do
 * `stevoPostJson`), porque o chamador roda em background e precisa decidir o
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
    if (!res.ok) {
      return {
        ok: false,
        // 422 + status 'unsupported' = interativo desligado no SparkZap. É o
        // caminho ESPERADO enquanto botão/lista não estão homologados lá — o
        // chamador cai pro texto (que já traz as opções numeradas).
        unsupported: res.status === 422 && json.status === "unsupported",
        error:
          json.error ||
          `HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`,
      };
    }
    // 'duplicate' é sucesso: a mensagem JÁ saiu numa execução anterior.
    return { ok: true, id: json.wa_message_id || undefined };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg.includes("abort") ? `timeout após ${timeoutMs}ms` : msg };
  } finally {
    clearTimeout(timer);
  }
}

export type SparkZapTextParams = {
  /** Telefone destino (E.164 ou JID). */
  number: string;
  /** Texto da resposta (pode conter `---` pra virar múltiplas bolhas). */
  text: string;
  /** Base da chave de idempotência — normalmente o messageId do inbound. */
  dedupeKey?: string | null;
  timeoutMs?: number;
};

/**
 * Envia a resposta em texto. Aplica o MESMO splitter do Stevo/GHL (`---` →
 * múltiplas bolhas, cap 3), com gap entre bolhas. Nunca lança.
 */
export async function sendSparkZapText(p: SparkZapTextParams): Promise<StevoSendResult> {
  const number = (p.number || "").trim();
  if (!number) {
    return { ok: false, sent: 0, total: 0, ids: [], error: "número vazio" };
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
        to: number,
        kind: "text" satisfies SendKind,
        text: bubbles[i],
        ...(p.dedupeKey ? { dedupe_key: `${p.dedupeKey}:${i}` } : {}),
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
  number: string;
  body: string;
  title?: string;
  footer?: string;
  buttons: StevoButton[];
  dedupeKey?: string | null;
  timeoutMs?: number;
};

/**
 * Botões de resposta rápida. Enquanto o SparkZap não tiver interativo ligado, a
 * ponte devolve `unsupported` — o chamador cai pro texto. Isso é ESPERADO, não é
 * incidente (ver `interactiveUnsupported` no resultado).
 */
export async function sendSparkZapButton(
  p: SparkZapButtonParams,
): Promise<StevoSendResult & { unsupported?: boolean }> {
  const r = await bridgePost(
    {
      to: p.number,
      kind: "buttons" satisfies SendKind,
      text: p.body,
      ...(p.title ? { title: p.title } : {}),
      ...(p.footer ? { footer: p.footer } : {}),
      buttons: (p.buttons || []).map((b) => ({ id: b.id, label: b.label })),
      ...(p.dedupeKey ? { dedupe_key: `${p.dedupeKey}:btn` } : {}),
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
  number: string;
  body: string;
  title?: string;
  footer?: string;
  buttonText: string;
  sections: StevoListSection[];
  dedupeKey?: string | null;
  timeoutMs?: number;
};

/** Lista de opções. Achata as seções (o SparkBot só emite uma). */
export async function sendSparkZapList(
  p: SparkZapListParams,
): Promise<StevoSendResult & { unsupported?: boolean }> {
  const rows = (p.sections || []).flatMap((s) =>
    (s.rows || []).map((row) => ({
      row_id: row.rowId,
      title: row.title,
      ...(row.description ? { description: row.description } : {}),
    })),
  );
  const r = await bridgePost(
    {
      to: p.number,
      kind: "list" satisfies SendKind,
      text: p.body,
      ...(p.title ? { title: p.title } : {}),
      ...(p.footer ? { footer: p.footer } : {}),
      button_text: p.buttonText || "Ver opções",
      rows,
      ...(p.dedupeKey ? { dedupe_key: `${p.dedupeKey}:list` } : {}),
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
