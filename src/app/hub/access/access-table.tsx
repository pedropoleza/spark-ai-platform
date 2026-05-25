"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Search, X, Check } from "lucide-react";
import { KPI } from "@/components/hub/primitives";
import type { EntitlementGridRow, EntStatus } from "@/lib/hub/data";

type Cap = "sales" | "recruitment" | "custom";
const CAP_LABEL: Record<Cap, string> = { sales: "Vendas", recruitment: "Recrutamento", custom: "Custom" };

export function AccessTable({ rows }: { rows: EntitlementGridRow[] }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [modal, setModal] = useState<{ locationId: string; capability: Cap; price: string; expires: string } | null>(null);

  const filtered = rows.filter(
    (r) => r.location_name.toLowerCase().includes(query.toLowerCase()) || r.location_id.toLowerCase().includes(query.toLowerCase()),
  );
  const countActive = (cap: Cap) => rows.filter((r) => r[cap] === "active").length;

  function openGrant(locationId = "", capability: Cap = "sales") {
    setModal({ locationId: locationId || rows[0]?.location_id || "", capability, price: "50", expires: "" });
  }

  async function grant() {
    if (!modal || !modal.locationId || busy) return;
    setBusy(true);
    try {
      const res = await fetch("/api/agent-platform/entitlements", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          location_id: modal.locationId,
          capability: modal.capability,
          price_usd: Number(modal.price) || 50,
          expires_at: modal.expires || null,
        }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success("Acesso liberado");
      setModal(null);
      router.refresh();
    } catch (err) {
      toast.error("Não consegui liberar: " + (err instanceof Error ? err.message : ""));
    } finally {
      setBusy(false);
    }
  }

  async function revoke(locationId: string, capability: Cap) {
    if (!window.confirm(`Revogar ${CAP_LABEL[capability]} deste escritório?`)) return;
    try {
      const res = await fetch("/api/agent-platform/entitlements/revoke", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location_id: locationId, capability }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || "falhou");
      toast.success("Acesso revogado");
      router.refresh();
    } catch (err) {
      toast.error("Não consegui revogar: " + (err instanceof Error ? err.message : ""));
    }
  }

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Acessos</h1>
          <p className="page-hd__sub">Libere ou bloqueie agentes pagos por escritório.</p>
        </div>
        <button className="btn btn--primary btn--lg" onClick={() => openGrant()}>
          <Plus /> Liberar acesso
        </button>
      </div>

      <div className="kpi-grid" style={{ marginBottom: 16 }}>
        <KPI lbl="Escritórios" val={rows.length} />
        <KPI lbl="Vendas" val={countActive("sales")} />
        <KPI lbl="Recrutamento" val={countActive("recruitment")} />
        <KPI lbl="Custom" val={countActive("custom")} />
      </div>

      <div className="card">
        <div className="card-hd">
          <div className="searchbox" style={{ minWidth: 280 }}>
            <Search size={14} />
            <input placeholder="Buscar escritório…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
          <span className="muted" style={{ fontSize: 12 }}>{filtered.length} escritórios</span>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table className="table">
            <thead>
              <tr>
                <th>Escritório</th>
                <th style={{ width: 130 }}>Vendas</th>
                <th style={{ width: 150 }}>Recrutamento</th>
                <th style={{ width: 130 }}>Custom</th>
                <th style={{ width: 90 }} className="tnum">Preço</th>
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 && (
                <tr><td colSpan={5}><div className="empty">Nenhum escritório encontrado.</div></td></tr>
              )}
              {filtered.map((r) => (
                <tr key={r.location_id}>
                  <td>
                    <div style={{ fontWeight: 500 }}>{r.location_name}</div>
                    <div className="muted mono" style={{ fontSize: 11 }}>{r.location_id}</div>
                  </td>
                  {(["sales", "recruitment", "custom"] as Cap[]).map((cap) => (
                    <td key={cap}>
                      <EntCell status={r[cap]} onGrant={() => openGrant(r.location_id, cap)} onRevoke={() => revoke(r.location_id, cap)} />
                    </td>
                  ))}
                  <td className="tnum">${r.price}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {modal && (
        <div onClick={() => setModal(null)} style={{ position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 90, display: "grid", placeItems: "center" }}>
          <div className="card" onClick={(e) => e.stopPropagation()} style={{ width: "min(460px, 94vw)", boxShadow: "var(--shadow-3)" }}>
            <div className="card-hd">
              <h3>Liberar acesso</h3>
              <button className="btn btn--quiet btn--icon" onClick={() => setModal(null)} aria-label="Fechar"><X /></button>
            </div>
            <div className="card-body col" style={{ gap: 14 }}>
              <div className="field">
                <label className="field__lbl">Escritório</label>
                <select className="select" value={modal.locationId} onChange={(e) => setModal({ ...modal, locationId: e.target.value })}>
                  {rows.map((r) => <option key={r.location_id} value={r.location_id}>{r.location_name}</option>)}
                </select>
              </div>
              <div className="field">
                <label className="field__lbl">Capacidade</label>
                <select className="select" value={modal.capability} onChange={(e) => setModal({ ...modal, capability: e.target.value as Cap })}>
                  <option value="sales">Vendas</option>
                  <option value="recruitment">Recrutamento</option>
                  <option value="custom">Custom</option>
                </select>
              </div>
              <div className="row" style={{ gap: 12 }}>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field__lbl">Preço/mês (USD)</label>
                  <input className="input" type="number" min={0} value={modal.price} onChange={(e) => setModal({ ...modal, price: e.target.value })} />
                </div>
                <div className="field" style={{ flex: 1 }}>
                  <label className="field__lbl">Expira em (opcional)</label>
                  <input className="input" type="date" value={modal.expires} onChange={(e) => setModal({ ...modal, expires: e.target.value })} />
                </div>
              </div>
            </div>
            <div style={{ padding: "12px 16px", borderTop: "1px solid var(--line)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
              <button className="btn btn--ghost" onClick={() => setModal(null)}>Cancelar</button>
              <button className="btn btn--primary" onClick={grant} disabled={busy || !modal.locationId}>
                <Check /> {busy ? "Liberando…" : "Liberar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EntCell({ status, onGrant, onRevoke }: { status: EntStatus; onGrant: () => void; onRevoke: () => void }) {
  if (status === "active") {
    return (
      <div className="row" style={{ gap: 6 }}>
        <span className="pill pill--ok">Ativo</span>
        <button className="btn btn--quiet btn--icon btn--sm" onClick={onRevoke} title="Revogar" aria-label="Revogar"><X size={12} /></button>
      </div>
    );
  }
  if (status === "revoked") {
    return (
      <button className="btn btn--quiet btn--sm" onClick={onGrant} style={{ color: "var(--danger)" }}>Revogado · religar</button>
    );
  }
  return (
    <button className="btn btn--quiet btn--sm" onClick={onGrant} style={{ color: "var(--ink-3)" }}>— liberar</button>
  );
}
