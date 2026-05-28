/**
 * Endpoint de smoke test do Sentry + ponte pra admin_signals.
 *
 * Pedro 2026-05-28: protegido pelo Basic Auth do middleware (matcher
 * /api/admin/:path*). Bater 1× via browser (`/api/admin/debug/sentry-test`)
 * ou curl (`curl -u admin:<ADMIN_PANEL_PASSWORD> https://.../api/admin/debug/sentry-test`)
 * e conferir que:
 *   1) o erro aparece no dashboard do Sentry com stack legível (source maps)
 *   2) o erro aparece em admin_signals (type='error', source='system') —
 *      via beforeSend → recordSignalAsync do sentry.server.config.ts
 *
 * REMOVER depois de validar (commit cleanup separado). Tem `dynamic =
 * "force-dynamic"` pra garantir que o build não tente prerender e disparar
 * o throw em tempo de build.
 */
export const dynamic = "force-dynamic";

export async function GET(): Promise<never> {
  throw new Error("Sentry+Signals smoke test 2026-05-28");
}
