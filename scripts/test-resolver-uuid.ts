// Teste do resolver de custom-field refs da Filter Engine (NB-9 2026-06-10).
//
// Garante o fix do bug de prod: um slug/fieldKey SEM separador com 18+ chars
// (ex: 'averageannualpremiumrange') agora resolve via SLUG. Antes, o heurístico
// looksLikeGhlUuid (/^[A-Za-z0-9]{18,}$/) o tratava como id já-resolvido, pulava
// o resolver e mandava o slug cru downstream → GHL `customFieldId=<slug>` /
// extractFieldValue por `c.id === ref` devolviam 0 resultados SEM erro.
//
// Cobre: slug≥18 sem separador resolve; id real (24-hex) passa direto; id curto
// (<18) passa direto sem erro espúrio; ref desconhecido → ALIAS_NOT_FOUND (erro
// útil, não zero silencioso); branch de opportunity.customField.
//
// Roda: npx tsx -r tsconfig-paths/register scripts/test-resolver-uuid.ts

import {
  resolveAliases,
  invalidateAll,
  FilterEngineError,
  isLeaf,
} from "@/lib/account-assistant/filter-engine";
import type {
  FilterExpression,
  FilterCondition,
  FilterExecutionContext,
} from "@/lib/account-assistant/filter-engine";

// --- mock GHL client: devolve a lista de CFs conforme ?model= ---
type MockCf = { id: string; fieldKey?: string; name?: string; dataType?: string; model?: string };

// Contact CFs. Note os fieldKeys SEM separador com 18+ chars (vítimas do bug).
const CONTACT_CFS: MockCf[] = [
  // fieldKey de 1 palavra, 25 chars — clássico falso-positivo do regex antigo
  { id: "aBcD1234efGH5678ijKL", fieldKey: "contact.averageannualpremiumrange", name: "Average Annual Premium Range", dataType: "TEXT" },
  // fieldKey sem separador (20 chars) cujo id real é um Mongo ObjectId 24-hex
  { id: "507f1f77bcf86cd799439011", fieldKey: "contact.policyanniversarydate", name: "Policy Anniversary Date", dataType: "DATE" },
  // id curto (<18 chars) — não pode ser tratado como slug e dar erro espúrio
  { id: "cf_short_01", fieldKey: "contact.nickname", name: "Nickname", dataType: "TEXT" },
];

// Opportunity CFs (branch opportunity.customField.)
const OPP_CFS: MockCf[] = [
  { id: "opp1234567890abcdefg", fieldKey: "opportunity.expectedcloserange", name: "Expected Close Range", dataType: "TEXT", model: "opportunity" },
];

function makeGhl(): FilterExecutionContext["ghl_client"] {
  return {
    get: async (_path: string, params?: Record<string, string>) => {
      const list = params?.model === "opportunity" ? OPP_CFS : CONTACT_CFS;
      return { customFields: list };
    },
  } as unknown as FilterExecutionContext["ghl_client"];
}

let locCounter = 0;
function makeCtx(): FilterExecutionContext {
  // location_id único por caso → não há cross-talk de cache entre testes.
  return {
    rep_id: "test-rep",
    location_id: `loc-${++locCounter}`,
    company_id: "test-co",
    ghl_client: makeGhl(),
    consumer_tool: "test",
  };
}

let pass = 0;
let fail = 0;

/** Resolve um leaf e devolve { field, applied } ou { errorCode }. */
async function run(
  expr: FilterCondition,
): Promise<{ field?: string; applied?: Record<string, string>; errorCode?: string }> {
  try {
    const res = await resolveAliases(expr as FilterExpression, makeCtx());
    if (!isLeaf(res.expr)) return { errorCode: "NOT_A_LEAF" };
    return { field: res.expr.field, applied: res.applied };
  } catch (e) {
    if (e instanceof FilterEngineError) return { errorCode: e.code };
    throw e;
  }
}

async function expectField(name: string, input: FilterCondition, wantField: string) {
  const got = await run(input);
  const ok = got.field === wantField;
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   got=${JSON.stringify(got)}\n   wantField=${wantField}`);
  }
}

async function expectErrorCode(name: string, input: FilterCondition, wantCode: string) {
  const got = await run(input);
  const ok = got.errorCode === wantCode;
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   got=${JSON.stringify(got)}\n   wantErrorCode=${wantCode}`);
  }
}

async function main() {
  invalidateAll();

  // 1) slug sem separador ≥18 chars resolve via slug path (o BUG NB-9)
  await expectField(
    "slug sem separador 25 chars resolve via slug (NB-9)",
    { field: "customField.averageannualpremiumrange", op: "eq", value: "10k-20k" },
    "customField.aBcD1234efGH5678ijKL",
  );

  // 2) outro fieldKey sem separador (20 chars) resolve, mesmo apontando pra id 24-hex
  await expectField(
    "fieldKey sem separador 20 chars resolve pro id real",
    { field: "customField.policyanniversarydate", op: "exists", value: null },
    "customField.507f1f77bcf86cd799439011",
  );

  // 3) id real (24-hex Mongo ObjectId) passa direto, sem reescrever
  await expectField(
    "id real 24-hex passa direto",
    { field: "customField.507f1f77bcf86cd799439011", op: "eq", value: "2026-01-01" },
    "customField.507f1f77bcf86cd799439011",
  );

  // 3b) id que passa direto NÃO entra em applied (não é tradução)
  {
    const got = await run({ field: "customField.507f1f77bcf86cd799439011", op: "exists", value: null });
    const hasNoApplied = !got.applied || Object.keys(got.applied).length === 0;
    if (hasNoApplied) {
      pass++;
      console.log("✅ id real não polui applied");
    } else {
      fail++;
      console.log(`❌ id real não polui applied\n   applied=${JSON.stringify(got.applied)}`);
    }
  }

  // 4) id curto (<18 chars), real, passa direto — não cai em ALIAS_NOT_FOUND espúrio
  await expectField(
    "id curto (<18) real passa direto sem erro",
    { field: "customField.cf_short_01", op: "eq", value: "x" },
    "customField.cf_short_01",
  );

  // 5) ref desconhecido (≥18 chars, parecia id pro regex antigo) → ALIAS_NOT_FOUND,
  //    NÃO passa cru downstream (antes virava zero silencioso)
  await expectErrorCode(
    "ref ≥18 chars desconhecido → ALIAS_NOT_FOUND (não zero silencioso)",
    { field: "customField.totallymadeupfieldxyz", op: "eq", value: "x" },
    "ALIAS_NOT_FOUND",
  );

  // 6) opportunity.customField slug sem separador resolve (branch 2a + ?model=opportunity)
  await expectField(
    "opportunity.customField slug sem separador resolve",
    { field: "opportunity.customField.expectedcloserange", op: "eq", value: "Q1" },
    "opportunity.customField.opp1234567890abcdefg",
  );

  console.log(`\nTOTAL: ${pass}/${pass + fail} passaram${fail > 0 ? ` — ${fail} FALHARAM` : " ✅"}`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
