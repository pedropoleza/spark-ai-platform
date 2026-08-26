// READ-ONLY — mede a agenda da Bianca (1:1 com Bianca Amorim) em 7/14/30 dias
// pra calibrar slot_window_days (H80). Mesmo racional do _diag-marina-slots.
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "cRavIlyC52vFYgJATgi7";
const CAL = process.argv[2] || "7esidBgOQphCRLUt4YaL";

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { GHLClient } = await import("@/lib/ghl/client");
  const { formatAvailableSlots } = await import("@/lib/ai/slots-format");
  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id, timezone").eq("location_id", LOC).single();
  if (!loc) throw new Error("location não cadastrada");
  const c = new GHLClient(loc.company_id, LOC);
  console.log(`calendário ${CAL} | tz da conta: ${loc.timezone}\n`);

  for (const dias of [7, 14, 21, 30]) {
    const now = Date.now();
    try {
      const r = await c.get<Record<string, unknown>>(`/calendars/${CAL}/free-slots`, {
        startDate: String(now),
        endDate: String(now + dias * 24 * 60 * 60 * 1000),
        timezone: loc.timezone || "America/New_York",
      });
      const dates = Object.keys(r).filter((k) => /^\d{4}-\d{2}-\d{2}$/.test(k));
      let total = 0;
      for (const d of dates) {
        const slots = (r[d] as { slots?: string[] })?.slots || [];
        total += slots.length;
      }
      const fmt = formatAvailableSlots(r, loc.timezone || "America/New_York");
      console.log(`─── ${dias}d: ${dates.length} dia(s), ${total} horário(s) ───`);
      console.log(fmt ? fmt.split("\n").slice(0, 12).join("\n") : "  (nenhum)");
      console.log();
    } catch (e) {
      console.log(`─── ${dias}d: ERRO ${e instanceof Error ? e.message : e}\n`);
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
