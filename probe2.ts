import { generatePhoneCandidates } from "./src/lib/account-assistant/identity";
for (const p of ["+17867717077","17867717077","786-771-7077","(786) 771-7077","5511987654321","+55 11 98765-4321"]) {
  console.log(JSON.stringify(p), "->", JSON.stringify(generatePhoneCandidates(p)));
}
