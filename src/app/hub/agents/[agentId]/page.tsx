import { notFound, redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { loadHubAgentDetail } from "@/lib/hub/data";
import { AgentDetailView } from "./agent-detail-view";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const session = await getSession();
  if (!session) redirect("/");

  const detail = await loadHubAgentDetail(agentId, session.locationId);
  if (!detail) notFound();

  return <AgentDetailView detail={detail} />;
}
