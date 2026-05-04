/**
 * CORS allowlist centralizado pros endpoints públicos do SparkBot
 * (`/api/sparkbot/*` + `/embed/sparkbot/loader`).
 *
 * ANTES (audit 2026-05-03 HIGH): cada endpoint hardcodava
 * `Access-Control-Allow-Origin: *` — qualquer origem podia bater.
 *
 * AGORA (Pedro 2026-05-04): allowlist baseada em padrão de host. Em prod,
 * só origens conhecidas passam (GHL, white-label sparkleads, próprio app).
 * Em dev, tudo passa pra facilitar testes locais com URLs de mock.
 */

import type { NextRequest } from "next/server";

const ALLOWED_ORIGIN_PATTERNS: RegExp[] = [
  // GHL e domínios derivados (where loader.js executa via Custom JS)
  /^https:\/\/(?:[a-z0-9-]+\.)*gohighlevel\.com$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)*leadconnectorhq\.com$/i,
  /^https:\/\/(?:[a-z0-9-]+\.)*msgsndr\.com$/i,
  // Sparkleads white-label
  /^https:\/\/(?:[a-z0-9-]+\.)*sparkleads\.pro$/i,
  // Próprio app (iframe roda mesmo domínio em prod)
  /^https:\/\/spark-ai-platform\.vercel\.app$/i,
  // Preview deploys do Vercel
  /^https:\/\/spark-ai-platform-[a-z0-9-]+\.vercel\.app$/i,
  // Localhost em dev (qualquer porta)
  /^https?:\/\/localhost(?::\d+)?$/i,
  /^https?:\/\/127\.0\.0\.1(?::\d+)?$/i,
];

export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return false;
  // Em dev permite tudo pra facilitar testes
  if (process.env.NODE_ENV !== "production") return true;
  return ALLOWED_ORIGIN_PATTERNS.some((re) => re.test(origin));
}

/**
 * Retorna headers CORS adequados pra um request. Se Origin do request bate
 * a allowlist, ecoa esse Origin (mais seguro que `*` quando há credentials).
 * Senão, devolve allowlist vazio (browser bloqueia o response cross-origin).
 *
 * Inclui `Vary: Origin` pra cache não servir resposta de uma origem pra outra.
 */
export function corsHeadersFor(
  req: Request | NextRequest,
  methods: string = "GET, POST, OPTIONS",
): Record<string, string> {
  const origin = req.headers.get("origin") || "";
  const allowed = isAllowedOrigin(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": methods,
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}
