import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const supabase = createAdminClient();
  const { data: s } = await supabase
    .from("location_settings")
    .select("default_timezone, daily_message_limit, cost_alert_threshold")
    .eq("location_id", session.locationId)
    .maybeSingle();

  return (
    <SettingsForm
      locationName={session.locationName || "Minha conta"}
      initial={{
        timezone: (s?.default_timezone as string) || "America/New_York",
        dailyLimit: (s?.daily_message_limit as number | null) ?? null,
        costAlert: (s?.cost_alert_threshold as number | null) ?? null,
      }}
    />
  );
}
