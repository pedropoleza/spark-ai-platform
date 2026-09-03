/**
 * H89 — "Regras de desligamento" decididas num lugar só (webhook, processor,
 * runner). Caso Márcia 2026-09-03: "AI Status: Inactive" no cadastro.
 *
 * Rodar: npx tsx scripts/test-deactivation.ts
 */
import { regraQueDesliga, descreveRegra } from "@/lib/queue/deactivation";
import type { DeactivationRule } from "@/types/agent";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); } else { fail++; console.log(`  ❌ ${nome} ${extra}`); }
};

// ids reais da conta da Márcia
const AI_STATUS = "EVbZXt7c2AM5dqI9DTcb";
const REGRAS_MARCIA: DeactivationRule[] = [
  { id: "ai-off", type: "custom_field_equals", field_key: AI_STATUS, field_value: "Inactive" },
  { id: "t1", type: "tag_added", tag: "cliente" },
  { id: "t2", type: "tag_added", tag: "apólice ativa" },
];
const contato = (ai?: string, tags: string[] = []) => ({
  tags,
  customFields: [
    ...(ai !== undefined ? [{ id: AI_STATUS, value: ai }] : []),
    { id: "jbtzPbXxa5vqXiON9GrK", value: "não" }, // fumante, ruído
  ],
});

console.log("\n1) O caso real (Marilene, +1 305 363-9705: AI Status = Inactive)");
ok("desliga pela regra de campo", regraQueDesliga(contato("Inactive"), REGRAS_MARCIA)?.id === "ai-off");
ok("descreve a regra pro log", descreveRegra(REGRAS_MARCIA[0]).includes("Inactive"));

console.log("\n2) Só desliga com match EXATO (fail-open)");
ok("Active → responde", regraQueDesliga(contato("Active"), REGRAS_MARCIA) === null);
ok("campo ausente → responde", regraQueDesliga(contato(undefined), REGRAS_MARCIA) === null);
ok("valor vazio → responde", regraQueDesliga(contato(""), REGRAS_MARCIA) === null);
ok("'inactive' minúsculo NÃO casa (picklist é literal)", regraQueDesliga(contato("inactive"), REGRAS_MARCIA) === null);
ok("sem regras → responde", regraQueDesliga(contato("Inactive"), []) === null);
ok("regras null → responde", regraQueDesliga(contato("Inactive"), null) === null);
ok("contato null → responde", regraQueDesliga(null, REGRAS_MARCIA) === null);
ok("id de campo diferente NÃO casa (nada de sufixo)", regraQueDesliga({ customFields: [{ id: "xxx", value: "Inactive" }] }, REGRAS_MARCIA) === null);

console.log("\n3) Tags (as regras que a conta já tinha)");
ok("tag 'cliente' desliga", regraQueDesliga(contato("Active", ["cliente"]), REGRAS_MARCIA)?.id === "t1");
ok("tag com acento e caixa diferente casa ('Apólice Ativa')", regraQueDesliga(contato("Active", ["Apólice Ativa"]), REGRAS_MARCIA)?.id === "t2");
ok("tag como objeto {name} também", regraQueDesliga({ tags: [{ name: "cliente" }] }, REGRAS_MARCIA)?.id === "t1");
ok("tag_removed: desliga quando a tag NÃO está", regraQueDesliga({ tags: [] }, [{ id: "r", type: "tag_removed", tag: "ativa" }])?.id === "r");
ok("tag_removed: não desliga quando a tag está", regraQueDesliga({ tags: ["ativa"] }, [{ id: "r", type: "tag_removed", tag: "ativa" }]) === null);

console.log("\n4) Shapes do Spark Leads");
ok("customField (legado) também é lido", regraQueDesliga({ customField: [{ id: AI_STATUS, value: "Inactive" }] }, REGRAS_MARCIA)?.id === "ai-off");
ok("casa por fieldKey", regraQueDesliga({ customFields: [{ fieldKey: "contact.ai_status", value: "Inactive" }] }, [{ id: "k", type: "custom_field_equals", field_key: "contact.ai_status", field_value: "Inactive" }])?.id === "k");
ok("regra malformada é ignorada", regraQueDesliga(contato("Inactive"), [null as unknown as DeactivationRule, ...REGRAS_MARCIA])?.id === "ai-off");

console.log(`\n${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
