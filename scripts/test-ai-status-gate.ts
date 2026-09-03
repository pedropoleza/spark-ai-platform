/**
 * Gate "AI Status / Follow Up Status: Inactive" (caso Márcia, 2026-09-03).
 *
 * A equipe desliga a IA de um lead marcando o picklist no cadastro do contato.
 * O runtime nunca lia esses campos: 42 dos 104 contatos respondidos em 7 dias
 * estavam Inactive (233 mensagens indevidas).
 *
 * Rodar: npx tsx scripts/test-ai-status-gate.ts
 */
import {
  ehInativo,
  valorDoCampo,
  iaDesligadaNoContato,
  followUpDesligadoNoContato,
  type IdsDosCampos,
} from "@/lib/queue/ai-status-gate";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean, extra = "") => {
  if (cond) { pass++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome} ${extra}`); }
};

// ids reais da conta da Márcia
const IDS: IdsDosCampos = { aiStatusId: "EVbZXt7c2AM5dqI9DTcb", followUpStatusId: "8GEZVnksuW7YlcMzX2Kb" };
const campos = (ai?: string, fu?: string) => [
  ...(fu !== undefined ? [{ id: "8GEZVnksuW7YlcMzX2Kb", value: fu }] : []),
  ...(ai !== undefined ? [{ id: "EVbZXt7c2AM5dqI9DTcb", value: ai }] : []),
  { id: "jbtzPbXxa5vqXiON9GrK", value: "não" }, // fumante, ruído
];

console.log("\n1) O caso real (Marilene, +1 305 363-9705)");
ok("AI=Inactive → IA desligada", iaDesligadaNoContato(campos("Inactive", "Inactive"), IDS));
ok("Follow Up=Inactive → follow-up desligado", followUpDesligadoNoContato(campos("Inactive", "Inactive"), IDS));

console.log("\n2) Só bloqueia com Inactive EXPLÍCITO (fail-open)");
ok("Active → responde", !iaDesligadaNoContato(campos("Active", "Active"), IDS));
ok("campo ausente → responde", !iaDesligadaNoContato(campos(undefined, undefined), IDS));
ok("valor vazio → responde", !iaDesligadaNoContato(campos(""), IDS));
ok("customFields undefined → responde", !iaDesligadaNoContato(undefined, IDS));
ok("location sem os campos (ids vazios) → responde", !iaDesligadaNoContato(campos("Inactive"), {}));

console.log("\n3) Os dois campos são independentes");
ok("AI=Inactive não desliga o follow-up sozinho", !followUpDesligadoNoContato(campos("Inactive", "Active"), IDS));
ok("Follow Up=Inactive não cala a IA no inbound", !iaDesligadaNoContato(campos("Active", "Inactive"), IDS));

console.log("\n4) Robustez do valor");
ok("'inactive' minúsculo conta", ehInativo("inactive"));
ok("' Inactive ' com espaço conta", ehInativo(" Inactive "));
ok("'Inativo' (pt) NÃO conta — o picklist é em inglês", !ehInativo("Inativo"));
ok("null → false", !ehInativo(null));
ok("valorDoCampo acha por id", valorDoCampo(campos("Inactive"), IDS.aiStatusId) === "Inactive");
ok("valorDoCampo com id errado → undefined", valorDoCampo(campos("Inactive"), "xxx") === undefined);

console.log(`\n${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
