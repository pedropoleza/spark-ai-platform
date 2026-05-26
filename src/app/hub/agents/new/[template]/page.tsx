import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { AgentWizard, type WizardTemplate } from "./agent-wizard";

export const dynamic = "force-dynamic";

const VALID: WizardTemplate[] = ["sales", "recruitment", "custom"];
// Venda/recrutamento são 1 por location (UNIQUE). Se já existe, manda direto
// pra config dele em vez de deixar a pessoa preencher o wizard e tomar 409.
const SINGLETON_TYPE: Record<string, string> = { sales: "sales_agent", recruitment: "recruitment_agent" };

export default async function AgentWizardPage({ params }: { params: Promise<{ template: string }> }) {
  const session = await getSession();
  if (!session) redirect("/");
  const { template } = await params;
  if (!VALID.includes(template as WizardTemplate)) redirect("/hub/agents/new");

  const singletonType = SINGLETON_TYPE[template];
  if (singletonType) {
    const admin = createAdminClient();
    const { data: existing } = await admin
      .from("agents")
      .select("id")
      .eq("location_id", session.locationId)
      .eq("type", singletonType)
      .limit(1);
    if (existing && existing.length > 0) redirect(`/hub/agents/${existing[0].id}`);
  }

  return <AgentWizard template={template as WizardTemplate} />;
}
