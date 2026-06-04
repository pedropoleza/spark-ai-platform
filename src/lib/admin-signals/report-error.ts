/**
 * reportError (F49, Pedro 2026-06-04): ponto ÚNICO pra tornar QUALQUER falha
 * identificável sem ter que ler log na mão.
 *
 * Faz as duas coisas de uma vez:
 *   1. admin_signal (type 'error') → aparece no /hub/admin/health, deduplicado
 *      por fingerprint(type + title). Por isso o TITLE tem que ser ESTÁVEL
 *      (categoria), não conter a mensagem de erro variável — senão cada erro
 *      vira uma row nova e não clusteriza. O detalhe vai em description/metadata.
 *   2. Sentry.captureException (com tag feature + contexto) — tree-shaken se
 *      NEXT_PUBLIC_SENTRY_DSN ausente, então é no-op fora de prod.
 *
 * Fire-and-forget: nunca lança (um erro no reporter não pode derrubar o caller).
 *
 * Caso histórico que motivou: "Bora começar" do Sieder (2026-06-04) — o handler
 * do inbound lançou no background (waitUntil) e o `.catch` só fazia console.error
 * → o bot ficou mudo e ninguém soube até o rep reclamar.
 */
import { recordSignalAsync, type SignalSeverity } from "./recorder";

export interface ReportErrorInput {
  /** Categoria ESTÁVEL do erro (vira o title do signal — sem msg variável). */
  title: string;
  /** O erro capturado (Error ou qualquer coisa). Vai pro Sentry + metadata. */
  error?: unknown;
  /** Tag de feature pro Sentry + metadata (ex: "sparkbot-inbound", "followup-runner"). */
  feature?: string;
  /** Severidade do signal. Default 'high'. */
  severity?: SignalSeverity;
  /** Descrição extra (além da msg do erro). */
  description?: string;
  /** Contexto pra debug (rep_id, contact_id, location_id, message preview, etc). */
  metadata?: Record<string, unknown>;
}

function errorMessage(error: unknown): string | undefined {
  if (!error) return undefined;
  if (error instanceof Error) return error.message;
  return String(error);
}

export function reportError(input: ReportErrorInput): void {
  const errMsg = errorMessage(input.error);

  // 1. admin_signal (deduplicado, painel /hub/admin/health)
  recordSignalAsync({
    type: "error",
    title: input.title,
    description: input.description || errMsg || input.title,
    severity: input.severity || "high",
    source: "bot_auto",
    metadata: {
      ...(input.feature ? { feature: input.feature } : {}),
      ...(errMsg ? { error: errMsg.slice(0, 600) } : {}),
      ...(input.error instanceof Error && input.error.stack
        ? { stack: input.error.stack.slice(0, 1500) }
        : {}),
      ...input.metadata,
    },
  });

  // 2. Sentry (só se DSN configurado — no-op caso contrário)
  if (input.error !== undefined) {
    void captureToSentry(input.error, input.feature, { title: input.title, ...input.metadata });
  }
}

async function captureToSentry(
  error: unknown,
  feature: string | undefined,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    const Sentry = await import("@sentry/nextjs").catch(() => null);
    if (!Sentry || !process.env.NEXT_PUBLIC_SENTRY_DSN) return;
    Sentry.withScope((scope) => {
      if (feature) scope.setTag("feature", feature);
      scope.setContext("detail", context);
      Sentry.captureException(error instanceof Error ? error : new Error(String(error)));
    });
  } catch {
    // Não-fatal: o signal já garante a visibilidade mesmo sem Sentry.
  }
}
