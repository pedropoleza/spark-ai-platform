import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { loadHubActivity } from "@/lib/hub/data";
import { ActRow } from "@/components/hub/primitives";

export const dynamic = "force-dynamic";

export default async function MessagesPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const activity = await loadHubActivity(session.locationId, 100);

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Mensagens</h1>
          <p className="page-hd__sub">Tudo o que seus agentes de leads fizeram recentemente.</p>
        </div>
      </div>

      <div className="card">
        <div className="card-hd">
          <h3>Atividade</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            {activity.length} {activity.length === 1 ? "evento" : "eventos"}
          </span>
        </div>
        {activity.length === 0 ? (
          <div className="empty">Nenhuma atividade dos agentes de leads ainda.</div>
        ) : (
          <div>
            {activity.map((it, i) => (
              <ActRow key={i} item={it} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
