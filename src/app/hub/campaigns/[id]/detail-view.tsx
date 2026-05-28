"use client";

/**
 * Detail view client (Etapa 4.1 Commit C — Pedro 2026-05-28).
 *
 * Botões pause/resume/cancel via PATCH /api/hub/campaigns/[id]. Confirmação
 * pra cancelar (estado final). Após mudança, refresh da página pra puxar
 * counters/status atualizados.
 *
 * Recipients table fica como follow-up explícito (próximo commit) —
 * precisa de loader paginado pra bulk_message_recipients.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Play, Pause, X, AlertCircle } from "lucide-react";
import type { HubCampaignDetail } from "@/lib/hub/data";

const STATUS_LABEL: Record<string, string> = {
  running: "Em execução",
  paused: "Pausada",
  completed: "Concluída",
  cancelled: "Cancelada",
  failed: "Falhou",
};

const STATUS_PILL: Record<string, string> = {
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
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

export function CampaignDetailView({ campaign }: { campaign: HubCampaignDetail }) {
  const router = useRouter();
  const [busy, setBusy] = useState<"running" | "paused" | "cancelled" | null>(null);

  const isTerminal = campaign.status === "completed" || campaign.status === "cancelled" || campaign.status === "failed";

  async function patchStatus(target: "running" | "paused" | "cancelled", confirmMsg?: string) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    setBusy(target);
    try {
      const res = await fetch(`/api/hub/campaigns/${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status: target }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "falha");
      toast.success(`Campanha ${target === "running" ? "iniciada" : target === "paused" ? "pausada" : "cancelada"}`);
      router.refresh();
    } catch (err) {
      toast.error("Não consegui: " + (err instanceof Error ? err.message : ""));
    } finally {
      setBusy(null);
    }
  }

  const pct = campaign.total_contacts > 0
    ? Math.min(100, Math.round((campaign.sent_count / campaign.total_contacts) * 100))
    : 0;

  const filterTag = (campaign.filter_config as { tag?: string }).tag || null;

  return (
    <>
      <div className="page-hd" style={{ flexWrap: "wrap", gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <h1 className="page-hd__title" style={{ display: "inline-flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            {campaign.label}
            <span className={STATUS_PILL[campaign.status]}>{STATUS_LABEL[campaign.status]}</span>
          </h1>
          <p className="page-hd__sub">
            {campaign.agent_name} · {CHANNEL_LABEL[campaign.delivery_channel] || campaign.delivery_channel}
          </p>
        </div>
        {/* Botões de ação — visíveis só se não terminal */}
        {!isTerminal && (
          <div className="row" style={{ gap: 8 }}>
            {campaign.status === "paused" && (
              <button
                className="btn btn--primary btn--sm"
                disabled={busy !== null}
                onClick={() => patchStatus("running")}
              >
                <Play size={14} /> {busy === "running" ? "Iniciando…" : "Iniciar"}
              </button>
            )}
            {campaign.status === "running" && (
              <button
                className="btn btn--ghost btn--sm"
                disabled={busy !== null}
                onClick={() => patchStatus("paused")}
              >
                <Pause size={14} /> {busy === "paused" ? "Pausando…" : "Pausar"}
              </button>
            )}
            <button
              className="btn btn--quiet btn--sm"
              disabled={busy !== null}
              onClick={() =>
                patchStatus(
                  "cancelled",
                  `Cancelar a campanha "${campaign.label}"? Não dá pra reverter — quem ainda não recebeu, não recebe.`,
                )
              }
              style={{ color: "#991B1B" }}
            >
              <X size={14} /> {busy === "cancelled" ? "Cancelando…" : "Cancelar"}
            </button>
          </div>
        )}
      </div>

      {campaign.status === "paused" && (
        <div className="card card--flat" style={{ padding: 12, background: "var(--primary-soft)", marginBottom: 16 }}>
          <div className="row" style={{ gap: 8, alignItems: "flex-start" }}>
            <AlertCircle size={16} style={{ color: "var(--primary-ink)", marginTop: 2, flexShrink: 0 }} />
            <div style={{ fontSize: 12.5, color: "var(--primary-ink)", lineHeight: 1.5 }}>
              Campanha pausada — clique em <strong>Iniciar</strong> pra começar a disparar. O cron-runner do SparkBot popula os destinatários e dispara respeitando intervalo + horário silêncio.
            </div>
          </div>
        </div>
      )}

      {/* Progresso */}
      {campaign.total_contacts > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-hd"><h3>Progresso</h3><span className="tnum muted" style={{ fontSize: 13 }}>{pct}%</span></div>
          <div className="card-body" style={{ padding: 16 }}>
            <div style={{ height: 8, background: "var(--surface-2)", borderRadius: 4, overflow: "hidden", marginBottom: 10 }}>
              <div
                style={{
                  height: "100%",
                  width: `${pct}%`,
                  background:
                    campaign.status === "failed" ? "#ef4444" :
                    campaign.status === "completed" ? "#10b981" :
                    campaign.status === "paused" ? "#f59e0b" :
                    "#1675F2",
                  transition: "width .3s",
                }}
              />
            </div>
            <div className="row" style={{ gap: 20, fontSize: 13 }}>
              <Stat label="Enviadas" value={campaign.sent_count.toLocaleString("pt-BR")} />
              <Stat label="Total" value={campaign.total_contacts.toLocaleString("pt-BR")} />
              {campaign.failed_count > 0 && <Stat label="Falhas" value={campaign.failed_count.toLocaleString("pt-BR")} danger />}
              {campaign.skipped_count > 0 && <Stat label="Puladas" value={campaign.skipped_count.toLocaleString("pt-BR")} />}
            </div>
          </div>
        </div>
      )}

      {/* Config */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div className="card-hd"><h3>Configuração</h3></div>
        <div className="card-body" style={{ padding: 16, display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <Row label="Agente" value={campaign.agent_name} />
          <Row label="Canal" value={CHANNEL_LABEL[campaign.delivery_channel] || campaign.delivery_channel} />
          <Row label="Filtro (tag)" value={filterTag || "—"} />
          <Row label="Intervalo entre envios" value={`${campaign.interval_seconds}s ± ${campaign.jitter_seconds}s`} />
          <Row label="Variação" value={campaign.variation_mode} />
          <Row label="Respeita horário silêncio" value={campaign.respect_quiet_hours ? "Sim" : "Não"} />
          <Row label="Iniciada em" value={fmtWhen(campaign.start_at)} />
          {campaign.completed_at && <Row label="Concluída em" value={fmtWhen(campaign.completed_at)} />}
          {!campaign.completed_at && campaign.estimated_completion_at && <Row label="Estimada pra" value={fmtWhen(campaign.estimated_completion_at)} />}
          {campaign.priority > 0 && <Row label="Prioridade" value={`P${campaign.priority}`} />}
        </div>
      </div>

      {/* Mensagem template */}
      <div className="card">
        <div className="card-hd"><h3>Mensagem</h3></div>
        <div className="card-body" style={{ padding: 16 }}>
          <div
            style={{
              fontSize: 13.5,
              padding: 12,
              background: "var(--surface-2)",
              borderRadius: "var(--r-sm)",
              whiteSpace: "pre-wrap",
              lineHeight: 1.5,
            }}
          >
            {campaign.message_template}
          </div>
        </div>
      </div>

      {/* TODO Commit posterior: recipients table com pagina */}
      <div className="muted" style={{ fontSize: 12, marginTop: 12, textAlign: "center" }}>
        Lista de destinatários e logs por contato — em breve.
      </div>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 12, marginBottom: 2 }}>{label}</div>
      <div style={{ fontSize: 13, fontWeight: 500 }}>{value}</div>
    </div>
  );
}

function Stat({ label, value, danger }: { label: string; value: string; danger?: boolean }) {
  return (
    <div>
      <div className="muted" style={{ fontSize: 11 }}>{label}</div>
      <div className="tnum" style={{ fontSize: 18, fontWeight: 600, color: danger ? "#ef4444" : undefined }}>{value}</div>
    </div>
  );
}
