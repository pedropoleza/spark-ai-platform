import Link from "next/link";
import { redirect } from "next/navigation";
import { Zap, ChevronRight, Plus } from "lucide-react";
import { getSession } from "@/lib/auth/sso";
import { KPI, AMark, StatusBadge, PriceBadge, ActRow } from "@/components/hub/primitives";
import { WhatsAppIcon } from "@/components/hub/icons";
import { loadHubAgents, loadHubMetrics, loadHubActivity } from "@/lib/hub/data";

export const dynamic = "force-dynamic";

export default async function HubHome() {
  const session = await getSession();
  if (!session) redirect("/");

  const [metrics, agents, activity] = await Promise.all([
    loadHubMetrics(session.locationId),
    loadHubAgents(session.locationId),
    loadHubActivity(session.locationId, 6),
  ]);

  const activeCount = agents.filter((a) => a.status === "active").length;

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Início</h1>
          <p className="page-hd__sub">
            {agents.length} {agents.length === 1 ? "agente" : "agentes"} · {activeCount} ativo
            {activeCount === 1 ? "" : "s"} · {metrics.activeConversations} conversa
            {metrics.activeConversations === 1 ? "" : "s"} em andamento
          </p>
        </div>
      </div>

      {/* KPIs — todos per-location e reais */}
      <div className="kpi-grid" style={{ marginBottom: 24 }}>
        <KPI lbl="Mensagens (30 dias)" val={metrics.messagesSent30d.toLocaleString("pt-BR")} />
        <KPI lbl="Leads qualificados" val={metrics.leadsQualified} />
        <KPI lbl="Reuniões agendadas" val={metrics.appointmentsBooked} />
        <KPI lbl="Conversas ativas" val={metrics.activeConversations} />
      </div>

      <div className="hub-row-2col" style={{ marginBottom: 24 }}>
        {/* Seus agentes */}
        <div className="card">
          <div className="card-hd">
            <h3>Seus agentes</h3>
            <Link href="/hub/agents" className="btn btn--ghost btn--sm">
              Ver todos <ChevronRight />
            </Link>
          </div>
          {agents.length === 0 ? (
            <div className="empty">
              <p style={{ marginBottom: 12 }}>Você ainda não tem agentes de leads.</p>
              <Link href="/hub/agents/new" className="btn btn--primary btn--sm">
                <Plus /> Criar primeiro agente
              </Link>
            </div>
          ) : (
            <div>
              {agents.slice(0, 4).map((a) => (
                <Link key={a.id} href={`/hub/agents/${a.id}`} className="lrow">
                  <AMark templateKey={a.template_key} />
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</div>
                    <div style={{ marginTop: 4 }}>
                      <StatusBadge status={a.status} />
                    </div>
                  </div>
                  <PriceBadge included={a.included} entitled={a.entitled} />
                </Link>
              ))}
            </div>
          )}
        </div>

        {/* SparkBot quick prompt */}
        <div className="card" style={{ background: "var(--ink)", color: "#fff", border: "none" }}>
          <div style={{ padding: 18 }}>
            <div className="row" style={{ gap: 10, marginBottom: 14 }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: "var(--primary)", display: "grid", placeItems: "center" }}>
                <Zap size={16} />
              </div>
              <div>
                <div style={{ fontSize: 14, fontWeight: 600 }}>SparkBot</div>
                <div style={{ fontSize: 12, color: "rgba(255,255,255,.6)" }}>Pergunte qualquer coisa</div>
              </div>
            </div>
            <p style={{ fontSize: 13.5, lineHeight: 1.55, color: "rgba(255,255,255,.85)", margin: "0 0 16px" }}>
              Diga em português o que precisa — ele opera o Spark Leads por você no WhatsApp.
            </p>
            <a href="/embed/sparkbot" className="btn btn--primary" style={{ width: "100%", justifyContent: "center" }}>
              <WhatsAppIcon style={{ width: 15, height: 15 }} /> Abrir o SparkBot
            </a>
          </div>
        </div>
      </div>

      {/* Atividade recente */}
      <div className="card">
        <div className="card-hd">
          <h3>Atividade recente</h3>
          <Link href="/hub/messages" className="btn btn--ghost btn--sm">
            Ver todas <ChevronRight />
          </Link>
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
