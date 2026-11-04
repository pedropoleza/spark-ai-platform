/**
 * H120: meta-linguagem sai do texto do lead. Rodar: npx tsx scripts/test-h120-meta.ts
 */
import { tirarMetaLinguagem } from "@/lib/queue/meta-guard";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, x !== undefined ? JSON.stringify(x) : ""); } };
const r = tirarMetaLinguagem(["Ótimo que você assistiu!", "O sistema ainda não registrou a visualização do vídeo. Abre por esse link e vai até o final: https://x.com/v"]);
ok("frase do sistema sai, o link fica", r.messages[1] === "Abre por esse link e vai até o final: https://x.com/v" && r.removidas.length === 1, r);
ok("'não registrou aqui do meu lado' sai", tirarMetaLinguagem(["Só que o vídeo ainda não registrou aqui do meu lado. Abre de novo, por favor?"]).messages[0] === "Abre de novo, por favor?");
ok("'registrada como auxiliar' fica", tirarMetaLinguagem(["Que bom que você é registrada como auxiliar administrativa."]).removidas.length === 0);
ok("'sistema de saúde' fica", tirarMetaLinguagem(["O sistema de saúde daqui é caro, por isso vale planejar."]).removidas.length === 0);
ok("etiqueta sai", tirarMetaLinguagem(["Vou colocar uma etiqueta aqui. Você mora em qual estado?"]).messages[0] === "Você mora em qual estado?");
ok("bolha só com meta: não apaga tudo", tirarMetaLinguagem(["O sistema não registrou."]).messages.length === 1);
console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
