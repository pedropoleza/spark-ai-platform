/**
 * UR-2 (ultra-review 2026-07-17) — testes dos fixes P1:
 *   - splitResponseIntoMessages: cap de bolhas SEM perder conteúdo (caso Andrea)
 *   - parseTermsResponse: aceite digitado/numerado (caso Willian)
 *   - tokenSim/levenshtein no resolver (caso Nilzete/Niuzete)
 *
 * Rodar: npx tsx scripts/test-ur2-fixes.ts
 */
import { splitResponseIntoMessages } from "../src/lib/account-assistant/webhook/sparkbot-send";
import { parseTermsResponse } from "../src/lib/account-assistant/terms";
import {
  nameScore,
  tokenSim,
  levenshtein,
} from "../src/lib/account-assistant/contact-resolver/normalize";

let passed = 0,
  failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} (esperava ${JSON.stringify(expected)}, veio ${JSON.stringify(actual)})`);
    failed++;
  }
}

console.log("\n=== splitResponseIntoMessages (cap sem perda — caso Andrea) ===");
eq("sem splitter → 1 msg", splitResponseIntoMessages("oi tudo bem").length, 1);
const three = splitResponseIntoMessages("a\n---\nb\n---\nc");
eq("3 partes → 3 bolhas", three.length, 3);
// Caso Andrea: 6 partes (intro + 4 leads + fechamento) — antes perdia da 4ª em diante
const six = splitResponseIntoMessages(
  "intro\n---\nlead Luciana\n---\nlead Claudia\n---\nlead Cristiane\n---\nlead Fete\n---\nfechamento",
);
eq("6 partes → 5 bolhas (cap)", six.length, 5);
const joined = six.join("\n");
for (const chunk of ["Luciana", "Claudia", "Cristiane", "Fete", "fechamento"]) {
  eq(`conteúdo preservado: ${chunk}`, joined.includes(chunk), true);
}
eq("última bolha funde o excedente", six[4].includes("lead Fete") && six[4].includes("fechamento"), true);

console.log("\n=== parseTermsResponse (aceite digitado — caso Willian) ===");
eq("'1. Aceito ✅' → accept", parseTermsResponse("1. Aceito ✅"), "accept");
eq("'1 aceito' → accept", parseTermsResponse("1 aceito"), "accept");
eq("'eu aceito os termos' → accept", parseTermsResponse("eu aceito os termos"), "accept");
eq("'Aceito ✅' → accept (regressão)", parseTermsResponse("Aceito ✅"), "accept");
eq("quick-reply com sufixo → accept (regressão)", parseTermsResponse("Aceito ✅ — (resposta à pergunta: 'termos cheios de não...')"), "accept");
eq("'2. Não aceito ❌' → reject", parseTermsResponse("2. Não aceito ❌"), "reject");
eq("'não aceito' → reject (regressão LGPD)", parseTermsResponse("não aceito"), "reject");
eq("'não tá ok pra mim' → reject (regressão)", parseTermsResponse("não tá ok pra mim"), "reject");
eq("yes-but-no → unclear (regressão LGPD)", parseTermsResponse("aceito que errei mas não concordo com isso"), "unclear");
eq("comando numerado não vira aceite", parseTermsResponse("1 cria contato do João Silva pra mim"), "unclear");
eq("'eu quero saber mais' → unclear", parseTermsResponse("eu quero saber mais"), "unclear");
// H52 review adversarial: dígito seco = seleção do menu; "2 <algo>" nunca vira aceite
eq("'1' seco → accept (seleção do menu)", parseTermsResponse("1"), "accept");
eq("'2' seco → reject (seleção do menu)", parseTermsResponse("2"), "reject");
eq("'2.' → reject", parseTermsResponse("2."), "reject");
eq("'2 ok' NÃO vira aceite (escolheu a opção Não aceito)", parseTermsResponse("2 ok"), "unclear");
eq("'2 pode ser' NÃO vira aceite", parseTermsResponse("2 pode ser"), "unclear");
eq("'10' não é seleção → unclear", parseTermsResponse("10"), "unclear");

console.log("\n=== resolver: levenshtein + tokenSim (caso Nilzete/Niuzete) ===");
eq("lev('nilzete','niuzete') = 1", levenshtein("nilzete", "niuzete"), 1);
eq("lev early-exit acima do teto", levenshtein("abcdefgh", "zyxwvuts", 2) > 2, true);
eq("tokenSim recupera typo de 1 letra no meio", tokenSim("nilzete", "niuzete") >= 0.8, true);
eq("nameScore('Nilzete','Niuzete Fialho') ≥ 0.75 (antes: 0.67 → not_found)", nameScore("Nilzete", "Niuzete Fialho") >= 0.75, true);
eq("regressão caso-âncora H45 ('fernanada' typo)", nameScore("Fernanda Lira", "fernanada lira") >= 0.85, true);
eq("nomes curtos NÃO casam via lev ('ana'×'ada')", tokenSim("ana", "ada") < 0.5, true);
eq("nomes diferentes seguem baixos", nameScore("Carlos", "Roberta Souza") < 0.5, true);

console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
