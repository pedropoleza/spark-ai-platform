import { DashboardClient } from "./dashboard-client";

export const dynamic = "force-dynamic";
export const metadata = { title: "SparkBot Admin · Dashboard" };

/**
 * Pedro 2026-05-17: dashboard agregado (renomeado de /admin/signals).
 *
 * 6 tabs:
 *   - Overview: KPIs + alerts + sparklines
 *   - Billing: revenue/cost por dia + top spenders + pending charges
 *   - Features: top tools usadas + adoption (Bulk, Filter Engine, Proactive)
 *   - Bulk: jobs ativos + runner health + completed
 *   - Reps: lista paginada com filtros
 *   - Signals: lista atual (reusa SignalsClient)
 *
 * URL legada /admin/signals redireciona pra cá com tab=signals.
 */
export default function AdminDashboardPage() {
  return <DashboardClient />;
}
