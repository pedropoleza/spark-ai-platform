import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {};

// Sentry só engata quando NEXT_PUBLIC_SENTRY_DSN está setado (env do Vercel).
// Sem DSN o build segue IDÊNTICO ao de antes — zero risco enquanto a conta/DSN
// não existem. Source maps só sobem quando SENTRY_AUTH_TOKEN também estiver
// presente; sem token o plugin apenas pula o upload (não quebra o build).
const sentryDisabled = !process.env.NEXT_PUBLIC_SENTRY_DSN;

export default sentryDisabled
  ? nextConfig
  : withSentryConfig(nextConfig, {
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      silent: !process.env.CI,
      widenClientFileUpload: true,
      // Proxy /monitoring pra eventos do browser não serem bloqueados por ad-blockers
      // (uBlock etc. bloqueiam sentry.io). Seguro: o middleware só intercepta /admin/*,
      // então essa rota não passa pela auth.
      tunnelRoute: "/monitoring",
      // API nova v10: tree-shake o logger de debug do Sentry (bundle menor).
      // Substitui disableLogger (deprecado). automaticVercelMonitors já é false
      // por padrão (usamos pg_cron, não Vercel Cron) — não precisa setar.
      webpack: {
        treeshake: {
          removeDebugLogging: true,
        },
      },
    });
