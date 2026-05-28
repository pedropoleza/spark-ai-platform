// Next.js instrumentation hook (estável no Next 15). Carrega o init do Sentry
// no runtime certo. Os configs na raiz são NO-OP sem DSN, então isto é inerte
// até o Pedro configurar o Sentry no Vercel.
import * as Sentry from "@sentry/nextjs";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

// Captura exceptions lançadas dentro de React Server Components e rotas do
// App Router (Next 15 chama isto automaticamente em erro de request).
export const onRequestError = Sentry.captureRequestError;
