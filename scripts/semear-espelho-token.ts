/**
 * Semeia o espelho `ghl_company_tokens` (H93) a partir da "Token Refresher".
 *
 * POR QUE EXISTE: o espelho só se preenchia no backfill de uma LEITURA bem
 * sucedida do projeto doente — e é justamente a leitura que está falhando. O
 * espelho ficou vazio, então o fallback caiu no original toda vez e a plataforma
 * seguiu amarrada ao projeto que o H93 queria justamente tirar do caminho.
 *
 * O PostgREST de lá responde de forma intermitente (schema cache / timeout de
 * conexão), então aqui insistimos: basta UMA leitura boa pra plataforma
 * desacoplar de vez. O token nunca passa por terminal nenhum — só é copiado.
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
import { createClient } from "@supabase/supabase-js";
import { gravarTokenEspelho } from "@/lib/ghl/company-token-store";

const TENTATIVAS = Number(process.env.TENTATIVAS ?? 40);

/** Timeout curto de propósito: o projeto doente pendura a conexão por ~130s
 *  antes de desistir sozinho. Sem teto por tentativa, a insistência não cicla. */
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS ?? 6000);
const tok = createClient(
  (process.env.GHL_TOKEN_SUPABASE_URL ?? "").trim(),
  (process.env.GHL_TOKEN_SUPABASE_SERVICE_KEY ?? "").trim(),
  {
    global: {
      fetch: (input: any, init: any = {}) =>
        fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
    },
  },
);
const main = createClient(
  (process.env.NEXT_PUBLIC_SUPABASE_URL ?? "").trim(),
  (process.env.SUPABASE_SERVICE_ROLE_KEY ?? "").trim(),
);

function expDoJwt(jwt: string): number | null {
  try {
    const p = JSON.parse(Buffer.from(jwt.split(".")[1], "base64").toString());
    return typeof p.exp === "number" ? p.exp * 1000 : null;
  } catch { return null; }
}

(async () => {
  let linha: Record<string, any> | null = null;
  for (let i = 1; i <= TENTATIVAS && !linha; i++) {
    const t0 = Date.now();
    try {
      const { data, error } = await tok.from("Token Refresher").select("*").limit(1);
      if (!error && data?.[0]) { linha = data[0]; console.log(`tentativa ${i}: OK em ${Date.now()-t0}ms`); break; }
      console.log(`tentativa ${i}: ${Date.now()-t0}ms — ${error?.message ?? "sem linha"}`);
    } catch (e: any) { console.log(`tentativa ${i}: ${Date.now()-t0}ms — EXCEPTION ${e.message}`); }
    await new Promise(r => setTimeout(r, 800));
  }
  if (!linha) { console.error("\nNENHUMA leitura passou. Espelho segue vazio."); process.exit(1); }

  const companyId = linha.companyId ?? linha.company_id;
  const exp = expDoJwt(linha.access_token);
  console.log(`\ncompany=${companyId}`);
  console.log(`access_token: ${linha.access_token.length} chars, exp=${exp ? new Date(exp).toISOString() : "?"} (${exp ? ((exp-Date.now())/36e5).toFixed(1) : "?"}h)`);
  console.log(`refresh_token: ${linha.refresh_token.length} chars`);
  console.log(`updated_at origem: ${linha.updated_at}`);

  // H93 (2026-09-21): passa pelo store, com a guarda. Este script COPIA a linha
  // da tabela antiga, que pode estar ATRASADA — e foi exatamente uma cópia
  // dessas que sobrescreveu um par recém-rotacionado e queimou a rotação.
  // A guarda compara o `iat` do access_token (assinado pelo GHL), não o
  // updated_at da linha, porque os escritores carimbam essa coluna com
  // semânticas diferentes. Há também um trigger no banco como última linha.
  let error: { message: string } | null = null;
  try {
    await gravarTokenEspelho(companyId, {
      access_token: linha.access_token,
      refresh_token: linha.refresh_token,
      token_type: linha.token_type,
      expires_in: linha.expires_in,
      scope: linha.scope,
      userType: linha.userType,
      userId: linha.userId,
      refreshTokenId: linha.refreshTokenId,
      isBulkInstallation: linha.isBulkInstallation ? String(linha.isBulkInstallation) : null,
      updated_at: linha.updated_at,
    }, { somenteSeMaisNovo: true });
  } catch (e: any) {
    error = { message: e?.message ?? String(e) };
  }

  if (error) { console.error("FALHA ao gravar espelho:", error.message); process.exit(1); }
  const { data: v } = await main.from("ghl_company_tokens").select("company_id,expires_in,updated_at").eq("company_id", companyId).maybeSingle();
  console.log("\nESPELHO GRAVADO:", JSON.stringify(v));
})();
