import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { loadHubActivity, loadPausedConversations } from "@/lib/hub/data";
import { MessagesView } from "./messages-view";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const [activity, paused] = await Promise.all([
    loadHubActivity(session.locationId, 100),
    loadPausedConversations(session.locationId),
  ]);

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Mensagens</h1>
          <p className="page-hd__sub">Atividade dos seus agentes e conversas pausadas.</p>
        </div>
      </div>

      <MessagesView activity={activity} paused={paused} />
    </div>
  );
}
