/**
 * Testes da ativação por CUSTOM FIELD (pedido do Marcos / Alves Cury 2026-07-28):
 * o rep abre o contato no app do celular, escolhe o valor no dropdown do campo
 * "AI" e a IA passa a atender (ou para) aquele lead na próxima mensagem.
 *
 * Campo real da conta: id C7LzKTXG3QHJuzfqOi9T, opções
 * Venda / Recruit / Prospecção / Follow-up / Off.
 *
 * Rodar: npx tsx scripts/test-ativacao-campo-ai.ts
 */
import { evaluateTargetingSet, normalizeTargeting } from "../src/lib/queue/targeting";
import type { TargetingRuleSet } from "../src/types/agent";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const AI_FIELD = "C7LzKTXG3QHJuzfqOi9T";
const AD_SALES = "Moro nos EUA e gostaria de mais informações sobre o seguro com beneficio em vida";

// Config EXATA aplicada em prod pra Bruna (vendas).
const BRUNA: TargetingRuleSet = {
  version: 2,
  match: "any",
  groups: [
    {
      id: "g-anuncio-venda",
      match: "all",
      rules: [{ id: "ac-sales", type: "message", message_operator: "contains", message_value: AD_SALES }],
    },
    {
      id: "g-campo-ai",
      match: "all",
      rules: [{ id: "ac-cf-venda", type: "custom_field", custom_field_key: AI_FIELD, custom_field_value: "Venda" }],
    },
  ],
};

const contato = (aiValue?: string) => ({
  id: "c1",
  tags: [],
  customFields: aiValue ? [{ id: AI_FIELD, value: aiValue }] : [],
});

console.log("\nAtivação pelo dropdown do campo AI (o rep liga pelo celular)");
check(
  "campo AI = 'Venda' + mensagem QUALQUER → IA atende (era o pedido)",
  evaluateTargetingSet(BRUNA, contato("Venda"), [], { messageText: "oi, tudo bem?" }) === true,
);
check(
  "campo AI = 'Venda' + lead mandou ÁUDIO → IA atende (antes caía fora)",
  evaluateTargetingSet(BRUNA, contato("Venda"), [], { messageText: "[audio]" }) === true,
);
check(
  "campo AI = 'Venda' + lead mandou FOTO → IA atende",
  evaluateTargetingSet(BRUNA, contato("Venda"), [], { messageText: "[media]" }) === true,
);
check(
  "campo AI = 'Venda' + emoji solto → IA atende",
  evaluateTargetingSet(BRUNA, contato("Venda"), [], { messageText: "😂" }) === true,
);

console.log("\nO caminho antigo (anúncio) continua valendo");
check(
  "sem o campo + texto do anúncio → IA atende (não regrediu)",
  evaluateTargetingSet(BRUNA, contato(), [], { messageText: AD_SALES }) === true,
);
check(
  "sem o campo + texto do anúncio EM ESPANHOL do mesmo criativo → NÃO atende (só pelo campo)",
  evaluateTargetingSet(BRUNA, contato(), [], { messageText: "Hola, quiero información del seguro" }) === false,
);

console.log("\nOutros valores do dropdown não ligam o agente de VENDAS");
for (const v of ["Recruit", "Prospecção", "Follow-up", "Off"]) {
  check(
    `campo AI = '${v}' + mensagem qualquer → agente de vendas NÃO atende`,
    evaluateTargetingSet(BRUNA, contato(v), [], { messageText: "oi" }) === false,
  );
}

console.log("\nRegras normalizam corretamente");
const norm = normalizeTargeting(BRUNA);
check("2 grupos combinados por 'any' (OU)", norm?.groups.length === 2 && norm?.match === "any");

console.log("\n⚠️  'Off' NÃO é tratado aqui: quem desliga é deactivation_rules");
check(
  "campo AI = 'Off' + texto do anúncio → targeting ainda casa (por isso existe a regra de desativação)",
  evaluateTargetingSet(BRUNA, contato("Off"), [], { messageText: AD_SALES }) === true,
);
console.log(
  "     (deactivation_rules custom_field_equals AI='Off' roda no webhook ANTES de enfileirar)",
);

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
