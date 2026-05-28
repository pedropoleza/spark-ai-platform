import { redirect } from "next/navigation";
import Link from "next/link";
import { getSession } from "@/lib/auth/sso";
import { loadBilling, type BillingRange } from "@/lib/hub/data";
import { AMark } from "@/components/hub/primitives";

export const dynamic = "force-dynamic";

const TPL_LABEL: Record<string, string> = { sales: "Vendas", recruitment: "Recrutamento", custom: "Personalizado", sparkbot: "SparkBot" };

// Etapa 3.3 (Pedro 2026-05-28): presets de período + custom range via query.
function resolveRange(searchParams: { range?: string; from?: string; to?: string }): BillingRange | undefined {
  const now = new Date();
  if (searchParams.range === "30d") {
    const from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    return { fromIso: from.toISOString(), toIso: now.toISOString(), label: "Últimos 30 dias" };
  }
  if (searchParams.range === "7d") {
    const from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    return { fromIso: from.toISOString(), toIso: now.toISOString(), label: "Últimos 7 dias" };
  }
  if (searchParams.range === "ytd") {
    const from = new Date(now.getFullYear(), 0, 1);
    return { fromIso: from.toISOString(), toIso: now.toISOString(), label: "Ano até hoje" };
  }
  if (searchParams.from || searchParams.to) {
    // Custom range: from/to inputs (YYYY-MM-DD format from <input type="date">).
    const fromIso = searchParams.from ? new Date(searchParams.from + "T00:00:00").toISOString() : undefined;
    const toIso = searchParams.to ? new Date(searchParams.to + "T23:59:59").toISOString() : new Date().toISOString();
    const label =
      searchParams.from && searchParams.to
        ? `${searchParams.from} → ${searchParams.to}`
        : searchParams.from
        ? `Desde ${searchParams.from}`
        : `Até ${searchParams.to}`;
    return { fromIso, toIso, label };
  }
  return undefined; // default = mês atual (loadBilling)
}

export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ range?: string; from?: string; to?: string }>;
}) {
  const session = await getSession();
  if (!session) redirect("/");

  const params = await searchParams;
  const range = resolveRange(params);
  const b = await loadBilling(session.locationId, range);

  // Helper pra preset URL
  const preset = (rangeKey: string) => `/hub/billing?range=${rangeKey}`;
  const isActive = (rangeKey: string) => params.range === rangeKey;
  const isMonth = !params.range && !params.from && !params.to;

  return (
    <div className="page">
      <div className="page-hd" style={{ flexWrap: "wrap", gap: 12 }}>
        <div>
          <h1 className="page-hd__title">Faturamento</h1>
          <p className="page-hd__sub">Assinatura, agentes pagos e uso no período.</p>
        </div>
        {/* Etapa 3.3: presets de período + custom range form. */}
        <div className="row" style={{ gap: 6, flexWrap: "wrap" }}>
          <Link href="/hub/billing" className={`btn btn--sm ${isMonth ? "btn--soft" : "btn--quiet"}`}>
            Este mês
          </Link>
          <Link href={preset("30d")} className={`btn btn--sm ${isActive("30d") ? "btn--soft" : "btn--quiet"}`}>
            Últimos 30d
          </Link>
          <Link href={preset("7d")} className={`btn btn--sm ${isActive("7d") ? "btn--soft" : "btn--quiet"}`}>
            Últimos 7d
          </Link>
          <Link href={preset("ytd")} className={`btn btn--sm ${isActive("ytd") ? "btn--soft" : "btn--quiet"}`}>
            Ano
          </Link>
          <form
            method="get"
            action="/hub/billing"
            className="row"
            style={{ gap: 4, alignItems: "center", marginLeft: 6 }}
          >
            <input
              type="date"
              name="from"
              defaultValue={params.from || ""}
              className="input"
              style={{ fontSize: 12, padding: "2px 6px", width: 120 }}
              aria-label="Data inicial"
            />
            <span className="muted" style={{ fontSize: 12 }}>→</span>
            <input
              type="date"
              name="to"
              defaultValue={params.to || ""}
              className="input"
              style={{ fontSize: 12, padding: "2px 6px", width: 120 }}
              aria-label="Data final"
            />
            <button type="submit" className="btn btn--sm btn--quiet">
              Ir
            </button>
          </form>
        </div>
      </div>

      <div className="hub-row-2col" style={{ marginBottom: 16 }}>
        {/* Assinatura */}
        <div className="card">
          <div className="card-hd">
            <h3>Assinatura mensal</h3>
            <div style={{ textAlign: "right" }}>
              <div className="tnum" style={{ fontSize: 28, fontWeight: 600, letterSpacing: "-.02em" }}>${b.subscriptionTotal}</div>
              <div className="muted" style={{ fontSize: 11 }}>+ uso medido</div>
            </div>
          </div>
          <div>
            <div className="lrow" style={{ cursor: "default", gridTemplateColumns: "36px 1fr auto" }}>
              <AMark templateKey="sparkbot" />
              <div><div style={{ fontSize: 14, fontWeight: 500 }}>SparkBot</div><div className="muted" style={{ fontSize: 12.5 }}>Assistente do rep</div></div>
              <span className="pill pill--ok">Incluso</span>
            </div>
            {b.paidAgents.length === 0 ? (
              <div className="empty" style={{ padding: "20px 24px" }}>Nenhum agente pago ativo.</div>
            ) : (
              b.paidAgents.map((a) => (
                <div key={a.id} className="lrow" style={{ cursor: "default", gridTemplateColumns: "36px 1fr auto" }}>
                  <AMark templateKey={a.template_key} />
                  <div><div style={{ fontSize: 14, fontWeight: 500 }}>{a.name}</div><div className="muted" style={{ fontSize: 12.5 }}>{TPL_LABEL[a.template_key] || a.template_key}</div></div>
                  <span className="tnum" style={{ fontWeight: 600 }}>${a.price}<span className="muted" style={{ fontSize: 11, fontWeight: 400 }}>/mês</span></span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Uso no período */}
        <div className="card">
          <div className="card-hd">
            <h3>Uso ({b.rangeLabel})</h3>
            <span className="muted" style={{ fontSize: 11 }}>
              {b.rangeFromIso.slice(0, 10)} → {b.rangeToIso.slice(0, 10)}
            </span>
          </div>
          <div className="card-body col" style={{ gap: 14 }}>
            <UseStat lbl="Custo medido" val={`$${b.monthCharged.toFixed(2)}`} />
            <UseStat lbl="Tokens" val={b.monthTokens >= 1e6 ? (b.monthTokens / 1e6).toFixed(1) + "M" : b.monthTokens.toLocaleString("pt-BR")} />
            <UseStat lbl="Áudio" val={`${Math.round(b.monthAudioSec / 60)} min`} />
            <UseStat lbl="Imagens" val={String(b.monthImages)} />
            <UseStat lbl="Interações" val={String(b.monthInteractions)} />
          </div>
        </div>
      </div>

      <div className="card">
        <div className="card-hd"><h3>Atividade de cobrança</h3><span className="muted" style={{ fontSize: 12 }}>últimas {b.recent.length}</span></div>
        {b.recent.length === 0 ? (
          <div className="empty">Sem atividade de cobrança neste período.</div>
        ) : (
          // overflowX evita que a tabela estoure o card em telas estreitas (a11y/responsivo).
          <div style={{ overflowX: "auto" }}>
            <table className="table">
              <thead><tr><th>Quando</th><th>Ação</th><th>Modelo</th><th className="tnum">Tokens</th><th className="tnum">Custo</th></tr></thead>
              <tbody>
                {b.recent.map((r, i) => (
                  <tr key={i}>
                    <td style={{ fontSize: 12.5, color: "var(--ink-3)" }}>{r.date}</td>
                    <td>{r.action}</td>
                    <td className="mono" style={{ fontSize: 12 }}>{r.model}</td>
                    <td className="tnum">{r.tokens.toLocaleString("pt-BR")}</td>
                    <td className="tnum">${r.charge.toFixed(4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

function UseStat({ lbl, val }: { lbl: string; val: string }) {
  return (
    <div className="row between">
      <span className="muted" style={{ fontSize: 13 }}>{lbl}</span>
      <span className="tnum" style={{ fontSize: 16, fontWeight: 600 }}>{val}</span>
    </div>
  );
}
