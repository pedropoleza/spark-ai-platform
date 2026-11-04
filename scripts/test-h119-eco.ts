/**
 * H119: eco no começo da resposta e apresentação no "é robô?". Rodar: npx tsx scripts/test-h119-eco.ts
 */
import { tirarEcoDoInicio } from "@/lib/queue/eco-guard";
import { leadPerguntouIdentidade, sanitizeAgentMessage } from "@/lib/ai/response-sanitizer";

let pass = 0, fail = 0;
const ok = (n: string, c: boolean, x?: unknown) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`, x !== undefined ? JSON.stringify(x) : ""); } };

console.log("\n1) Eco do estado");
ok("'Florida, ótimo. E hoje...' → 'E hoje...'", tirarEcoDoInicio(["Florida, ótimo. E hoje, você trabalha com o quê?"], "Florida").messages[0] === "E hoje, você trabalha com o quê?");
ok("'Orlando, boa! E hoje...' com 'Oi, moro em Orlando' → 'E hoje...'", tirarEcoDoInicio(["Orlando, boa! E hoje, você trabalha com o quê?"], "Oi, moro em Orlando").messages[0] === "E hoje, você trabalha com o quê?");
ok("'Flórida, perfeito!' sozinho numa bolha sai", JSON.stringify(tirarEcoDoInicio(["Flórida, perfeito!", "E hoje, você trabalha com o quê?"], "florida").messages) === JSON.stringify(["E hoje, você trabalha com o quê?"]));
ok("reação com conteúdo fica ('Texas tem muita gente da comunidade')", tirarEcoDoInicio(["Texas, tem muita gente da comunidade aí. E hoje, você trabalha com o quê?"], "Texas").removido === null);
ok("mensagem longa do lead: não mexe", tirarEcoDoInicio(["Entendi, faz sentido."], "eu trabalho como motorista há cinco anos").removido === null);
ok("começo que não é eco: não mexe", tirarEcoDoInicio(["Perfeito. E hoje, você trabalha com o quê?"], "Florida").removido === null);

ok("bolha solta 'Massachusetts, anotado!' sai mesmo com mensagem longa", JSON.stringify(tirarEcoDoInicio(["Massachusetts, anotado!", "O valor depende de alguns fatores."], "Moro em MA. Quanto custa um seguro de 500 mil?").messages) === JSON.stringify(["O valor depende de alguns fatores."]));
ok("bolha única 'Texas, anotado!' fica (nunca deixa sem resposta)", tirarEcoDoInicio(["Texas, anotado!"], "moro no Texas, e você?").removido === null);

console.log("\n2) 'Você é robô?' mantém a apresentação");
ok("detecta a pergunta", leadPerguntouIdentidade("você é um robô?") && leadPerguntouIdentidade("é IA?") && leadPerguntouIdentidade("estou falando com uma pessoa de verdade?"));
ok("não detecta pergunta comum", !leadPerguntouIdentidade("quanto custa?") && !leadPerguntouIdentidade("moro na Flórida"));
const resp = "Aqui é a Bruna, do time da Alves Cury, pode ficar tranquilo 😊";
ok("sem a pergunta: corta a reapresentação (como antes)", sanitizeAgentMessage(resp, 3) !== resp);
ok("com a pergunta: a resposta sai inteira", sanitizeAgentMessage(resp, 3, { manterApresentacao: true }) === resp);

console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
