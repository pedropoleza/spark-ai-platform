/**
 * Testa o sanitizador determinístico de saída (caso Marina — palavra proibida).
 *   npx tsx -r tsconfig-paths/register scripts/test-outbound-sanitizer.ts
 */
import { sanitizeOutbound } from "@/lib/ai/outbound-sanitizer";

const TERMS = ["National Life Group", "National Life", "Five Rings Financial", "Five Rings"];
let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const noNL = (arr: string[]) => !arr.some((m) => /national life|five rings|\d+\s*anos de mercado|desde 18\d\d/i.test(m));

// 1) vazamento real #1 (positioning)
let r = sanitizeOutbound(["é uma carreira como agente financeiro licenciado, trabalhando com a National Life Group, empresa com mais de 100 anos de mercado nos EUA. Carreira séria, regulada, não é bico"], TERMS);
check("real#1 sem National Life/anos", noNL(r.messages), r.messages.join(" | "));
check("real#1 preserva 'carreira séria/regulada'", r.messages.join(" ").includes("Carreira séria") && r.messages.join(" ").includes("regulada"));
check("real#1 marcado como redacted", r.redacted);

// 2) vazamento real #2 (benefícios)
r = sanitizeOutbound(["Além do treinamento pra licença, vc tem appointment com a National Life Group e acesso a outras seguradoras conforme for crescendo"], TERMS);
check("real#2 sem National Life", noNL(r.messages), r.messages.join(" | "));
check("real#2 preserva 'appointment e acesso'", /appointment e acesso a outras seguradoras/i.test(r.messages.join(" ")));

// 3) msg 100% proibida → fallback seguro (não vazia)
r = sanitizeOutbound(["trabalhando com a National Life, empresa com mais de 100 anos de mercado"], TERMS);
check("msg-toda-proibida vira fallback não-vazio", r.messages.length === 1 && r.messages[0].length > 5 && noNL(r.messages), r.messages.join("|"));

// 4) multi-bolha: uma limpa, uma proibida → mantém a limpa, redige a outra
r = sanitizeOutbound(["Oi! que bom que chamou 😊", "é com a National Life Group, sabe?"], TERMS);
check("multi-bolha preserva a bolha limpa", r.messages.some((m) => m.includes("que bom que chamou")));
check("multi-bolha sem National Life", noNL(r.messages), r.messages.join(" | "));

// 5) sem forbidden_terms → no-op (paridade)
r = sanitizeOutbound(["trabalhando com a National Life Group"], []);
check("sem config = no-op (não mexe)", r.messages[0] === "trabalhando com a National Life Group" && !r.redacted);

// 6) msg normal → intacta
r = sanitizeOutbound(["A Marina explica tudo no encontro de segunda às 8pm ET 🙂"], TERMS);
check("msg normal intacta", r.messages[0].includes("8pm ET") && !r.redacted);

// 7) "National Life Group" não deixa "Group" órfão
r = sanitizeOutbound(["vc trabalha com a National Life Group nisso"], TERMS);
check("não sobra 'Group' órfão", !/\bgroup\b/i.test(r.messages.join(" ")), r.messages.join(" "));

// 8) variação de caixa/acento
r = sanitizeOutbound(["representa a NATIONAL LIFE, com mais de 170 anos de mercado"], TERMS);
check("caixa alta redigida", noNL(r.messages), r.messages.join(" | "));

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail ? 1 : 0);
