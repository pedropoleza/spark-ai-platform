/**
 * Gera o link de re-autorização do app no Spark Leads (recovery do apagão H93)
 * e, com o `code` na mão, faz o exchange.
 *
 * Uso:
 *   npx tsx scripts/reauth-exchange-url.ts link <REDIRECT_URI>
 *       → imprime o link pro Pedro abrir (escolhe a AGÊNCIA, não uma location).
 *   npx tsx scripts/reauth-exchange-url.ts trocar <CODE> <REDIRECT_URI>
 *       → troca o code por access+refresh e grava na "Token Refresher".
 *
 * O REDIRECT_URI tem que ser EXATAMENTE um dos cadastrados no app no
 * Marketplace (My Apps → o app → Advanced Settings → Auth → Redirect URLs).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

const SB = process.env.GHL_TOKEN_SUPABASE_URL!;
const KEY = process.env.GHL_TOKEN_SUPABASE_SERVICE_KEY!;

/** O projeto de tokens anda instável — insiste até ler. */
async function lerScope(): Promise<string> {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${SB}/rest/v1/Token%20Refresher?select=scope`, {
        headers: { apikey: KEY, Authorization: `Bearer ${KEY}` },
        signal: AbortSignal.timeout(6000),
      });
      if (!r.ok) continue;
      const j = await r.json();
      if (j[0]?.scope) return j[0].scope as string;
    } catch { /* projeto saturado — tenta de novo */ }
  }
  throw new Error("não consegui ler o scope salvo");
}

async function main() {
  const modo = (process.argv[2] || "link").toLowerCase();
  const clientId = process.env.GHL_CLIENT_ID!;

  if (modo === "link") {
    const redirect = process.argv[3];
    if (!redirect) { console.error("uso: link <REDIRECT_URI>"); process.exit(1); }
    const scope = await lerScope();
    const url =
      "https://marketplace.gohighlevel.com/oauth/chooselocation" +
      `?response_type=code&client_id=${encodeURIComponent(clientId)}` +
      `&redirect_uri=${encodeURIComponent(redirect)}` +
      `&scope=${encodeURIComponent(scope)}`;
    console.log("\nAbre este link, escolhe a AGÊNCIA (não uma sub-conta) e autoriza:\n");
    console.log(url);
    console.log("\nDepois me manda a URL inteira em que você cair (tem ?code=... nela).\n");
  } else if (modo === "trocar") {
    const code = process.argv[3];
    const redirect = process.argv[4];
    if (!code || !redirect) { console.error("uso: trocar <CODE> <REDIRECT_URI>"); process.exit(1); }
    const { exchangeAuthCode } = await import("@/lib/ghl/token-refresher");
    const t = await exchangeAuthCode({ code, redirectUri: redirect });
    console.log(`✅ companyId ${t.companyId} · expires_in ${t.expires_in}s · gravado na Token Refresher`);
  } else {
    console.error("modos: link | trocar");
    process.exit(1);
  }
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
