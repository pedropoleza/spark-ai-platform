/**
 * Auth helper centralizado pra endpoints /api/cron/* e /api/agents/process-batch.
 *
 * Antes (review 2026-04-28 C4): cada endpoint duplicava o check
 * `authHeader !== 'Bearer ${cronSecret}'`. Migration 00032 tinha o secret
 * HARDCODED em git (commit 753b6a1). Rotacionado em 00041 — este helper
 * rejeita explicitamente o valor antigo se alguém tentar usar.
 *
 * Uso:
 *   import { isAuthorizedCron } from "@/lib/utils/cron-auth";
 *   export async function GET(request: NextRequest) {
 *     if (!isAuthorizedCron(request)) {
 *       return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
 *     }
 *     ...
 *   }
 */

import type { NextRequest } from "next/server";

/**
 * Valor antigo conhecido (queimado em commit 753b6a1, exposto em git history
 * + migration 00032 + STATUS.md). Após rotação em 00041, qualquer Bearer
 * com este valor é rejeitado mesmo que CRON_SECRET local ainda contenha
 * (defesa em profundidade).
 */
const KNOWN_LEAKED_SECRETS = new Set([
  "spark-cron-secret-2026",
]);

/**
 * Valida o header Authorization. Aceita também o header `x-vercel-cron`
 * (Vercel injeta esse em chamadas internas do Vercel Cron — sem precisar
 * passar Bearer). Se ambos estão ausentes, rejeita.
 */
export function isAuthorizedCron(request: NextRequest): boolean {
  // Vercel Cron interno
  if (request.headers.get("x-vercel-cron")) {
    return true;
  }

  const authHeader = request.headers.get("authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;

  const provided = authHeader.slice("Bearer ".length).trim();
  if (!provided) return false;

  // Defesa: secret antigo conhecido nunca é aceito mesmo que ENV esteja
  // desatualizado (force operadores a rotacionar).
  //
  // Override transitório: se ALLOW_LEAKED_CRON_SECRET=1, aceita o antigo
  // com warning loud. Use APENAS durante deploy da rotação (até atualizar
  // CRON_SECRET no Vercel + app.cron_secret GUC no Supabase). Remover essa
  // env var assim que a rotação completar.
  if (KNOWN_LEAKED_SECRETS.has(provided)) {
    if (process.env.ALLOW_LEAKED_CRON_SECRET === "1") {
      console.warn(
        "[cron-auth] ⚠️  Aceitando secret VAZADO (ALLOW_LEAKED_CRON_SECRET=1). " +
        "REMOVA essa env var assim que terminar a rotação do CRON_SECRET.",
      );
      // Compara mesmo assim com expected pra ainda validar — fail-safe:
      // se ambos baterem (env e leaked), aceita; senão, ainda rejeita.
    } else {
      console.error(
        "[cron-auth] Rejected request with KNOWN-LEAKED secret. " +
        "Rotate CRON_SECRET (Vercel) and app.cron_secret GUC (Supabase) ASAP. " +
        "Pra emergência, set ALLOW_LEAKED_CRON_SECRET=1 no Vercel.",
      );
      return false;
    }
  }

  const expected = process.env.CRON_SECRET?.trim();
  if (!expected) {
    console.error("[cron-auth] CRON_SECRET env var não configurada");
    return false;
  }

  // Comparação constante-time pra evitar timing attack (mesmo que diferença
  // de poucos ns seja improvável de ser explorada via internet).
  if (provided.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < provided.length; i++) {
    mismatch |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}
