// Probe scopes — testa múltiplos endpoints pra mapear quais scopes
// o app instalado tem na location dF2FDDZzSv715e1av4gr.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

const LOC = "dF2FDDZzSv715e1av4gr";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

const tests: Array<{
  scope: string;
  method: "get" | "post";
  path: string;
  query?: Record<string, string>;
}> = [
  { scope: "contacts.readonly", method: "get", path: "/contacts/", query: { locationId: LOC, limit: "1" } },
  { scope: "contacts/notes.readonly", method: "get", path: "/contacts/ErpM2X8vR1U4IrRTZnKX/notes/" },
  { scope: "contacts/tasks.readonly", method: "get", path: "/contacts/ErpM2X8vR1U4IrRTZnKX/tasks/" },
  { scope: "opportunities.readonly", method: "get", path: "/opportunities/search", query: { location_id: LOC, limit: "1" } },
  { scope: "calendars.readonly", method: "get", path: "/calendars/", query: { locationId: LOC } },
  { scope: "conversations.readonly", method: "get", path: "/conversations/search", query: { locationId: LOC, limit: "1" } },
  { scope: "locations/customFields.readonly", method: "get", path: `/locations/${LOC}/customFields` },
  { scope: "locations/tags.readonly", method: "get", path: `/locations/${LOC}/tags` },
  { scope: "users.readonly", method: "get", path: "/users/", query: { locationId: LOC } },
  { scope: "businesses.readonly", method: "get", path: `/businesses/`, query: { locationId: LOC } },
];

async function main() {
  const client = new GHLClient(COMPANY, LOC);
  console.log(`\n=== Scope probe: ${LOC} ===\n`);
  console.log("Scope".padEnd(38), "Status");
  console.log("-".repeat(60));

  for (const t of tests) {
    try {
      if (t.method === "get") {
        await client.get(t.path, t.query);
      }
      console.log(t.scope.padEnd(38), "✅ OK");
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const short = msg.includes("403")
        ? "❌ 403 SEM SCOPE"
        : msg.includes("404")
          ? "⚠️  404 (endpoint não existe ou ID inválido)"
          : msg.includes("401")
            ? "❌ 401 unauthorized"
            : msg.includes("400")
              ? "⚠️  400 (request inválido — mas scope provavelmente OK)"
              : `❌ ${msg.slice(0, 30)}`;
      console.log(t.scope.padEnd(38), short);
    }
  }
}

main();
