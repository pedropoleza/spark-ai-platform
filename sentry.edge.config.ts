// Sentry — init do runtime Edge (middleware e rotas que rodam no edge).
// Mesma lógica do server config: sem DSN = NO-OP. Veja sentry.server.config.ts
// pra o racional de privacidade (sendDefaultPii=false).
import * as Sentry from "@sentry/nextjs";

Sentry.init({
  // Mesmo esquema do server: SENTRY_DSN server-only, fallback pro público.
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : 0.1,
  sendDefaultPii: false,
  debug: false,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
});
