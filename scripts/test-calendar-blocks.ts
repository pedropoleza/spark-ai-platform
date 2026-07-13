/**
 * Smoke REAL do calendar-context (H48, 2026-07-10): fetchCalendarBlocks contra o
 * GHL de prod (read-only), janela = hoje + 7 dias, rep com Google sync ativo.
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-calendar-blocks.ts [phone]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { fetchCalendarBlocks, isBlockedSlotsEnabled } from "../src/lib/account-assistant/calendar-context";

const PHONE = process.argv[2] || "+16892033343"; // Jussara (20 blocks no probe de 10/07)

async function main() {
  console.log("flag ligada?", isBlockedSlotsEnabled());
  const supabase = createAdminClient();
  const { data: rep } = await supabase
    .from("rep_identities")
    .select("id, display_name, active_location_id, ghl_users")
    .eq("phone", PHONE)
    .maybeSingle();
  if (!rep) throw new Error("rep não encontrado: " + PHONE);
  const locId = rep.active_location_id as string;
  const ghlUser = (rep.ghl_users as Array<{ location_id: string; ghl_user_id: string }>).find(
    (u) => u.location_id === locId,
  );
  if (!ghlUser) throw new Error("rep sem ghl_user na location ativa");
  const { data: loc } = await supabase
    .from("locations").select("company_id").eq("location_id", locId).maybeSingle();
  if (!loc?.company_id) throw new Error("location sem company_id");

  const ghl = new GHLClient(loc.company_id, locId);
  const now = Date.now();
  const blocks = await fetchCalendarBlocks(ghl, {
    locationId: locId,
    userId: ghlUser.ghl_user_id,
    startMs: now,
    endMs: now + 7 * 24 * 60 * 60 * 1000,
  });

  console.log(`→ ${rep.display_name}: ${blocks.length} bloco(s) nos próximos 7 dias`);
  for (const b of blocks.slice(0, 8)) {
    console.log(`  • ${b.start_iso} — "${b.title}" [${b.source}]`);
  }
  if (blocks.length === 0) console.log("  (zero blocos — ok se o rep não tem Google sync/eventos)");
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
