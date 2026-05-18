import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * Pedro 2026-05-17: rota legada — redireciona pro novo dashboard
 * com a tab signals ativa. Mantém bookmarks antigos funcionando.
 *
 * /admin/signals       → /admin/dashboard?tab=signals
 * /admin/signals?...   → /admin/dashboard?tab=signals (descarta outros params)
 */
export default function AdminSignalsLegacyPage() {
  redirect("/admin/dashboard?tab=signals");
}
