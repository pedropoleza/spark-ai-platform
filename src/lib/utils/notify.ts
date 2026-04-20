import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Notifica erros criticos logando e persistindo no execution_log
 * para visibilidade no dashboard.
 */
export async function notifyCriticalError(context: {
  locationId: string;
  agentId?: string;
  contactId?: string;
  errorType: string;
  message: string;
}): Promise<void> {
  console.error(`[ALERT] ${context.errorType}: ${context.message}`);

  try {
    const supabase = createAdminClient();
    await supabase.from("execution_log").insert({
      location_id: context.locationId,
      agent_id: context.agentId || null,
      contact_id: context.contactId || null,
      action_type: "critical_error",
      action_payload: {
        error_type: context.errorType,
        message: context.message,
        timestamp: new Date().toISOString(),
      },
      success: false,
      error_message: `[${context.errorType}] ${context.message}`,
    });
  } catch (logError) {
    console.error("[notify] Failed to persist critical error:", logError);
  }
}
