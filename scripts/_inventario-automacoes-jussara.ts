/** O que as automações da conta estão MANDANDO pros leads hoje. READ-ONLY. */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "../src/lib/ghl/client";
const LOC="pGl5pqLLG0QDixANpFnP", CO="TdmQMjj86Y3LgppiB96K";
const DESDE = Date.now() - 10*864e5;
(async () => {
  const ghl = new GHLClient(CO, LOC);
  const r = await ghl.get<{conversations?:Array<{id:string;contactId:string;lastMessageDate?:string}>}>(
    "/conversations/search", { locationId: LOC, sortBy:"last_message_date", sort:"desc", limit:"100" });
  const buckets = new Map<string, {n:number; ex:string; anuncio:number}>();
  for (const c of r.conversations||[]) {
    if (!c.lastMessageDate || new Date(c.lastMessageDate).getTime() < DESDE) continue;
    let anuncio = false;
    try { const ct = await ghl.get<{contact?:{tags?:string[]}}>(`/contacts/${c.contactId}`,{});
      anuncio = (ct.contact?.tags||[]).some(t=>/ctwa-lead|^anuncio|metaads|patrocinados/i.test(t)); } catch {}
    let m;
    try { m = await ghl.get<{messages?:{messages?:Array<{direction:string;body?:string;dateAdded:string;source?:string}>}}>(
      `/conversations/${c.id}/messages`, { locationId: LOC, limit:"25" }); } catch { continue; }
    for (const x of m.messages?.messages||[]) {
      if (x.direction==="inbound" || x.source!=="workflow") continue;
      if (new Date(x.dateAdded).getTime() < DESDE) continue;
      const txt = String(x.body||"").replace(/\s+/g," ").trim();
      const chave = txt.slice(0,46);
      const b = buckets.get(chave) || {n:0, ex:txt, anuncio:0};
      b.n++; if (anuncio) b.anuncio++;
      buckets.set(chave, b);
    }
  }
  console.log("MENSAGENS ENVIADAS POR WORKFLOW (últimos 10 dias)\n");
  const ord = [...buckets.entries()].sort((a,b)=>b[1].n-a[1].n);
  for (const [,v] of ord) {
    console.log(`  ${String(v.n).padStart(3)}x  (${v.anuncio} p/ lead de anúncio)`);
    console.log(`        "${v.ex.slice(0,110)}"`);
  }
  process.exit(0);
})();
