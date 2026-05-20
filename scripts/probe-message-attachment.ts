import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { GHLClient } from "@/lib/ghl/client";

async function main() {
  const c = new GHLClient("TdmQMjj86Y3LgppiB96K", "RBFxlEQZobaDjlF2i5px");
  const messageId = "Flktm50dGCSRvbcYQRGj";

  // Tenta buscar a mensagem pra ver se tem attachments
  for (const path of [
    `/conversations/messages/${messageId}`,
    `/conversations/messages/${messageId}/`,
  ]) {
    try {
      const r = await c.get(path);
      console.log(`\n${path}:`);
      console.log(JSON.stringify(r, null, 2).slice(0, 1200));
    } catch (e) {
      console.log(`${path}: FAIL ${e instanceof Error ? e.message.slice(0, 150) : e}`);
    }
  }
}
main();
