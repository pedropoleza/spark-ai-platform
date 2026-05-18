// Verbose probe — mostra mensagem completa de erro pra cada falha
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { getLocationToken, invalidateTokenCache } from "@/lib/ghl/auth";

const fails = [
  "HG6PtgvJVnjKXaLrGPJn",
  "HdsYBkDuLAmfgSKLMKJj",
  "eT7JNkBI82pMNUcmCqRE",
  "uheWeD89khTiOC6HfJG8",
  "F6V432nWQ1qd1KpTN9aC",
  "L0HaPTkzubGGj1EGngsq",
  "6ZomOpLfyGxwkeKevWEC",
  "iXpucz0QLuIiUuTmVaOo",
  "vWgIKCdcC9chjSqGXI9s",
  "mjYs3a6ygEZ3rzCaORHF",
  "O9rX6Eb9PnFMP1ufDhjJ",
];
const COMPANY = "TdmQMjj86Y3LgppiB96K";

async function main() {
  for (const loc of fails) {
    invalidateTokenCache(COMPANY, loc);
    try {
      await getLocationToken(COMPANY, loc);
      console.log("OK:", loc);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(loc, "→", msg);
    }
  }
}
main();
