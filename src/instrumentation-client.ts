// Sentry — init do lado do cliente (a UI do /hub no browser). O Next executa
// este arquivo automaticamente no client. Sem DSN = NO-OP, então não muda nada
// até o Sentry estar configurado no Vercel.
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.NEXT_PUBLIC_SENTRY_TRACES_SAMPLE_RATE)
    : 0.1,
  // Session Replay desligado de propósito: pesa no bundle e come quota do free
  // tier. Foco é captura de erro, não gravação de sessão. Liga depois se precisar.
  replaysSessionSampleRate: 0,
  replaysOnErrorSampleRate: 0,
  sendDefaultPii: false,
  debug: false,
  // VERCEL_ENV não é exposto ao browser por padrão; NODE_ENV é (Next injeta no
  // bundle) e já vira "production" em build de prod. Fallback cobre o caso comum.
  environment:
    process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "development",
});

// Instrumenta navegação client-side (App Router) — exigido pelo SDK v9+.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
