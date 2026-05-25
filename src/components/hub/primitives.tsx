import { Zap, DollarSign, Users, Wand2, Lock, ArrowUp, ArrowDown, ChevronRight, type LucideIcon } from "lucide-react";
import { channelIcon } from "./icons";
import type { AgentStatus, ChannelKey, HubActivityItem } from "./types";

/* ─── Template → visual (mark + ícone) ──────────────────────────── */
type TemplateVisual = { markClass: string; Icon: LucideIcon };

export function templateVisual(templateKey: string): TemplateVisual {
  switch (templateKey) {
    case "sparkbot":
      return { markClass: "amark--primary", Icon: Zap };
    case "sales":
      return { markClass: "amark--ink", Icon: DollarSign };
    case "recruitment":
      return { markClass: "amark--accent", Icon: Users };
    default:
      return { markClass: "amark--neutral", Icon: Wand2 };
  }
}

/* ─── AMark — marca do agente ───────────────────────────────────── */
export function AMark({ templateKey, size = "md" }: { templateKey: string; size?: "sm" | "md" | "lg" | "xl" }) {
  const { markClass, Icon } = templateVisual(templateKey);
  const sizeClass = size === "lg" ? " amark--lg" : size === "xl" ? " amark--xl" : size === "sm" ? " amark--sm" : "";
  return (
    <div className={`amark ${markClass}${sizeClass}`}>
      <Icon />
    </div>
  );
}

/* ─── StatusBadge ───────────────────────────────────────────────── */
const STATUS: Record<AgentStatus, { color: string; label: string }> = {
  active: { color: "var(--success)", label: "Ativo" },
  paused: { color: "var(--warning)", label: "Pausado" },
  blocked: { color: "var(--ink-4)", label: "Bloqueado" },
};

export function StatusBadge({ status }: { status: AgentStatus }) {
  const m = STATUS[status] || STATUS.blocked;
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 13, color: "var(--ink-2)" }}>
      <span style={{ width: 8, height: 8, borderRadius: 999, background: m.color }} />
      {m.label}
    </span>
  );
}

/* ─── ChannelChip ───────────────────────────────────────────────── */
const CHANNEL_LABEL: Record<ChannelKey, string> = { whatsapp: "WhatsApp", instagram: "Instagram" };

export function ChannelChip({ name }: { name: ChannelKey | string }) {
  const Icon = channelIcon(name);
  const label = CHANNEL_LABEL[name as ChannelKey] || name;
  if (!Icon) return null;
  return (
    <span className="chchip">
      <Icon /> {label}
    </span>
  );
}

/* ─── PriceBadge ────────────────────────────────────────────────── */
export function PriceBadge({ included, entitled }: { included: boolean; entitled: boolean }) {
  if (included) return <span className="pill pill--ok">Incluso</span>;
  if (entitled)
    return (
      <span className="pill pill--muted">
        <span className="mono">$50</span>/mês
      </span>
    );
  return (
    <span className="pill pill--muted">
      <Lock size={11} /> Bloqueado
    </span>
  );
}

/* ─── KPI ───────────────────────────────────────────────────────── */
export function KPI({ lbl, val, delta, up }: { lbl: string; val: string | number; delta?: string; up?: boolean }) {
  const deltaClass = up === true ? "kpi__delta kpi__delta--up" : up === false ? "kpi__delta kpi__delta--down" : "kpi__delta";
  return (
    <div className="kpi">
      <div className="kpi__lbl">{lbl}</div>
      <div className="kpi__val tnum">{val}</div>
      {delta && (
        <div className={deltaClass}>
          {up === true && <ArrowUp size={12} />}
          {up === false && <ArrowDown size={12} />}
          {delta}
        </div>
      )}
    </div>
  );
}

/* ─── ActRow — linha do feed de atividade ───────────────────────── */
const ACT_TYPE: Record<HubActivityItem["type"], { color: string; label: string }> = {
  qualified: { color: "var(--success)", label: "Lead qualificado" },
  scheduled: { color: "var(--primary)", label: "Agendado" },
  task: { color: "var(--ink-2)", label: "Tarefa" },
  note: { color: "var(--ink-3)", label: "Nota" },
  msg: { color: "var(--ink-3)", label: "Mensagem" },
};

export function ActRow({ item }: { item: HubActivityItem }) {
  const t = ACT_TYPE[item.type] || ACT_TYPE.msg;
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "60px 1fr auto auto",
        gap: 14,
        padding: "12px 16px",
        borderBottom: "1px solid var(--line)",
        alignItems: "center",
      }}
    >
      <span style={{ fontSize: 12, color: "var(--ink-3)" }}>{item.t}</span>
      <div>
        <div style={{ fontSize: 13.5 }}>{item.text}</div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>
          {item.agent} · {item.channel}
        </div>
      </div>
      <span className="pill pill--muted" style={{ color: t.color }}>
        <span className="dot" /> {t.label}
      </span>
      <ChevronRight size={14} style={{ color: "var(--ink-4)" }} />
    </div>
  );
}
