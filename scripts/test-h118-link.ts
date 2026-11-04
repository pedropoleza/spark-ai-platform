/**
 * H118: link repetido sai (Bruno/vídeo). Rodar: npx tsx scripts/test-h118-link.ts
 */
import { tirarLinkRepetido, leadPediuLink } from "@/lib/queue/link-repeat-guard";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, x !== undefined ? JSON.stringify(x) : ""); } };
const LINK = "https://career.alvescuryfinancial.com/?cid=RAJnhjSPwVUovBDDNLiD#video";
const antes = [`Antes de marcar com a Taciana, dá uma olhada no vídeo, é curtinho: ${LINK}`, "Muita gente começa em paralelo com o trabalho atual."];

const r = tirarLinkRepetido([`Entendi. Você já assistiu ao vídeo? É curtinho, uns 10 minutos: ${LINK}`, "Depois dele a gente marca com a Taciana."], antes, "ainda não vi");
ok("link mandado na resposta anterior sai", r.removidos.length === 1 && !r.messages.join(" ").includes("career."), r);
ok("o resto da bolha fica", r.messages[0] === "Entendi. Você já assistiu ao vídeo?" && r.messages[1].startsWith("Depois dele"), r.messages);
ok("lead pediu de novo: link fica", tirarLinkRepetido([`Claro, aqui está: ${LINK}`], antes, "pode mandar o link de novo?").removidos.length === 0);
ok("'não abriu' conta como pedido", leadPediuLink("o vídeo não abriu aqui"));
ok("link de 3 respostas atrás pode voltar", tirarLinkRepetido([`Segue: ${LINK}`], [antes[0], "a", "b"], "oi").removidos.length === 0);
ok("bolha só com o link: não apaga tudo", tirarLinkRepetido([LINK], antes, "oi").messages.length === 1);
console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
