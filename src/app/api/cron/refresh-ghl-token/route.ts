/**
 * Cron endpoint — refresh de todos os GHL company tokens.
 *
 * Pedro 2026-05-17: migra refresh do n8n pra Vercel cron. Roda 1x/dia
 * (1AM ET, configurado em vercel.json). Tokens duram 24h, refresh em
 * <24h mantém sempre válido.
 *
 * Segurança: requer header `Authorization: Bearer <CRON_SECRET>` ou
 * `x-vercel-cron: 1` (header automático do Vercel Cron).
 *
 * Idempotente — pode rodar várias vezes sem problema (cada call dá novo
 * par access+refresh).
 */

import { NextResponse } from "next/server";
import { refreshAllCompanyTokens } from "@/lib/ghl/token-refresher";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  // Vercel Cron automaticamente seta esse header
  if (req.headers.get("x-vercel-cron") === "1") return true;
  // Fallback: bearer secret
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  return auth === expected && expected !== "Bearer ";
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startTs = Date.now();
  try {
    const result = await refreshAllCompanyTokens();
    const durationMs = Date.now() - startTs;
    console.log(
      `[cron:refresh-ghl-token] ${result.refreshed}/${result.total} refreshed, ` +
        `${result.failed} failed in ${durationMs}ms`,
    );
    return NextResponse.json({
      ok: true,
      total: result.total,
      refreshed: result.refreshed,
      failed: result.failed,
      failures: result.failures,
      duration_ms: durationMs,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron:refresh-ghl-token] FATAL:", msg);
    return NextResponse.json(
      { ok: false, error: msg, duration_ms: Date.now() - startTs },
      { status: 500 },
    );
  }
}

// Permite POST também (alguns schedulers preferem)
export async function POST(req: Request) {
  return GET(req);
}
