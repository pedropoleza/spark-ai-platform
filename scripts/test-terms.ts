/**
 * Golden suite da aceitação de termos (terms.ts) — foco no novo tap por botão
 * + robustez LGPD preservada.
 * Run: npx tsx -r tsconfig-paths/register scripts/test-terms.ts
 */
import { parseTermsResponse, buildTermsInteractive } from "@/lib/account-assistant/terms";

let pass = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: string) {
  total++;
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Tap "Aceito" chega amarrado à pergunta (termos cheios de "não"). O strip do
// sufixo evita que os "não" do texto disparem REJECT.
const boundAccept =
  'Aceito ✅ — (resposta à pergunta: "Topa começar? Não mando nada pro cliente sem confirmar, não apago nada")';
const boundReject =
  'Não aceito ❌ — (resposta à pergunta: "Topa começar? Acesso seus dados respeitando permissões")';

check("tap 'Aceito ✅' (quote com vários 'não') → accept", parseTermsResponse(boundAccept) === "accept", parseTermsResponse(boundAccept));
check("tap 'Não aceito ❌' → reject", parseTermsResponse(boundReject) === "reject", parseTermsResponse(boundReject));

// Digitado (sem botão) — comportamento legado preservado
check("digitado 'aceito' → accept", parseTermsResponse("aceito") === "accept");
check("digitado 'ok' → accept", parseTermsResponse("ok") === "accept");
check("digitado 'pode' → accept", parseTermsResponse("pode") === "accept");
check("LGPD: 'não' → reject", parseTermsResponse("não") === "reject");
check("LGPD: 'não tá ok pra mim' → reject", parseTermsResponse("não tá ok pra mim") === "reject");
check("LGPD: 'não aceito' → reject", parseTermsResponse("não aceito") === "reject");
check("unclear: 'talvez depois' → unclear", parseTermsResponse("talvez depois") === "unclear");
check("unclear: vazio → unclear", parseTermsResponse("") === "unclear");

// Payload do botão de termos
const t = buildTermsInteractive();
check("termos: kind=buttons", t.kind === "buttons");
check("termos: 2 opções", t.options.length === 2);
check("termos: ids terms_accept/terms_reject", t.options[0].id === "terms_accept" && t.options[1].id === "terms_reject");
check("termos: body não-vazio", t.body.length > 50);

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
