/**
 * Probe READ-ONLY (verificação H57 / 2026-07-28): a perna "ghl" do
 * deliverProactiveMessage termina em QUEM?
 *
 * Pega mensagens de lembrete que saíram com sent_via='ghl' e lê o
 * conversationProviderId que o Spark Leads registrou — se for o provider do
 * Stevo/Evolution, então "ghl" NÃO é um caminho independente do Stevo.
 *
 *   npx tsx -r tsconfig-paths/register scripts/probe-reminder-provider.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "@/lib/ghl/client";

const COMPANY = "TdmQMjj86Y3LgppiB96K";
const HUB = "RBFxlEQZobaDjlF2i5px";

// ghl_message_id de rows scheduled_reminder com sent_via='ghl' (28/07)
const MSG_IDS = [
  "B5Ei4A4HEqlgBBCaDHw5", "bRYUcC5rFJ4MBbEqbWSp", "jUPoXKMBSCsmJjNPLwlM",
  "wbykUiG4Rk9WbbjZ62J1", "pOa6GAkctW1H3SLpoBqd", "LcM3xqJx5yAxeA1MydDM",
  "apMIMkqELVumVNMvc1nL", "OxNPu7IlvllAk0Q1dMZI", "CxwbAkfqdMJleEqut4KB",
  "4cEZrMZM343ozBHqTeTW", "oSoFiNYhS8p2QcDud0D0", "o6kXPt2qWoCB2Q7V80ob",
  "cog4fKMfzkHejY9EKts9", "7eBNWB8LKjlmyGgvhFCW",
];

async function main() {
  const ghl = new GHLClient(COMPANY, HUB);

  for (const id of MSG_IDS) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const d = await ghl.get<any>(`/conversations/messages/${encodeURIComponent(id)}`);
      const m = d?.message || d;
      console.log(`\n=== msg ${id} ===`);
      console.log("  messageType         :", m?.messageType);
      console.log("  type                :", m?.type);
      console.log("  status              :", m?.status);
      console.log("  direction           :", m?.direction);
      console.log("  conversationProvider:", m?.conversationProviderId);
    } catch (e) {
      console.log(`\n=== msg ${id} === ERRO:`, e instanceof Error ? e.message.slice(0, 200) : e);
    }
  }

  // Lista os conversation providers da location pra nomear o provider id acima.
  for (const path of [
    `/conversations/providers/?locationId=${HUB}`,
    `/locations/${HUB}/conversation-providers`,
  ]) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = await ghl.get<any>(path);
      console.log(`\n=== providers via ${path} ===`);
      console.log(JSON.stringify(p).slice(0, 1500));
    } catch (e) {
      console.log(`\n=== providers via ${path} === ERRO:`, e instanceof Error ? e.message.slice(0, 160) : e);
    }
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
