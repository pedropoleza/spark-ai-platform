import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

async function main() {
  const c = new GHLClient("TdmQMjj86Y3LgppiB96K", "RBFxlEQZobaDjlF2i5px");
  const mid = "Flktm50dGCSRvbcYQRGj";
  const paths = [
    `/conversations/messages/${mid}/locations/RBFxlEQZobaDjlF2i5px/media`,
    `/conversations/locations/RBFxlEQZobaDjlF2i5px/messages/${mid}`,
    `/conversations/messages/${mid}/media`,
  ];
  for (const p of paths) {
    try {
      const r = await c.get(p);
      console.log(`${p} → OK ${JSON.stringify(r).slice(0, 250)}`);
    } catch (e) {
      console.log(`${p} → ${e instanceof Error ? e.message.slice(0, 110) : e}`);
    }
  }
}
main();
