/** Leads de anúncio esperando resposta AGORA (última msg é do lead). READ-ONLY. */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { GHLClient } from "../src/lib/ghl/client";
const LOC="pGl5pqLLG0QDixANpFnP", CO="TdmQMjj86Y3LgppiB96K";
const QUEDA = new Date("2026-08-23T22:11:45Z").getTime();
(async () => {
  const ghl = new GHLClient(CO, LOC);
  const r = await ghl.get<{conversations?:Array<{id:string;contactId:string;fullName?:string;lastMessageDate?:string;lastMessageDirection?:string;lastMessageBody?:string}>}>(
    "/conversations/search", { locationId: LOC, sortBy:"last_message_date", sort:"desc", limit:"100" });
  const cand = (r.conversations||[]).filter(c=>c.lastMessageDirection==="inbound" && c.lastMessageDate && new Date(c.lastMessageDate).getTime()>QUEDA);
  const out: string[] = [];
  for (const c of cand) {
    let tags:string[]=[], phone="", nome="";
    try { const ct = await ghl.get<{contact?:{tags?:string[];phone?:string;firstName?:string;lastName?:string}}>(`/contacts/${c.contactId}`,{});
      tags=ct.contact?.tags||[]; phone=ct.contact?.phone||""; nome=[ct.contact?.firstName,ct.contact?.lastName].filter(Boolean).join(" "); } catch {}
    if (!tags.some(t=>/ctwa-lead|^anuncio|metaads|patrocinados/i.test(t))) continue;
    const dias = Math.floor((Date.now()-new Date(c.lastMessageDate!).getTime())/864e5);
    out.push(`${String(nome||c.fullName||"").slice(0,26).padEnd(26)} ${phone.padEnd(16)} há ${String(dias).padStart(2)}d  "${String(c.lastMessageBody||"").replace(/\n/g," ").slice(0,44)}"`);
  }
  console.log(`LEADS DE ANÚNCIO SEM RESPOSTA (${out.length}):\n`);
  out.forEach(l=>console.log("  "+l));
  process.exit(0);
})();
