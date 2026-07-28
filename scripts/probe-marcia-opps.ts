/**
 * Probe READ-ONLY (rodada 2 revisão Marcia): pra cada contato que a Marcia
 * mensajou nos últimos 30d, busca opportunities no GHL e reporta status.
 * Só GET. Efêmero — apagar depois.
 */
import { GHLClient } from "../src/lib/ghl/client";

const LOCATION = "jA6uzx6tONyTeocxw4Cj";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

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
  opportunities?: Array<{ id?: string; name?: string; status?: string; pipelineStageId?: string }>;
}

async function main() {
  const client = new GHLClient(COMPANY, LOCATION);
  let withOpp = 0, closed = 0, none = 0, errs = 0;
  const closedList: string[] = [];
  for (const c of CONTACTS) {
    try {
      const r = await client.get<OppResp>(
        `/opportunities/search?location_id=${LOCATION}&contact_id=${c}&limit=5`,
      );
      const opps = r?.opportunities || [];
      if (opps.length === 0) { none++; continue; }
      withOpp++;
      const closedOpps = opps.filter((o) =>
        ["won", "lost", "abandoned"].includes((o.status || "").toLowerCase()),
      );
      const statuses = opps.map((o) => o.status).join(",");
      console.log(`${c}: ${opps.length} opps [${statuses}]`);
      if (closedOpps.length > 0 && closedOpps.length === opps.length) {
        closed++;
        closedList.push(`${c} [${statuses}]`);
      }
    } catch (e) {
      errs++;
      console.log(`${c}: ERR ${e instanceof Error ? e.message.slice(0, 80) : e}`);
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  console.log(`\nTOTAL=${CONTACTS.length} com_opp=${withOpp} SEM_opp=${none} TODAS_FECHADAS=${closed} errs=${errs}`);
  console.log("Contatos com TODAS as opps fechadas (a IA mensajou mesmo assim):");
  for (const l of closedList) console.log("  " + l);
}

main().catch((e) => { console.error(e); process.exit(1); });
