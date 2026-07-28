/** Probe READ-ONLY: stage de cada opp dos contatos mensajados (30d). Efêmero. */
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION = "jA6uzx6tONyTeocxw4Cj";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

const TERMINAL_STAGES: Record<string, string> = {
  "23ecbb81-ed4f-4367-bf76-5bf1a5c927eb": "Deal Closed",
  "d4cf1403-ec42-4345-8ef7-a2c365064eb2": "Waiting Application",
  "51782526-046c-4751-84b7-75a203bafe24": "Policy Delivery",
  "e9e9c120-9f7d-4df0-b76e-8770c7ed8b16": "Active Client",
  "1382d911-2732-418a-82d1-d081daa69d3e": "Not Interested",
};

const STAGE_NAMES: Record<string, string> = {
  "51ffcd4b-a764-4a84-8fa5-36b0914b649a": "New Lead",
  "6f7fed88-457a-4283-8d4b-6aad827dd725": "Follow-up",
  "144fb041-296c-4b4b-8f04-a8f28bd67d58": "In Contact",
  "ba0e215d-5f4f-4beb-87ef-83b0254e315e": "Qualified",
  "310f75bc-375c-4c53-bb74-efd216477066": "First Meeting Booked",
  "fa8d849d-47fd-456b-b7ed-b3014e8f0e0e": "Reschedule First Meeting",
  "2c51165f-bed7-4929-96c0-ea5aa62056dc": "Make Illustration",
  "66dd3be7-5bf8-4fc7-80fa-057de59b9f8f": "Illustration Booked",
  "b0e17bcf-9ce3-41f9-9305-7312ca1da5c9": "Reschedule Illustration",
  ...TERMINAL_STAGES,
};

const CONTACTS = [
  "E9b2sHdA5PHETG7m1FnO","1aG9F3QWilLeoddDJNao","E9hwy1sQSx9FzjvMW7kF","hvQUWXCJdKSq2dSqMQm6",
  "hdvsOzas43GnNHhPkdOd","pUOR0tfVzEzOwMsu6Z12","4WtIXe6NUlG7P1HXxH5p","vs09cg74b2PisQR2jkLa",
  "2kHkO9Kl3P30UEqRc5v2","vAvZMIkkFb9IQUZFTYn2","6LytfovoSs5yhfsSYUg2","6mntS3J88UKMv9Esb8RD",
  "M6CsvbZIvh3K14sWlkeB","sZThWkBmdPi4gQlbaQ93","v2WUSpIY5C4NfVQG5cSb","4asoRTGxlKnAbOHZldn5",
  "Qdppwps3srmRwGNWGgo8","OVHA3ACrlclND51sCivy","bGHosp1aUUXjqZBna9gp","qyQlnD9h9S9Rh5t3SRoi",
  "F1DOVCj8ETIBf5TkdU6s","0KyU5lvMJr3zIUa3QM1i","gsMyGeU6CQPHCzX0qgVe","zJz84kWaHgkfmQUqenDV",
  "IX1Ij5mYPF4SmmLA04SV","KDXOmdS1VRafou06vr3a","IJCPMOF0TFLPINppvhw7","fsQoRCt08uVKlgLdwkwX",
  "FLOGXZo1PbfWdUEeuFnJ","YG7kBd9yY8nb8kXQaNWN","lvB9taLguirZ1PQlPr8t","tvhMALcEELfsA71KyQMt",
  "6QANIxPxgAQdzeBCAmhU","l6cWUPj86DCIx8DVPJQA","swIzbuDd1Vx6gUGwB3Wt","q8qwBnjQeGjF0XFyTOC6",
  "A02IaCQIC1lBu3ZAxWSF","Aok8Ikh6UZAEDyef34CX","U2uPbgR8IQ6WYXph9q6Y","BCQeB1kXSBfauaY0w2EZ",
];

interface OppResp {
  opportunities?: Array<{ id?: string; status?: string; pipelineId?: string; pipelineStageId?: string }>;
}

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  const stageCount = new Map<string, number>();
  const terminalContacts: string[] = [];
  for (const c of CONTACTS) {
    try {
      const r = await client.get<OppResp>(
        `/opportunities/search?location_id=${LOCATION}&contact_id=${c}&limit=5`,
      );
      for (const o of r?.opportunities || []) {
        const sid = o.pipelineStageId || "?";
        const name = STAGE_NAMES[sid] || sid;
        stageCount.set(name, (stageCount.get(name) || 0) + 1);
        if (TERMINAL_STAGES[sid]) terminalContacts.push(`${c} → ${TERMINAL_STAGES[sid]}`);
      }
    } catch (e) {
      console.log(`${c}: ERR ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log("Distribuição de stages (opps dos 40 contatos mensajados em 30d):");
  for (const [name, n] of [...stageCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${name}: ${n}`);
  }
  console.log(`\nContatos com opp em stage TERMINAL que a IA mensajou: ${terminalContacts.length}`);
  for (const t of terminalContacts) console.log("  " + t);
}

main().catch((e) => { console.error(e); process.exit(1); });
