import { SignalsClient } from "./signals-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "SparkBot Admin · Signals" };

/**
 * Pedro 2026-05-04: painel admin pra rastrear signals do SparkBot.
 *
 * Auth via middleware Basic Auth (env ADMIN_PANEL_PASSWORD).
 * URL secreta — só Pedro tem.
 *
 * Mostra:
 *   - Failures (bot tentou e travou)
 *   - Missed capabilities (rep pediu, bot não tem)
 *   - Errors (técnicos recorrentes)
 *   - Ideas (manual via form)
 *
 * Tudo agrupado por fingerprint (occurrence_count++ pra repetidos),
 * ordenado por count desc. Permite triage: status, severity, notes.
 */
export default function AdminSignalsPage() {
  return <SignalsClient />;
}
