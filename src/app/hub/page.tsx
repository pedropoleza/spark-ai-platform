import Link from "next/link";
import { redirect } from "next/navigation";
import { Zap, ChevronRight, Plus, Settings } from "lucide-react";
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

      {/* KPIs — todos per-location e reais.
          Etapa 3.2 (Pedro 2026-05-28): label deixa explícito que "30 dias" é
          rolling (últimos 30 dias até agora), não mês calendário. */}
      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <KPI
          lbl="Mensagens (últimos 30 dias)"
          val={metrics.messagesSent30d.toLocaleString("pt-BR")}
          title="Total de mensagens dos seus agentes nos últimos 30 dias (janela rolling, não mês calendário)"
        />
        <KPI
          lbl="Leads qualificados"
          val={metrics.leadsQualified}
          title="Leads que avançaram pra estágio qualificado nos últimos 30 dias"
        />
        <KPI
          lbl="Reuniões agendadas"
          val={metrics.appointmentsBooked}
          title="Appointments criados pelos seus agentes nos últimos 30 dias"
        />
        <KPI
          lbl="Conversas ativas"
          val={metrics.activeConversations}
          title="Conversas com inbound ou outbound nas últimas 48h"
        />
      </div>

      {/* F6 (Pedro 2026-05-28): 2ª linha pra prospecção. Só renderiza se há algo
          ativo — evita visualmente sugerir "use isso" em location sem campanhas. */}
      {(metrics.campaignsRunning > 0 || metrics.sequenceActive > 0 || metrics.recurringEnabled > 0 || metrics.optoutsTotal > 0) && (
        <div className="kpi-grid" style={{ marginBottom: 24 }}>
          <KPI
            lbl="Campanhas rodando"
            val={metrics.campaignsRunning}
            title="Jobs de bulk-message em status=running. Veja em /hub/campaigns."
          />
          <KPI
            lbl="Sequências ativas"
            val={metrics.sequenceActive}
            title="Contatos seguindo sequência multi-toque (em algum step pendente)"
          />
          <KPI
            lbl="Recorrentes ON"
            val={metrics.recurringEnabled}
            title="Campanhas cron-agendadas habilitadas"
          />
          <KPI
            lbl="Opt-outs"
            val={metrics.optoutsTotal}
            title="Contatos que responderam STOP/PARAR/etc — nunca recebem campanha"
          />
        </div>
      )}

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
            <Link
              href="/hub/sparkbot"
              className="btn btn--on-dark"
              style={{ width: "100%", justifyContent: "center", marginTop: 8 }}
            >
              <Settings size={14} /> Configurar SparkBot
            </Link>
          </div>
        </div>
      </div>

      {/* Atividade recente (Pedro 2026-05-28: label honesto de truncagem). */}
      <div className="card">
        <div className="card-hd">
          <h3>Atividade recente <span className="muted" style={{ fontSize: 12, fontWeight: 400 }}>· últimas {activity.length}</span></h3>
          <Link href="/hub/messages" className="btn btn--ghost btn--sm">
            Ver todas <ChevronRight />
          </Link>
        </div>
        {activity.length === 0 ? (
          <div className="empty">Nenhuma atividade dos seus agentes ainda.</div>
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
