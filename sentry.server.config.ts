// Sentry — init do lado do servidor (rotas /api, webhook-handler, crons).
//
// Sem DSN configurado (env ausente) o Sentry.init vira NO-OP: o build e o runtime
// seguem idênticos ao de antes. Só passa a reportar quando NEXT_PUBLIC_SENTRY_DSN
// estiver setado no Vercel. Isso mantém o deploy atual sem risco até o Pedro criar
// a conta e colar o DSN.
//
// Privacidade (decisão Pedro 2026-05-27): sendDefaultPii=false de propósito. É um
// CRM — não queremos vazar telefone/nome de rep ou lead pro Sentry. Sem isso o SDK
// anexaria IP, cookies, headers e corpo da request nos eventos.
import * as Sentry from "@sentry/nextjs";
import { recordSignal } from "@/lib/admin-signals/recorder";
import { waitUntil } from "@vercel/functions";

// Ponte Sentry → Signals (Pedro 2026-05-27): espelha crashes server-side no painel
// admin_signals do hub (type 'error', source 'system') pra ter UMA janela de erro.
// Kill switch: SENTRY_SIGNALS_BRIDGE=0. Só nodejs (o edge não roda o admin client).
// Só em produção: crash de dev local não deve poluir o painel (que aponta pro DB
// de prod). O Sentry em si ainda captura dev/preview (filtra pela tag environment).
const signalsBridgeEnabled =
  process.env.SENTRY_SIGNALS_BRIDGE !== "0" &&
  process.env.SENTRY_SIGNALS_BRIDGE !== "false" &&
  process.env.VERCEL_ENV === "production";

Sentry.init({
  // Prefere SENTRY_DSN (server-only, não vaza pro bundle); cai pro público se só
  // ele estiver setado. Assim basta NEXT_PUBLIC_SENTRY_DSN no Vercel pra rodar em tudo.
  dsn: process.env.SENTRY_DSN ?? process.env.NEXT_PUBLIC_SENTRY_DSN,
  // Tracing leve — erros são a prioridade; tracing consome quota do free tier.
  // Ajustável via env sem rebuild de código.
  tracesSampleRate: process.env.SENTRY_TRACES_SAMPLE_RATE
    ? Number(process.env.SENTRY_TRACES_SAMPLE_RATE)
    : 0.1,
  sendDefaultPii: false,
  debug: false,
  environment: process.env.VERCEL_ENV || process.env.NODE_ENV || "development",
  beforeSend(event, hint) {
    // Espelha no painel de Signals (best-effort; NUNCA lança — senão perderia o
    // evento no Sentry). Título sem PII (tipo do erro + rota) pra o dedup do
    // recorder agrupar crashes iguais. A message (pode ter PII) vai só na
    // description, que fica no painel interno admin-only.
    //
    // waitUntil (smoke test 2026-05-28): no smoke test descobrimos que 2 hits
    // viraram 1 row porque o lambda encerrava antes da promise async resolver
    // (fire-and-forget é frágil em serverless). waitUntil estende o lifetime do
    // invocation até o INSERT/UPDATE no admin_signals completar — count agora
    // bate com o do Sentry.
    if (signalsBridgeEnabled) {
      try {
        const err = hint?.originalException;
        const errorName =
          err instanceof Error ? err.name : event.exception?.values?.[0]?.type || "Error";
        const route = event.transaction || "rota desconhecida";
        waitUntil(
          recordSignal({
            type: "error",
            source: "system",
            severity: "high",
            title: `${errorName} em ${route}`,
            description: err instanceof Error ? err.message?.slice(0, 500) : undefined,
            metadata: {
              sentry_event_id: event.event_id,
              environment: event.environment,
            },
          }).catch((bridgeErr) => {
            // Falha de escrita no Signals não pode quebrar nada. Só loga.
            console.warn("[sentry-signals-bridge] recordSignal falhou:", bridgeErr);
          }),
        );
      } catch {
        // no-op proposital: a ponte nunca pode atrapalhar o envio pro Sentry.
      }
    }
    return event;
  },
});
