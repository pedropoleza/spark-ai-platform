/**
 * Helper pra tagear erros do Sentry por feature (Pedro 2026-05-28).
 *
 * Antes: todo erro vinha "system" sem distinção de runner. Agora cada runner
 * é wrapped numa scope com tag `feature=<name>` — filtros do Sentry ficam
 * úteis ("mostrar só erros do bulk-runner").
 *
 * Uso:
 *   await withFeatureTag("sequence-runner", () => processSequenceSteps());
 *
 * Funciona mesmo sem Sentry (NEXT_PUBLIC_SENTRY_DSN não setado): apenas chama
 * fn() direto sem overhead.
 */

export async function withFeatureTag<T>(
  feature: string,
  fn: () => Promise<T>,
): Promise<T> {
  // Sentry no Vercel é tree-shaken se DSN ausente — import dinâmico não custa.
  try {
    const Sentry = await import("@sentry/nextjs").catch(() => null);
    if (Sentry && process.env.NEXT_PUBLIC_SENTRY_DSN) {
      return await Sentry.withScope(async (scope) => {
        scope.setTag("feature", feature);
        scope.setContext("runner", { name: feature, ts: new Date().toISOString() });
        return fn();
      });
    }
  } catch {
    // Não-fatal: segue sem tag se Sentry indisponível
  }
  return fn();
}
