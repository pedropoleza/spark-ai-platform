/**
 * Cron endpoint pro followup-runner (Pedro 2026-05-18).
 *
 * Chamado pelo Vercel cron a cada 1min (60s). Claim + send até MAX_PER_TICK
 * follow-up messages pending vencidas.
 */

import { NextResponse } from "next/server";
import { runFollowupTick } from "@/lib/account-assistant/proactive/followup-runner";
import { reportError } from "@/lib/admin-signals/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  if (req.headers.get("x-vercel-cron") === "1") return true;
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
    const result = await runFollowupTick();
    const dur = Date.now() - startTs;
    if (result.claimed > 0) {
      console.log(
        `[cron:followup] claimed=${result.claimed} sent=${result.sent} failed=${result.failed} skipped=${result.skipped} completed_seqs=${result.completed_sequences} in ${dur}ms`,
      );
    }
    // F49: envios de follow-up que falharam viram signal (antes só no log).
    if (result.failed > 0) {
      reportError({
        title: "SparkBot: follow-up(s) falharam no envio",
        feature: "followup-runner",
        severity: "high",
        description: `${result.failed} de ${result.claimed} follow-ups falharam no envio neste tick.`,
        metadata: { claimed: result.claimed, sent: result.sent, failed: result.failed, skipped: result.skipped },
      });
    }
    return NextResponse.json({ ok: true, ...result, duration_ms: dur });
  } catch (err) {
    const m = err instanceof Error ? err.message : String(err);
    console.error("[cron:followup] FATAL:", m);
    // F49: crash do runner vira signal + Sentry (antes só console.error → o
    // runner podia estar quebrado por dias sem ninguém saber, ex: F46).
    reportError({
      title: "SparkBot: follow-up runner crashou",
      error: err,
      feature: "followup-runner",
      severity: "critical",
    });
    return NextResponse.json({ ok: false, error: m, duration_ms: Date.now() - startTs }, { status: 500 });
  }
}

export async function POST(req: Request) {
  return GET(req);
}
