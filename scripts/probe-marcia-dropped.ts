/**
 * Rodada 2 Marcia — Frente H(2)/(3): checar tags atuais + estado da conversa dos
 * contatos dropados (webhook no_agent_matched_targeting hoje + 8 nunca-atendidos
 * do reenqueue de 21/07 + engolidos wallet sem resposta). READ-ONLY.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION_ID = "jA6uzx6tONyTeocxw4Cj";
const TAG = "ai qualification active";

const GROUPS: Record<string, string[]> = {
  "DROPADOS_WEBHOOK_HOJE": ["seMtGSiwCWNImVrEj8a7", "RViKV6N7XqSMnseqhat4", "GdOthnFnMoKBpjSZoZ9v"],
  "NUNCA_ATENDIDOS_REENQUEUE_0721": [
    "8Bl9dezXjFA4u2f64Lyc", "A8H9l75B81nFzyvti7EJ", "B9Rnovi8j2rum2yRLdg3",
    "tRVxF9uhlCC70amVA0hs", "lVohHuZSLQPeCBk6V2nQ", "T7Pwuac52IvR2YdrkZ0h",
    "woc64kVmAZnyKKfFtLHI", "vf4hHsexWh5JKL5pBnJ9",
  ],
  // wallet-engolidos com last_inbound recente e sem send nosso depois (amostra crítica)
  "WALLET_SEM_RESPOSTA": [
    "mUlGFgdmDvF3lMoj2fne", "q9ljh7xvB7RKxtOfZYff", "Zczbe9DRmvw9jkDpG07F",
    "18org94OcLWDs14YPa7S", "k0iweTzI8At9cG0H0Fyv", "GVlXhLFnQPA1kNVHFLmT",
    "q5JNCpu9AYKpevuWXq8i", "261ypzk3xP7iy2itV0nv", "Wt07fmy9NrpamzsG8EmY",
    "eVzPy9Jk4p3YVn68WrWo", "jh2cwhTUP1WBaKyp8N4F", "Hao6GAcIr8YUjmQR3A68",
    "cn6lGVmnJcKg7hVhPWoF", "p6ZDTbP9m5ro7ZL89DqL", "U1TsEFjf3kZOyUJENicz",
    "wEU55seoFJFJJMGhqu4C", "byVOkVufxgiKtmuJaPuH", "dkAOh7z1pGatOMqYVJOc",
    "FdY3ROe5w9LQHgCSIGr8", "9vg59udFzff1EIV6LYnn", "13EhGD7agsIsmQIFWPZA",
    "CKdjVXB0d0UCqfUXPf77", "bKHaWZ03efqf32aeA076", "fspsg85oDbPsQb3ekGvR",
    "efxpM5CsaY4PGB9wwRsI", "qUXmekEq0B9BCLd1Raai", "IaYLEIzVXdtZ6PCxyDgN",
    "vQ9mUqWpoxQpnzGoV7qr", "7UaewNs1nAYg6vcFMlPb", "eEzoCLnjZTwRSV94Fzjc",
    "4RsJgiArzG7F0p7mESd7", "U34g8lGYPkuVDYmANz4v", "gbOwlSGM0sexYaK3A5P8",
    "1aW3I2Rh1X8omJSjmFxi", "vLWMoBvibUuXqbHWwLMO", "mCoSrhEa378gx8wcawq1",
    "M984iJtwyjPbElNlie7h", "1sfbr5EiFJ8jvoGxE2nO", "wWUVzQvTQRH7rPQvsAIB",
    "GOVeYS8NmR9ZwLtoRaAQ", "Z8RyPVKCK9kDwhiYvGjD", "HOwAXH0mITo4cvWz9BVU",
    "KLNbihV3qyk51WurQSMn", "3r7plDQvx8BvezdRP8Dy", "wKSUGaOGbuGThcs1jJAl",
    "B9Rnovi8j2rum2yRLdg3", "cRyWyKcw66HAKaFczj2c", "JTI4rOMAoL3ZcTk1edqi",
    "c92Mw1dQpH5apjOWB0x0", "NP8ZECZgZ5wx21enDA9D", "6mntS3J88UKMv9Esb8RD",
  ],
};

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", LOCATION_ID).maybeSingle();
  if (!loc?.company_id) throw new Error("company_id não achado");
  const client = new GHLClient(loc.company_id, LOCATION_ID);

  for (const [group, ids] of Object.entries(GROUPS)) {
    console.log(`\n########## ${group} (${ids.length}) ##########`);
    for (const cid of ids) {
      try {
        const ct = await client.get<{ contact?: { firstName?: string; lastName?: string; phone?: string; tags?: string[]; dateAdded?: string } }>(`/contacts/${cid}`);
        const c = ct.contact || {};
        const tags = (c.tags || []).map((t) => String(t).toLowerCase());
        const hasTag = tags.includes(TAG);
        // Conversa: último inbound/outbound
        let lastIn = "-", lastOut = "-", lastOutBody = "", lastInBody = "", nMsgs = 0, lastOutHuman = "?";
        try {
          const search = await client.get<{ conversations?: Array<{ id: string }> }>(`/conversations/search`, { locationId: LOCATION_ID, contactId: cid });
          const convId = search.conversations?.[0]?.id;
          if (convId) {
            const resp = await client.get<{ messages: { messages: Array<Record<string, unknown>> } }>(`/conversations/${convId}/messages`, { locationId: LOCATION_ID });
            const msgs = (resp.messages?.messages || []).slice().sort((a, b) => new Date(String(a.dateAdded)).getTime() - new Date(String(b.dateAdded)).getTime());
            nMsgs = msgs.length;
            const li = [...msgs].reverse().find((m) => m.direction === "inbound");
            const lo = [...msgs].reverse().find((m) => m.direction === "outbound" && m.messageType === "TYPE_CUSTOM_SMS");
            if (li) { lastIn = String(li.dateAdded); lastInBody = String(li.body || "").replace(/\s+/g, " ").slice(0, 70); }
            if (lo) {
              lastOut = String(lo.dateAdded);
              lastOutBody = String(lo.body || "").replace(/\s+/g, " ").slice(0, 70);
              lastOutHuman = lo.userId ? `user=${lo.userId}` : `src=${lo.source}`;
            }
          }
        } catch { /* ignore */ }
        const unanswered = lastIn !== "-" && (lastOut === "-" || new Date(lastOut) < new Date(lastIn));
        console.log(
          `${cid} | ${c.firstName || "?"} ${c.lastName || ""} | tag=${hasTag ? "SIM" : "NAO"} | msgs=${nMsgs} | lastIN=${lastIn} "${lastInBody}" | lastOUT=${lastOut} (${lastOutHuman}) "${lastOutBody}" | ${unanswered ? "*** SEM RESPOSTA ***" : "respondido"}`,
        );
      } catch (e) {
        console.log(`${cid} | ERRO: ${e instanceof Error ? e.message.slice(0, 100) : e}`);
      }
    }
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
