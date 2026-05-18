// Troca um authorization_code GHL por access+refresh tokens e UPSERT
// na Token Refresher table.
//
// Uso:
//   AUTH_CODE=cca91...  REDIRECT_URI=https://...  \
//     npx tsx -r tsconfig-paths/register scripts/exchange-auth-code.ts
//
// Pedro 2026-05-17: usado quando rep gera code novo via marketplace flow.
// O cron daily depois mantém o refresh recorrente.

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { exchangeAuthCode } from "@/lib/ghl/token-refresher";

async function main() {
  const code = process.env.AUTH_CODE || process.argv[2];
  const redirectUri = process.env.REDIRECT_URI || process.argv[3];

  if (!code) {
    console.error("Faltou AUTH_CODE (env var ou 1º arg)");
    process.exit(1);
  }
  if (!redirectUri) {
    console.error("Faltou REDIRECT_URI (env var ou 2º arg)");
    console.error("Esse precisa ser EXATAMENTE o redirect_uri configurado no app GHL Marketplace.");
    process.exit(1);
  }

  console.log(`\n=== Exchange auth code ===`);
  console.log(`Code: ${code.slice(0, 12)}...`);
  console.log(`Redirect URI: ${redirectUri}`);
  console.log("");

  try {
    const tokens = await exchangeAuthCode({ code, redirectUri });
    console.log(`✅ SUCCESS`);
    console.log(`  companyId:      ${tokens.companyId}`);
    console.log(`  userType:       ${tokens.userType}`);
    console.log(`  expires_in:     ${tokens.expires_in}s (~${Math.round(tokens.expires_in / 3600)}h)`);
    console.log(`  access_token:   ${tokens.access_token.slice(0, 30)}...`);
    console.log(`  refresh_token:  ${tokens.refresh_token.slice(0, 30)}...`);
    console.log(`  scope (len):    ${tokens.scope.length} chars`);
    console.log("");
    console.log("UPSERT na Token Refresher feito. Próximo refresh: 1AM ET via cron.");
  } catch (e) {
    console.error(`❌ FAIL: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  }
}

main();
