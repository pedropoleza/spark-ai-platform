import Link from "next/link";
import { redirect } from "next/navigation";
import { Plus } from "lucide-react";
import { getSession } from "@/lib/auth/sso";
import { loadHubAgents } from "@/lib/hub/data";
import { AgentsList } from "./agents-list";

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const agents = await loadHubAgents(session.locationId);

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Agentes</h1>
          <p className="page-hd__sub">O SparkBot conversa com você. Os outros falam com seus leads.</p>
        </div>
        <Link href="/hub/agents/new" className="btn btn--primary btn--lg">
          <Plus /> Novo agente
        </Link>
      </div>

      <AgentsList agents={agents} />
    </div>
  );
}
