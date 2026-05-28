import { withSentryConfig } from "@sentry/nextjs";

/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cutover PM-F3.I (Pedro 2026-05-28): /dashboard → /hub.
  // Redirects 308 (permanent) pras 4 rotas legacy. permanent=false dá 307
  // (temp) — escolhemos permanent=true porque a decisão é manter /hub como
  // canônico, mas reverter é trivial (deletar essas entries + redeploy).
  // Mantemos arquivos em src/app/dashboard/* por enquanto pra fallback
  // emergencial (rollback de 1 commit).
  async redirects() {
    return [
      { source: "/dashboard", destination: "/hub", permanent: true },
      { source: "/dashboard/settings", destination: "/hub/settings", permanent: true },
      { source: "/dashboard/billing", destination: "/hub/billing", permanent: true },
      // activity legacy → messages (equivalente conceitual no /hub).
      { source: "/dashboard/activity", destination: "/hub/messages", permanent: true },
      // Pedro 2026-05-28 cleanup: /agents legacy redirecionam pra /hub/agents.
      // Views específicas por type (/agents/sales etc) eram da época pre-modular;
      // hoje a config é por agent_id (/hub/agents/<id>), então redirect cai no listing.
      { source: "/agents", destination: "/hub/agents", permanent: true },
      { source: "/agents/sales", destination: "/hub/agents", permanent: true },
      { source: "/agents/recruitment", destination: "/hub/agents", permanent: true },
      { source: "/agents/account-assistant", destination: "/hub/agents", permanent: true },
      { source: "/agents/new", destination: "/hub/agents/new", permanent: true },
    ];
  },
};

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
