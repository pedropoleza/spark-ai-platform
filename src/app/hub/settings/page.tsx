import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { SettingsForm } from "./settings-form";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const supabase = createAdminClient();
  // F30 (Pedro 2026-05-28): daily_message_limit/cost_alert_threshold removidos
  // do select — eram dead-write. Colunas DB ficam (retrocompat) mas UI/runtime
  // ignoram. Re-introduzir só se ligarmos enforcement real.
  const { data: s } = await supabase
    .from("location_settings")
    .select("default_timezone")
    .eq("location_id", session.locationId)
    .maybeSingle();

  return (
    <SettingsForm
      locationName={session.locationName || "Minha conta"}
      initial={{
        timezone: (s?.default_timezone as string) || "America/New_York",
      }}
    />
  );
}
