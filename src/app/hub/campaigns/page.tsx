/**
 * /hub/campaigns — Listagem de campanhas de bulk-messages (Etapa 4.1.2 do plano).
 *
 * Pedro 2026-05-28: Prospecção 2.0 começa por dar visibility do que JÁ existe
 * no runtime (bulk-messages-v2 + bulk-management). Esta página é só READ —
 * criar/pausar/cancel vem no Commit B com wizard "Nova campanha".
 *
 * Filtro: por status (running/paused/completed/cancelled/failed) via chips.
 * Limite: HUB_LIST_LIMITS.campaigns (50 últimas).
 */
import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/sso";
import { loadHubCampaigns, type HubCampaignRow } from "@/lib/hub/data";
import { Megaphone, Plus } from "lucide-react";

export const dynamic = "force-dynamic";

const STATUS_LABEL: Record<HubCampaignRow["status"], string> = {
  running: "Em execução",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
  failed: "Falhou",
};

const STATUS_PILL: Record<HubCampaignRow["status"], string> = {
  running: "pill pill--info",
  paused: "pill pill--muted",
  completed: "pill pill--ok",
  cancelled: "pill pill--muted",
  failed: "pill pill--danger",
};

const CHANNEL_LABEL: Record<string, string> = {
  whatsapp_web_sms: "WhatsApp Web/SMS",
  whatsapp_api: "WhatsApp API",
};

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function progressPct(sent: number, total: number): number {
  if (total <= 0) return 0;
  return Math.min(100, Math.round((sent / total) * 100));
}

export default async function CampaignsPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const campaigns = await loadHubCampaigns(session.locationId);

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Campanhas</h1>
          <p className="page-hd__sub">Disparos em massa dos seus agentes — status, progresso e histórico.</p>
        </div>
        {/* CTA Nova campanha (Pedro 2026-05-28, Commit B). Wizard cria em
            status='paused'; admin ativa via SparkBot chat até Commit C trazer
            botões pause/resume/cancel direto no detail. */}
        <Link href="/hub/campaigns/new" className="btn btn--primary btn--sm">
          <Plus /> Nova campanha
        </Link>
      </div>

      {campaigns.length === 0 ? (
        <div className="card">
          <div className="empty" style={{ padding: "40px 24px", textAlign: "center" }}>
            <Megaphone size={28} style={{ color: "var(--ink-4)", marginBottom: 10 }} />
            <div style={{ fontSize: 14, fontWeight: 500, marginBottom: 4 }}>Nenhuma campanha ainda</div>
            <div className="muted" style={{ fontSize: 12.5, maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>
              Quando um agente disparar uma campanha (via bulk-messages do SparkBot ou pela UI nova), ela aparece aqui com status e progresso.
            </div>
          </div>
        </div>
      ) : (
        <div className="card">
          <div className="card-hd">
            <h3>Últimas {campaigns.length}</h3>
            <span className="muted" style={{ fontSize: 12 }}>
              Ordenadas por início (mais recente primeiro)
            </span>
          </div>
          <div>
            {campaigns.map((c) => {
              const pct = progressPct(c.sent_count, c.total_contacts);
              return (
                <div
                  key={c.id}
                  className="lrow"
                  style={{
                    gridTemplateColumns: "1fr auto",
                    cursor: "default",
                    padding: "14px 16px",
                  }}
                >
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 8, alignItems: "center", marginBottom: 4 }}>
                      <span style={{ fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.label}
                      </span>
                      <span className={STATUS_PILL[c.status]}>{STATUS_LABEL[c.status]}</span>
                      {c.priority > 0 && (
                        <span className="pill pill--muted" title="Prioridade alta">
                          P{c.priority}
                        </span>
                      )}
                    </div>
                    <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
                      {c.agent_name} · {CHANNEL_LABEL[c.delivery_channel] || c.delivery_channel} · iniciada {fmtWhen(c.start_at)}
                      {c.completed_at ? ` · concluída ${fmtWhen(c.completed_at)}` : c.estimated_completion_at ? ` · estimada ${fmtWhen(c.estimated_completion_at)}` : ""}
                    </div>
                    {c.message_preview && (
                      <div
                        className="muted"
                        style={{
                          fontSize: 12,
                          fontStyle: "italic",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          maxWidth: "100%",
                          marginBottom: 8,
                        }}
                      >
                        &quot;{c.message_preview}&quot;
                      </div>
                    )}
                    {/* Progress bar — só visível com total > 0 */}
                    {c.total_contacts > 0 && (
                      <div>
                        <div
                          style={{
                            height: 6,
                            background: "var(--surface-2)",
                            borderRadius: 3,
                            overflow: "hidden",
                            marginBottom: 4,
                          }}
                        >
                          <div
                            style={{
                              height: "100%",
                              width: `${pct}%`,
                              background:
                                c.status === "failed" ? "#ef4444" :
                                c.status === "completed" ? "#10b981" :
                                c.status === "paused" ? "#f59e0b" :
                                "#1675F2",
                              transition: "width .3s",
                            }}
                          />
                        </div>
                        <div className="muted tnum" style={{ fontSize: 11.5 }}>
                          {c.sent_count}/{c.total_contacts} enviadas
                          {c.failed_count > 0 ? ` · ${c.failed_count} falhas` : ""}
                          {c.skipped_count > 0 ? ` · ${c.skipped_count} puladas` : ""}
                          {" · "}
                          <span className="tnum">{pct}%</span>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
