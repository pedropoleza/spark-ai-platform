/**
 * H93 — o espelho do company token nunca anda pra trás.
 *
 * Reproduz o incidente de 2026-09-21: uma sessão renovou o token e gravou o par
 * novo no espelho; meia hora depois um backfill copiou a linha da tabela antiga
 * por cima. Nada quebrou na hora (o access_token velho ainda valia), mas o
 * refresh_token que veio junto já tinha sido CONSUMIDO — uso único — e a
 * renovação seguinte morreria horas depois, fora de qualquer janela de atenção.
 *
 * Roda contra o banco real numa company de teste e limpa no fim.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

let ok = 0, fail = 0;
function check(nome: string, cond: boolean, extra = "") {
  if (cond) { ok++; console.log(`  ✓ ${nome}`); }
  else { fail++; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ""}`); }
}

async function main() {
  const { lerTokenEspelho, gravarTokenEspelho, listarCompaniesEspelhadas } =
    await import("@/lib/ghl/company-token-store");
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const CO = "__TESTE_ESPELHO_H93__";
  const limpar = () => createAdminClient().from("ghl_company_tokens").delete().eq("company_id", CO);
  await limpar();

  const velho = new Date(Date.now() - 6 * 3600_000).toISOString();
  const novo = new Date(Date.now() - 30 * 60_000).toISOString();

  console.log("=== round-trip ===");
  await gravarTokenEspelho(CO, {
    access_token: "a.b.c", refresh_token: "rt-velho", token_type: "Bearer",
    expires_in: 86399, scope: "contacts.readonly", userType: "Company",
    userId: "u1", refreshTokenId: "rti1", isBulkInstallation: "false", updated_at: velho,
  });
  const r1 = await lerTokenEspelho(CO);
  check("grava e lê todos os campos",
    r1?.access_token === "a.b.c" && r1?.refresh_token === "rt-velho" &&
    r1?.expires_in === 86399 && r1?.userType === "Company" && r1?.refreshTokenId === "rti1");
  check("companyId inexistente devolve null", (await lerTokenEspelho("__NAO_EXISTE__")) === null);
  check("listar traz o companyId", (await listarCompaniesEspelhadas()).some((l) => l.companyId === CO));

  console.log("\n=== renovação (escrita normal) sempre grava ===");
  await gravarTokenEspelho(CO, { access_token: "novo", refresh_token: "rt-novo", expires_in: 86399, updated_at: novo });
  check("par novo entra", (await lerTokenEspelho(CO))?.refresh_token === "rt-novo");

  console.log("\n=== O INCIDENTE: backfill com par ATRASADO ===");
  await gravarTokenEspelho(CO, {
    access_token: "a.b.c", refresh_token: "rt-velho", expires_in: 86399, updated_at: velho,
  }, { somenteSeMaisNovo: true });
  const r2 = await lerTokenEspelho(CO);
  check("backfill NÃO sobrescreve par mais novo", r2?.refresh_token === "rt-novo", r2?.refresh_token);
  check("access_token também intacto", r2?.access_token === "novo", r2?.access_token);

  console.log("\n=== backfill legítimo ===");
  await limpar();
  await gravarTokenEspelho(CO, {
    access_token: "do-legado", refresh_token: "rt-legado", expires_in: 86399, updated_at: velho,
  }, { somenteSeMaisNovo: true });
  check("espelho VAZIO aceita backfill", (await lerTokenEspelho(CO))?.refresh_token === "rt-legado");

  const maisNovoAinda = new Date().toISOString();
  await gravarTokenEspelho(CO, {
    access_token: "mais-novo", refresh_token: "rt-mais-novo", expires_in: 86399, updated_at: maisNovoAinda,
  }, { somenteSeMaisNovo: true });
  check("backfill com par MAIS NOVO passa", (await lerTokenEspelho(CO))?.refresh_token === "rt-mais-novo");

  console.log("\n=== empate não sobrescreve (mesma emissão = mesmo par) ===");
  await gravarTokenEspelho(CO, {
    access_token: "empate", refresh_token: "rt-empate", expires_in: 86399, updated_at: maisNovoAinda,
  }, { somenteSeMaisNovo: true });
  check("updated_at igual → mantém o que está lá", (await lerTokenEspelho(CO))?.refresh_token === "rt-mais-novo");

  await limpar();
  console.log(`\n=== ${ok} passaram, ${fail} falharam ===`);
  process.exit(fail ? 1 : 0);
}
main();
