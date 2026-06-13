/**
 * Recovery do token de empresa GHL (Pedro 2026-06-13, apagão de auth).
 *
 * Modos:
 *   refresh                 → 1 refresh LIMPO e serializado do refresh_token salvo
 *                             (mesma coisa que o self-heal, mas 1× sem concorrência).
 *                             Sucesso = recuperou na hora. Falha = mostra o erro EXATO
 *                             do GHL (invalid_grant = refresh_token morto → re-auth;
 *                             invalid_client = GHL_CLIENT_SECRET do env não bate).
 *   exchange <code> <uri>   → troca um authorization_code novo (após re-autorizar o
 *                             app na agência) por access+refresh e grava na tabela.
 *
 * Uso:
 *   npx tsx -r tsconfig-paths/register scripts/reauth-ghl-company-token.ts refresh
 *   npx tsx -r tsconfig-paths/register scripts/reauth-ghl-company-token.ts exchange <CODE> <REDIRECT_URI>
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { refreshCompanyToken, exchangeAuthCode } from "../src/lib/ghl/token-refresher";

const COMPANY = "TdmQMjj86Y3LgppiB96K";

async function main() {
  const mode = (process.argv[2] || "refresh").toLowerCase();
  console.log(`app no env (GHL_CLIENT_ID): ${(process.env.GHL_CLIENT_ID || "(vazio)").slice(0, 32)}`);

  if (mode === "refresh") {
    try {
      const t = await refreshCompanyToken(COMPANY);
      console.log(`\n✅ REFRESH OK — token renovado e gravado na "Token Refresher".`);
      console.log(`   expires_in: ${t.expires_in}s  | refresh_token novo: ${t.refresh_token ? "sim" : "NÃO"}  | scope len: ${(t.scope || "").length}`);
      console.log(`   >> A integração deve voltar em segundos (o cache de token invalida no próximo 401).`);
    } catch (e) {
      console.error(`\n❌ REFRESH FALHOU:\n   ${e instanceof Error ? e.message : e}`);
      console.error(`\n   → Se for "invalid_grant": o refresh_token do app ${(process.env.GHL_CLIENT_ID || "").slice(0,24)} está REVOGADO. Precisa RE-AUTORIZAR (modo exchange).`);
      console.error(`   → Se for "invalid_client": o GHL_CLIENT_SECRET do env não bate com esse app. Corrigir o secret antes.`);
    }
  } else if (mode === "exchange") {
    const code = process.argv[3];
    const redirectUri = process.argv[4] || process.env.GHL_OAUTH_REDIRECT_URI || "";
    if (!code || !redirectUri) {
      console.error("uso: exchange <CODE> <REDIRECT_URI>  (o redirect_uri tem que ser EXATAMENTE um dos registrados no app)");
      process.exit(1);
    }
    try {
      const t = await exchangeAuthCode({ code, redirectUri });
      console.log(`\n✅ EXCHANGE OK — companyId: ${t.companyId} | expires_in: ${t.expires_in}s | bulk: ${t.isBulkInstallation}`);
      console.log(`   Token novo gravado na "Token Refresher". Integração recuperada.`);
    } catch (e) {
      console.error(`\n❌ EXCHANGE FALHOU:\n   ${e instanceof Error ? e.message : e}`);
    }
  } else {
    console.error(`modo desconhecido: ${mode} (use 'refresh' ou 'exchange')`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
