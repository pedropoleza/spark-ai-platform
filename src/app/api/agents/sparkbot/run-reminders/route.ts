import { NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { fireScheduledReminders } from "@/lib/account-assistant/proactive/reminder-runner";
import { unauthorized } from "@/lib/utils/api";

/**
 * POST /api/agents/sparkbot/run-reminders
 *
 * Roda manualmente o reminder runner. Útil em V2 simulated pra testar sem
 * esperar o cron diário (Hobby plan da Vercel). Mesmo código que o cron
 * automático chama, mas exposto pra admin.
 */
export async function POST() {
  const session = await getSession();
  if (!session) return unauthorized();

  const startTs = Date.now();
  const result = await fireScheduledReminders();
  return NextResponse.json({
    ...result,
    duration_ms: Date.now() - startTs,
  });
}
