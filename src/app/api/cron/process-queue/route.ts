import { NextRequest, NextResponse } from "next/server";
import { processMessageQueue } from "@/lib/queue/queue-processor";
import { processScheduledFollowUps } from "@/lib/queue/follow-up-scheduler";
import { chargeUnbilledRecords } from "@/lib/billing/charge";
import { processInactivitySummaries } from "@/lib/queue/summary-note-generator";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";
import { reportError } from "@/lib/admin-signals/report-error";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [queueResult, followUpResult, billingResult, summaryResult] = await Promise.all([
      processMessageQueue(),
      processScheduledFollowUps(),
      chargeUnbilledRecords(),
      processInactivitySummaries(),
    ]);

    return NextResponse.json({
      success: true,
      queue: queueResult,
      followups: followUpResult,
      billing: billingResult,
      summaries: summaryResult,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Erro no cron:", error);
    // F49: crash do cron de processamento lead-facing (queue + follow-ups +
    // billing + summaries) vira signal + Sentry. Antes só console.error → o
    // pipeline inteiro podia estar parado sem ninguém saber.
    reportError({
      title: "Cron process-queue crashou (queue/followups/billing)",
      error,
      feature: "cron-process-queue",
      severity: "critical",
    });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 }
    );
  }
}
