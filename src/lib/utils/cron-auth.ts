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
  if (KNOWN_LEAKED_SECRETS.has(provided)) {
    console.error(
      "[cron-auth] Rejected request with KNOWN-LEAKED secret. " +
      "Rotate CRON_SECRET (Vercel) and app.cron_secret GUC (Supabase) ASAP.",
    );
    return false;
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
