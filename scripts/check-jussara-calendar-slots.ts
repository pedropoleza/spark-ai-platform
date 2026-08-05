/**
 * Read-only: confirma que o calendário "Consulta Inicial" da Jussara tem horários
 * livres bookáveis nos próximos 14 dias (senão o agente convida mas não marca).
 *   npx tsx -r tsconfig-paths/register scripts/check-jussara-calendar-slots.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "pGl5pqLLG0QDixANpFnP";
const CAL = "sOJghdK2aalf23Cmizgh"; // Consulta Inicial

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  const now = Date.now();
  const start = now;
  const end = now + 14 * 24 * 60 * 60 * 1000;
  // GHL free-slots: epoch ms em startDate/endDate
  const data = await client.get<Record<string, unknown>>(`/calendars/${CAL}/free-slots`, {
    startDate: String(start),
    endDate: String(end),
    timezone: "America/New_York",
  });
  // a resposta é um objeto com chaves por dia { "2026-06-23": { slots: [...] }, ... } + _dates_
  let totalSlots = 0;
  const dias: string[] = [];
  for (const [k, v] of Object.entries(data)) {
    if (k.startsWith("_")) continue;
    const slots = (v as { slots?: unknown[] })?.slots;
    if (Array.isArray(slots) && slots.length > 0) {
      totalSlots += slots.length;
      dias.push(`${k}:${slots.length}`);
    }
  }
  console.log(`Calendário Consulta Inicial — próximos 14 dias: ${totalSlots} horários livres em ${dias.length} dia(s).`);
  if (dias.length) console.log("  " + dias.slice(0, 8).join("  "));
  console.log(totalSlots > 0 ? "✅ BOOKÁVEL" : "⚠️ ZERO horários livres — agente não vai conseguir marcar (revisar disponibilidade no Spark Leads).");
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
