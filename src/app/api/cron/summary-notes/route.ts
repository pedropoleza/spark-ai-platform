import { NextRequest, NextResponse } from "next/server";
import { processInactivitySummaries } from "@/lib/queue/summary-note-generator";

export const maxDuration = 60;

export async function GET(request: NextRequest) {
  const authHeader = request.headers.get("authorization");
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
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
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro" },
      { status: 500 }
    );
  }
}
