import { NextRequest, NextResponse } from "next/server";

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
    return NextResponse.next();
  }

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
