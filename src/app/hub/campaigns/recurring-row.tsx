"use client";

/**
 * Row de campanha recorrente — UI client com toggle enable/disable + delete.
 * Etapa 4.5 (Pedro 2026-05-28).
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import type { HubRecurringRow } from "@/lib/hub/data";

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

// Translate cron expression pra label humana pros casos mais comuns.
function humanCron(cron: string): string {
  const presets: Record<string, string> = {
    "0 9 * * 1": "toda segunda às 9h",
    "0 9 * * 1-5": "todo dia útil às 9h",
    "0 14 * * 1-5": "todo dia útil às 14h",
    "0 9 * * *": "todo dia às 9h",
    "0 10 1 * *": "todo dia 1 do mês às 10h",
    "0 9 * * 0": "todo domingo às 9h",
  };
  return presets[cron] || cron;
}

export function RecurringCampaignRow({ row }: { row: HubRecurringRow }) {
  const router = useRouter();
  const [busy, setBusy] = useState<null | "toggle" | "delete">(null);
  const [enabled, setEnabled] = useState(row.enabled);

  async function toggle(next: boolean) {
    setBusy("toggle");
    try {
      const res = await fetch(`/api/hub/campaigns/recurring/${row.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: next }),
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "falha");
      setEnabled(next);
      toast.success(next ? "Recorrência ativada" : "Recorrência pausada");
      router.refresh();
    } catch (err) {
      toast.error("Não consegui: " + (err instanceof Error ? err.message : ""));
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm(`Apagar a recorrência "${row.label}"? Disparos futuros não vão mais sair. Campanhas já criadas ficam.`)) return;
    setBusy("delete");
    try {
      const res = await fetch(`/api/hub/campaigns/recurring/${row.id}`, {
        method: "DELETE",
      });
      const json = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !json.ok) throw new Error(json.error || "falha");
      toast.success("Recorrência removida");
      router.refresh();
    } catch (err) {
      toast.error("Não consegui: " + (err instanceof Error ? err.message : ""));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div
      className="lrow"
      style={{ gridTemplateColumns: "1fr auto", padding: "12px 16px", alignItems: "center" }}
    >
      <div style={{ minWidth: 0 }}>
        <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 4 }}>
          <span style={{ fontSize: 14, fontWeight: 500 }}>{row.label}</span>
          <span className={enabled ? "pill pill--info" : "pill pill--muted"}>
            {enabled ? "Ativa" : "Pausada"}
          </span>
        </div>
        <div className="muted" style={{ fontSize: 12.5 }}>
          {row.agent_name} · {humanCron(row.cron_expression)} · {row.timezone}
          {row.tag ? ` · tag: ${row.tag}` : ""}
        </div>
        <div className="muted" style={{ fontSize: 11.5, marginTop: 4 }}>
          {enabled && row.next_run_at ? `Próximo disparo: ${fmtWhen(row.next_run_at)}` : "—"}
          {row.last_run_at ? ` · último: ${fmtWhen(row.last_run_at)}` : ""}
          {` · cap ${row.per_run_cap}/run`}
        </div>
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          disabled={busy !== null}
          onClick={() => toggle(!enabled)}
        >
          {busy === "toggle" ? "…" : enabled ? "Pausar" : "Ativar"}
        </button>
        <button
          type="button"
          className="btn btn--quiet btn--sm"
          disabled={busy !== null}
          onClick={remove}
          aria-label="Remover recorrência"
          style={{ color: "#991B1B" }}
        >
          <Trash2 size={14} />
        </button>
      </div>
    </div>
  );
}
