/**
 * Diagnóstico READ-ONLY (Pedro 2026-06-17): SparkBot desconectou de manhã e
 * ficaram conversas pendentes. Os inbounds não chegaram ao nosso DB (Stevo
 * inbound caiu) — então olha a fonte externa:
 *   1. Estado da conexão Stevo (conectado agora?).
 *   2. Conversas do hub no GHL onde o ÚLTIMO turno é INBOUND (rep falou, sem
 *      resposta = PENDENTE). Se o último é outbound = já retomada → ignora.
 * NÃO envia nada. Só lista.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/diag-sparkbot-pending.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const HUB = "RBFxlEQZobaDjlF2i5px";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

async function main() {
  const supabase = createAdminClient();

  // 1. Estado da conexão Stevo (só server_url + token, sem GHL).
  const { data: inst } = await supabase
    .from("stevo_instances")
    .select("server_url, instance_name, instance_token")
    .eq("hub_location_id", HUB)
    .maybeSingle();
  if (inst) {
    try {
      const r = await fetch(`${inst.server_url}/instance/connectionState/${inst.instance_name}`, {
        headers: { apikey: inst.instance_token },
      });
      const j = await r.json().catch(() => ({}));
      console.log("STEVO connectionState:", r.status, JSON.stringify(j));
    } catch (e) {
      console.log("STEVO check erro:", e instanceof Error ? e.message : e);
    }
  } else {
    console.log("Sem stevo_instance pro hub.");
  }

  // 2. Conversas do hub no GHL — último turno = inbound (pendente).
  const client = new GHLClient(COMPANY, HUB);
  try {
    const res = await client.get<{ conversations?: Array<Record<string, unknown>> }>(
      "/conversations/search",
      { locationId: HUB, sortBy: "last_message_date", sort: "desc", limit: "50" },
    );
    const convs = res.conversations || [];
    console.log(`\nGHL: ${convs.length} conversas retornadas (top por última msg).`);

    const pending = convs.filter((c) => String(c.lastMessageDirection || "").toLowerCase() === "inbound");
    console.log(`\n=== PENDENTES (último turno = INBOUND, sem resposta): ${pending.length} ===`);
    for (const c of pending) {
      console.log(
        JSON.stringify({
          contactId: c.contactId,
          name: c.fullName || c.contactName || null,
          phone: c.phone || null,
          conversationId: c.id,
          lastDate: c.lastMessageDate,
          lastType: c.lastMessageType,
          body: String(c.lastMessageBody || "").slice(0, 90),
        }),
      );
    }

    console.log(`\n=== JÁ RESPONDIDAS (último = outbound — IGNORAR): ${convs.length - pending.length} ===`);
  } catch (e) {
    console.log("GHL conversations erro:", e instanceof Error ? e.message : e);
  }

  process.exit(0);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
