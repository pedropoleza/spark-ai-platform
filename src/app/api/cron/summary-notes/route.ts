import { NextRequest, NextResponse } from "next/server";
import { processInactivitySummaries } from "@/lib/queue/summary-note-generator";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";
import { reportError } from "@/lib/admin-signals/report-error";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const result = await processInactivitySummaries();
    return NextResponse.json({
      success: true,
      summaries: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("[Cron:SummaryNotes] Error:", error);
    reportError({ title: "Cron summary-notes: crash", feature: "cron-summary-notes", severity: "high", error });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro" },
      { status: 500 }
    );
  }
}
