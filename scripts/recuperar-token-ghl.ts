/**
 * Recupera o company token do Spark Leads quando o projeto "GHL Token" está
 * ilegível, semeando o ESPELHO (H93) no banco principal.
 *
 * QUANDO USAR: a "Token Refresher" tem um par VÁLIDO, mas o PostgREST daquele
 * projeto não responde (instância saturada) — então nem o caminho quente nem o
 * self-heal conseguem ler, e a plataforma inteira fica muda com
 * "Token nao encontrado para companyId". O espelho é o caminho de saída, mas
 * ele só se preenchia no backfill de uma leitura BEM SUCEDIDA — que é justo o
 * que não acontece. Este script quebra esse impasse.
 *
 * COMO: recebe o refresh_token por variável de ambiente (lido de fora, pelo
 * plano de controle), TROCA ele por um par novo no GHL e grava o par NOVO no
 * espelho. Não guarda o token recebido em lugar nenhum: o refresh_token do GHL
 * é de USO ÚNICO, então o valor que passou por aqui morre no próprio exchange.
 *
 *   REFRESH_TOKEN='...' COMPANY_ID='...' npx tsx scripts/recuperar-token-ghl.ts
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
import { createClient } from "@supabase/supabase-js";
import { gravarTokenEspelho } from "@/lib/ghl/company-token-store";

const refreshToken = process.env.REFRESH_TOKEN ?? "";
const companyId = process.env.COMPANY_ID ?? "TdmQMjj86Y3LgppiB96K";
if (!refreshToken) { console.error("faltou REFRESH_TOKEN"); process.exit(1); }

const main = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim(),
);

(async () => {
  const clientId = (process.env.GHL_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.GHL_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) { console.error("faltou GHL_CLIENT_ID/SECRET no env"); process.exit(1); }

  const base = (process.env.GHL_API_BASE ?? "https://services.leadconnectorhq.com").trim();
  console.log("trocando refresh_token por par novo no GHL...");
  const r = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret,
      grant_type: "refresh_token", refresh_token: refreshToken, user_type: "Company",
    }),
  });
  if (!r.ok) { console.error(`exchange FALHOU: ${r.status} — ${(await r.text()).slice(0,300)}`); process.exit(1); }
  const t: any = await r.json();
  if (!t.access_token || !t.refresh_token) { console.error("resposta sem par completo:", Object.keys(t)); process.exit(1); }

  const p = JSON.parse(Buffer.from(t.access_token.split(".")[1], "base64").toString());
  console.log(`par NOVO recebido. access exp=${new Date(p.exp*1000).toISOString()} (${((p.exp*1000-Date.now())/36e5).toFixed(1)}h)`);

  // H93 (2026-09-21): passa pelo store — que também invalida o cache em memória
  // do company token. SEM `somenteSeMaisNovo`, de propósito: aqui o GHL ACABOU
  // de emitir o par e esta variável é a ÚNICA cópia dele no mundo (refresh_token
  // é de uso único). Recusar esta escrita destruiria a credencial; e o par é o
  // mais novo por definição, então nem a guarda nem o trigger barram.
  let error: { message: string } | null = null;
  try {
    await gravarTokenEspelho(companyId, {
      access_token: t.access_token,
      refresh_token: t.refresh_token,
      token_type: t.token_type ?? null,
      expires_in: t.expires_in ?? null,
      scope: t.scope ?? null,
      userType: t.userType ?? "Company",
      userId: t.userId ?? null,
      refreshTokenId: t.refreshTokenId ?? null,
      isBulkInstallation: t.isBulkInstallation ? String(t.isBulkInstallation) : null,
      updated_at: new Date().toISOString(),
    });
  } catch (e: any) {
    error = { message: e?.message ?? String(e) };
  }
  if (error) { console.error("FALHA gravando espelho:", error.message); process.exit(1); }

  const { data: v } = await main.from("ghl_company_tokens").select("company_id,expires_in,updated_at").eq("company_id", companyId).maybeSingle();
  console.log("ESPELHO SEMEADO:", JSON.stringify(v));
  console.log("o refresh_token usado aqui já foi CONSUMIDO pelo GHL (uso único) — não vale mais nada.");
})();
