import { NextRequest, NextResponse } from "next/server";
import { processMessageQueue } from "@/lib/queue/processor";
import { processScheduledFollowUps } from "@/lib/queue/follow-up-scheduler";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";

export const maxDuration = 60;

export async function POST(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const [queueResult, followUpResult] = await Promise.all([
      processMessageQueue(),
      processScheduledFollowUps(),
    ]);

    return NextResponse.json({
      success: true,
      queue: queueResult,
      followups: followUpResult,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Erro no process-batch:", error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 }
    );
  }
}
