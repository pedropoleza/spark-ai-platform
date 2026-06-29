/**
 * Guard rail dos helpers PUROS da captura de mídia do rep (H46/F4). Sem DB/rede.
 *   npx tsx scripts/test-rep-media.ts
 */
import { extFromMime, dataUriToBuffer } from "../src/lib/account-assistant/rep-media/capture";

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}`); }
}

console.log("\n=== extFromMime ===");
ok("image/png → png", extFromMime("image/png") === "png");
ok("image/jpeg → jpg", extFromMime("image/jpeg") === "jpg");
ok("application/pdf → pdf", extFromMime("application/pdf") === "pdf");
ok("image/webp → webp", extFromMime("image/webp") === "webp");
ok("desconhecido + filename .docx → docx", extFromMime("application/octet-stream", "contrato.docx") === "docx");
ok("desconhecido sem filename → bin", extFromMime("application/octet-stream") === "bin");
ok("ext longa truncada (≤5)", extFromMime("application/x", "arquivo.superlongext").length <= 5);

console.log("\n=== dataUriToBuffer ===");
const png1px = "data:image/png;base64,iVBORw0KGgo="; // bytes válidos (header PNG)
const r1 = dataUriToBuffer(png1px);
ok("data URI válido → {mime,bytes}", r1 !== null && r1.mime === "image/png" && r1.bytes.length > 0);
ok("mime extraído certo", dataUriToBuffer("data:application/pdf;base64,JVBER==")?.mime === "application/pdf");
ok("não-data-uri → null", dataUriToBuffer("https://exemplo.com/x.png") === null);
ok("vazio → null", dataUriToBuffer("") === null);
ok("sem base64 marker → null", dataUriToBuffer("data:image/png,nope") === null);
ok("trim de espaços", dataUriToBuffer("  data:image/png;base64,iVBORw0KGgo=  ") !== null);

console.log(`\n=== RESULTADO: ${pass} pass / ${fail} fail ===`);
process.exit(fail === 0 ? 0 : 1);
