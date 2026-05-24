// Golden test do gate de entitlement (Plataforma Modular — Fase 0).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-entitlement-gate.ts
//
// Cobre o modelo de negócio (PLANO D6):
//  - SparkBot (account_assistant) é INCLUSO → sempre liberado.
//  - lead-facing (sales/recruitment/custom) é PAGO → exige entitlement OU admin.
//  - flag OFF (default) = log-first: nunca bloqueia, só sinaliza.
//  - flag ON = bloqueia lead-facing sem entitlement.

import { decideEntitlement, capabilityForAgentType } from "@/lib/agent-platform/entitlements";
import type { AgentCapability } from "@/types/agent-platform";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}${detail ? `  — ${detail}` : ""}`);
  }
}

// ── capabilityForAgentType (puro) ──
console.log("— capabilityForAgentType —");
check("account_assistant → null (incluso)", capabilityForAgentType("account_assistant") === null);
check("sales_agent → sales_agent", capabilityForAgentType("sales_agent") === "sales_agent");
check("recruitment_agent → recruitment_agent", capabilityForAgentType("recruitment_agent") === "recruitment_agent");
check("custom_agent → custom_agent", capabilityForAgentType("custom_agent") === "custom_agent");
check("tipo desconhecido → null", capabilityForAgentType("xyz") === null);

// ── decideEntitlement (matriz completa) ──
console.log("\n— decideEntitlement —");
const SALES: AgentCapability = "sales_agent";

// SparkBot (capability null) sempre liberado, em qualquer combinação de flag/admin/ent.
for (const enforced of [false, true]) {
  for (const isAdmin of [false, true]) {
    const d = decideEntitlement({ capability: null, isAdmin, hasActiveEntitlement: false, enforced });
    check(`incluso liberado (enforced=${enforced}, admin=${isAdmin})`, d.allowed && d.reason === "included_free");
  }
}

// Admin sempre pode lead-facing (mesmo sem entitlement, mesmo enforced).
check(
  "admin libera lead-facing sem entitlement (enforced ON)",
  (() => {
    const d = decideEntitlement({ capability: SALES, isAdmin: true, hasActiveEntitlement: false, enforced: true });
    return d.allowed && d.reason === "admin_bypass";
  })(),
);

// Flag OFF (log-first): lead-facing sem entitlement NÃO bloqueia, mas sinaliza.
check(
  "flag OFF + lead sem entitlement → allowed mas log_only_would_block",
  (() => {
    const d = decideEntitlement({ capability: SALES, isAdmin: false, hasActiveEntitlement: false, enforced: false });
    return d.allowed === true && d.reason === "log_only_would_block";
  })(),
);
check(
  "flag OFF + lead COM entitlement → entitled",
  (() => {
    const d = decideEntitlement({ capability: SALES, isAdmin: false, hasActiveEntitlement: true, enforced: false });
    return d.allowed === true && d.reason === "entitled";
  })(),
);

// Flag ON (enforcement): lead-facing sem entitlement BLOQUEIA; com entitlement libera.
check(
  "flag ON + lead sem entitlement → BLOQUEADO",
  (() => {
    const d = decideEntitlement({ capability: SALES, isAdmin: false, hasActiveEntitlement: false, enforced: true });
    return d.allowed === false && d.reason === "no_entitlement";
  })(),
);
check(
  "flag ON + lead COM entitlement → liberado",
  (() => {
    const d = decideEntitlement({ capability: SALES, isAdmin: false, hasActiveEntitlement: true, enforced: true });
    return d.allowed === true && d.reason === "entitled";
  })(),
);

console.log(`\nTOTAL: ${pass}/${pass + fail} passaram${fail > 0 ? ` — ${fail} FALHARAM` : " ✅"}`);
process.exit(fail > 0 ? 1 : 0);
