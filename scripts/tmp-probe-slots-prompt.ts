/**
 * TEMP (read-only): replica EXATAMENTE a chamada de free-slots do queue-processor
 * (linhas 662-696: sem param `timezone`, janela de 7 dias em epoch ms) e mostra o
 * texto final que o modelo veria via formatAvailableSlots.
 *   npx tsx -r tsconfig-paths/register scripts/tmp-probe-slots-prompt.ts
 */
import { config } from "dotenv";
config({ path: "/Users/pedropoleza/SPARK APPS/AI platform/.env.local" });
import { GHLClient } from "@/lib/ghl/client";
import { formatAvailableSlots } from "@/lib/ai/slots-format";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const LOCATION = "pGl5pqLLG0QDixANpFnP";
const CAL = "sOJghdK2aalf23Cmizgh";

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  const now = new Date();
  const startDate = String(now.getTime());
  const endDate = String(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  console.log("=== CHAMADA IDÊNTICA À DE PROD (sem timezone) ===");
  const raw = await client.get<Record<string, unknown>>(`/calendars/${CAL}/free-slots`, {
    startDate,
    endDate,
  });
  console.log("keys:", Object.keys(raw).join(", "));
  console.log("raw (primeiros 1200 chars):", JSON.stringify(raw).slice(0, 1200));

  const tz = "America/New_York";
  const formatted = formatAvailableSlots(raw, tz);
  console.log("\n=== TEXTO QUE O MODELO VÊ (formatAvailableSlots, tz=America/New_York) ===");
  console.log(formatted || "(VAZIO)");
  console.log("\nlinhas:", formatted ? formatted.split("\n").length : 0);

  console.log("\n=== MESMA CHAMADA COM timezone=America/New_York (pra comparar) ===");
  const raw2 = await client.get<Record<string, unknown>>(`/calendars/${CAL}/free-slots`, {
    startDate,
    endDate,
    timezone: tz,
  });
  console.log("keys:", Object.keys(raw2).join(", "));
  const formatted2 = formatAvailableSlots(raw2, tz);
  console.log(formatted2 || "(VAZIO)");
  process.exit(0);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
