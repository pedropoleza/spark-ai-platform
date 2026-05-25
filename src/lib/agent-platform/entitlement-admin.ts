/**
 * Helpers do admin de entitlements (Fase G). Fora dos route handlers porque
 * route.ts só pode exportar GET/POST/etc. (Next.js valida o shape).
 */
import { createAdminClient } from "@/lib/supabase/admin";
import type { AgentCapability } from "@/types/agent-platform";

/** Capacidade da UI ("sales"|"recruitment"|"custom") → AgentCapability do DB. */
export function toCapability(k: string): AgentCapability | null {
  if (k === "sales") return "sales_agent";
  if (k === "recruitment") return "recruitment_agent";
  if (k === "custom") return "custom_agent";
  return null;
}

/** Confere que a location existe E pertence à company do admin (anti-IDOR). */
export async function assertLocationInCompany(locationId: string, companyId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase.from("locations").select("company_id").eq("location_id", locationId).maybeSingle();
  return !!data && data.company_id === companyId;
}
