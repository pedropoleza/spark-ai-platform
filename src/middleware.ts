import { NextRequest, NextResponse } from "next/server";

// ===== Brute-force alert (defense-in-depth, review 2026-06-05) =====
// O /admin já é protegido por Basic Auth (senha forte) + URL não-divulgada.
// Isto só ADICIONA observabilidade: alerta no Sentry quando uma origem erra a
// senha repetidamente. Contagem in-memory POR INSTÂNCIA edge — ataque real
// gera volume suficiente por instância pra cruzar o threshold; typo ocasional
// não dispara. NUNCA bloqueia nem afeta a decisão de auth (best-effort).
const BRUTE_WINDOW_MS = 5 * 60 * 1000; // 5 min
const BRUTE_THRESHOLD = 5;
const authFailures = new Map<string, { count: number; windowStart: number; alerted: boolean }>();

function clientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    "unknown"
  );
}

function noteAuthFailure(ip: string): void {
  try {
    const now = Date.now();
    // Cap defensivo de memória sob ataque distribuído de muitos IPs.
    if (authFailures.size > 2000) {
      for (const [k, v] of authFailures) {
        if (now - v.windowStart > BRUTE_WINDOW_MS) authFailures.delete(k);
      }
    }
    const cur = authFailures.get(ip);
    if (!cur || now - cur.windowStart > BRUTE_WINDOW_MS) {
      authFailures.set(ip, { count: 1, windowStart: now, alerted: false });
      return;
    }
    cur.count++;
    if (cur.count >= BRUTE_THRESHOLD && !cur.alerted) {
      cur.alerted = true; // 1 alerta por janela (não spamma o Sentry no ataque sustentado)
      void import("@sentry/nextjs")
        .then((Sentry) => {
          Sentry.withScope((scope) => {
            scope.setTag("feature", "admin-auth");
            scope.setLevel("warning");
            scope.setContext("brute_force", { ip, attempts: cur.count, window_min: 5 });
            Sentry.captureMessage("Admin panel: brute-force suspeito (5+ senhas erradas em 5min)");
          });
        })
        .catch(() => { /* Sentry off / sem DSN → no-op */ });
    }
  } catch {
    // Alerta é best-effort; jamais afeta a decisão de auth.
  }
}

/**
 * Pedro 2026-05-04: middleware Basic Auth pro painel /admin/*.
 *
 * Auth via env var ADMIN_PANEL_PASSWORD. Username é qualquer coisa
 * (Basic Auth precisa de algo, mas não validamos). URL não-divulgada
 * (security through obscurity) + Basic Auth = suficiente pra MVP single-tenant.
 *
 * Se ADMIN_PANEL_PASSWORD não setado, painel retorna 503 ('not configured').
 */
export function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Só aplica pra /admin/* (page) e /api/admin/* (API)
  if (!pathname.startsWith("/admin") && !pathname.startsWith("/api/admin")) {
    return NextResponse.next();
  }

  const expectedPassword = process.env.ADMIN_PANEL_PASSWORD?.trim();
  if (!expectedPassword) {
    return new NextResponse(
      JSON.stringify({ error: "ADMIN_PANEL_PASSWORD não configurada no env" }),
      { status: 503, headers: { "Content-Type": "application/json" } },
    );
  }

  const authHeader = request.headers.get("authorization") || "";
  const expectedBasic = `Basic ${Buffer.from(`admin:${expectedPassword}`).toString("base64")}`;
  if (authHeader === expectedBasic) {
    try { authFailures.delete(clientIp(request)); } catch { /* limpa o histórico de falhas no sucesso */ }
    return NextResponse.next();
  }

  noteAuthFailure(clientIp(request));
  return new NextResponse("Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="SparkBot Admin", charset="UTF-8"',
    },
  });
}

export const config = {
  matcher: ["/admin/:path*", "/api/admin/:path*"],
};
