/**
 * H100 — a regra de FUNIL (pipeline_stage) nunca casou: a busca de oportunidades
 * ia em camelCase e a API devolvia 422. Roda contra contatos REAIS da Vergus
 * Finance (caso Cleybart, 07/10/2026). READ-ONLY.
 *
 *   npx tsx scripts/test-targeting-funil.ts
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { checkContactMatchesTargeting, checkContactExclusion } from "../src/lib/queue/targeting";
import type { TargetingRules } from "../src/types/agent";

const LOC = "lUSGtKw9OWla97QEqtrh", CO = "TdmQMjj86Y3LgppiB96K";
const FUNIL = "enhVQCgaSsSfQYv5fneP";            // "Produto"
const NOVO_LEAD = "10f2184f-fc14-473a-9843-1c28b1916a5f";
const OUTRA_ETAPA = "0ac6503f-09ea-4ecd-9c9c-6a1159eece41"; // "Apolice Emitida"
const ANTONIO = "7CpK7uOvJ0UOPxmOPuCx", GUS = "6KBQRW5GFCPTLeUTVJC6", SPARK = "5yUZona4BmGNN5Ln2zTr";
const SEM_OPP = "8tBXDxnZ9OHLnyX1v5dT";

let ok = 0, fail = 0;
const t = (n: string, c: boolean) => { if (c) { ok++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`); } };
const funil = (stage: string) => [{ id: "f", type: "pipeline_stage", pipeline_id: FUNIL, pipeline_stage_id: stage }] as unknown as TargetingRules;
const casa = async (cid: string, r: TargetingRules) => (await checkContactMatchesTargeting(cid, r, CO, LOC, { messageText: "" })).ok;

(async () => {
  console.log("Regra de funil — Produto / Novo Lead");
  t("Antonio (lead de anúncio, está na etapa) → CASA", await casa(ANTONIO, funil(NOVO_LEAD)));
  t("GUS (está na etapa) → CASA", await casa(GUS, funil(NOVO_LEAD)));
  t("contato de teste do Cleybart (está na etapa) → CASA", await casa(SPARK, funil(NOVO_LEAD)));
  t("formato v2 também casa", await casa(ANTONIO, { version: 2, match: "any", groups: [{ id: "g", match: "all", rules: [{ id: "f", type: "pipeline_stage", pipeline_id: FUNIL, pipeline_stage_id: NOVO_LEAD }] }] } as unknown as TargetingRules));

  console.log("\nTem que continuar recusando (prova que avalia, não aprova tudo)");
  t("etapa errada (Apolice Emitida) → NÃO casa", !(await casa(ANTONIO, funil(OUTRA_ETAPA))));
  t("contato sem oportunidade → NÃO casa", !(await casa(SEM_OPP, funil(NOVO_LEAD))));

  console.log("\nExclusão por funil (H97) agora exclui");
  const exc = { version: 2, match: "all", groups: [
    { id: "e", match: "any", rules: [{ id: "t", type: "tag", tag: "ia-ativa" }] },
    { id: "x", match: "all", rules: [{ id: "xf", type: "pipeline_stage", pipeline_id: FUNIL, pipeline_stage_id: NOVO_LEAD, negate: true }] },
  ] } as unknown as TargetingRules;
  const r = await checkContactExclusion(SPARK, exc, CO, LOC, {});
  t("contato na etapa excluída → excluded", r.excluded === true);

  console.log("\nRegra de TAG (a que ele usa hoje) segue igual");
  t("contato de teste com ia-ativa → CASA", await casa(SPARK, [{ id: "a", type: "tag", tag: "ia-ativa" }] as unknown as TargetingRules));
  t("Antonio sem ia-ativa → NÃO casa", !(await casa(ANTONIO, [{ id: "a", type: "tag", tag: "ia-ativa" }] as unknown as TargetingRules)));

  console.log(`\nRESULTADO: ${ok} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
})();
