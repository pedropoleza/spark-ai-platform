"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { PlayCircle, PauseCircle } from "lucide-react";
import { ActRow } from "@/components/hub/primitives";
import type { HubActivityItem } from "@/components/hub/types";
import type { PausedConversationRow } from "@/lib/hub/data";

type Tab = "activity" | "paused";

/**
 * Mensagens: alterna entre o feed de atividade e a lista de conversas pausadas
 * (handoff humano / opt-out). Em "Pausadas", o admin retoma a IA por conversa.
 * Feedback Pedro 1c (a vista/filtro que faltava — o toggle e a auto-pausa já
 * existiam no runtime).
 */
export function MessagesView({ activity, paused }: { activity: HubActivityItem[]; paused: PausedConversationRow[] }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>(paused.length > 0 ? "paused" : "activity");
  const [busy, setBusy] = useState<string | null>(null);

  async function resume(row: PausedConversationRow) {
    const key = row.agent_id + ":" + row.contact_id;
    setBusy(key);
    try {
      const res = await fetch("/api/conversations/resume", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: row.agent_id, contact_id: row.contact_id }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success(`IA retomada para ${row.contact_label}`);
      router.refresh();
    } catch (err) {
      toast.error("Não consegui retomar: " + (err instanceof Error ? err.message : ""));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <div className="card-hd">
        <div className="row" style={{ gap: 4 }}>
          <button className={"btn btn--sm " + (tab === "activity" ? "btn--soft" : "btn--quiet")} onClick={() => setTab("activity")}>
            Atividade <span className="muted">{activity.length}</span>
          </button>
          <button className={"btn btn--sm " + (tab === "paused" ? "btn--soft" : "btn--quiet")} onClick={() => setTab("paused")}>
            Pausadas <span className="muted">{paused.length}</span>
          </button>
        </div>
      </div>

      {tab === "activity" ? (
        activity.length === 0 ? (
          <div className="empty">Nenhuma atividade dos seus agentes ainda.</div>
        ) : (
          <>
            {/* Pedro 2026-05-28: label honesto. loadHubActivity tem cap 100. */}
            <div className="muted" style={{ fontSize: 12, padding: "6px 12px 0" }}>
              Mostrando últimas {activity.length} atividades{activity.length >= 100 ? " — recarregue pra ver as mais novas" : ""}.
            </div>
            <div>{activity.map((it, i) => <ActRow key={i} item={it} />)}</div>
          </>
        )
      ) : paused.length === 0 ? (
        <div className="empty">
          <PauseCircle size={18} style={{ color: "var(--ink-4)", marginBottom: 6 }} />
          <div style={{ fontSize: 13, fontWeight: 500 }}>Nenhuma conversa pausada</div>
          <div className="muted" style={{ fontSize: 12, marginTop: 3 }}>
            Quando um atendente humano assume ou o lead pede pra parar, a conversa aparece aqui pra você retomar a IA.
          </div>
        </div>
      ) : (
        <div>
          {/* Pedro 2026-05-28: label honesto. loadPausedConversations agora
              janela = 30 dias + cap 200 (antes era top-200 sem filtro de tempo). */}
          <div className="muted" style={{ fontSize: 12, padding: "6px 12px 0" }}>
            Pausadas dos últimos 30 dias · {paused.length}{paused.length >= 200 ? " (cap — pode haver mais; pausadas mais antigas ficam ocultas)" : ""}.
          </div>
          {paused.map((row) => {
            const key = row.agent_id + ":" + row.contact_id;
            return (
              <div key={key} className="lrow" style={{ gridTemplateColumns: "1fr auto", cursor: "default" }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 14, fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.contact_label}</div>
                  <div className="muted" style={{ fontSize: 12.5 }}>
                    {row.agent_name}
                    {row.reason ? ` · ${row.reason}` : ""}
                    {row.paused_at ? ` · ${row.paused_at}` : ""}
                  </div>
                </div>
                <button className="btn btn--ghost btn--sm" disabled={busy === key} onClick={() => resume(row)}>
                  <PlayCircle size={14} /> {busy === key ? "Retomando…" : "Retomar IA"}
                </button>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
