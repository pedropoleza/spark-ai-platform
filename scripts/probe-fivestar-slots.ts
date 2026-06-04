/**
 * F48 probe: busca os free-slots REAIS do calendário da Five Star Ricos +
 * config do calendário (slot duration, open hours). Pra comparar com o que a
 * IA ofereceu ("11:30 AM ou 12:00 PM") e decidir se é prompt ou sistema.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/probe-fivestar-slots.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const CALENDAR_ID = "14aj8DKXZnaj8GRMdmDy";
const TZ = "America/New_York";

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  // Config do calendário
  try {
    const cal = await client.get<{ calendar?: Record<string, unknown> }>(`/calendars/${CALENDAR_ID}`);
    const c = cal.calendar || {};
    console.log("=== CALENDAR CONFIG ===");
    console.log("name:", c.name);
    console.log("slotDuration:", c.slotDuration, c.slotDurationUnit ?? "");
    console.log("slotInterval:", c.slotInterval, c.slotIntervalUnit ?? "");
    console.log("openHours:", JSON.stringify(c.openHours)?.slice(0, 600));
  } catch (e) {
    console.log("calendar config falhou:", e instanceof Error ? e.message : e);
  }

  // Free-slots próximos 7 dias
  const now = Date.now();
  const slots = await client.get<Record<string, unknown>>(
    `/calendars/${CALENDAR_ID}/free-slots`,
    { startDate: String(now), endDate: String(now + 7 * 864e5) },
  );
  console.log("\n=== FREE-SLOTS (raw keys) ===");
  for (const [key, value] of Object.entries(slots)) {
    if (key === "traceId") continue;
    let arr: string[] = [];
    if (value && typeof value === "object") {
      const v = value as Record<string, unknown>;
      if (Array.isArray(v.slots)) arr = v.slots as string[];
      else if (Array.isArray(value)) arr = value as string[];
    }
    if (!arr.length) continue;
    const times = arr.map((s) => new Date(s).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: TZ }));
    console.log(`${key}: ${times.join(", ")}`);
  }
  console.log("\nnow:", new Date(now).toLocaleString("en-US", { timeZone: TZ }), "(ET)");
  process.exit(0);
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
