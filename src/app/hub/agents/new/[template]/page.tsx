import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { AgentWizard, type WizardTemplate } from "./agent-wizard";

export const dynamic = "force-dynamic";

const VALID: WizardTemplate[] = ["sales", "recruitment", "custom"];

export default async function AgentWizardPage({ params }: { params: Promise<{ template: string }> }) {
  const session = await getSession();
  if (!session) redirect("/");
  const { template } = await params;
  if (!VALID.includes(template as WizardTemplate)) redirect("/hub/agents/new");
  return <AgentWizard template={template as WizardTemplate} />;
}
