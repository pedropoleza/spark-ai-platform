import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth/sso";
import { loadBilling } from "@/lib/hub/data";
import { AMark } from "@/components/hub/primitives";

export const dynamic = "force-dynamic";

const TPL_LABEL: Record<string, string> = { sales: "Vendas", recruitment: "Recrutamento", custom: "Personalizado", sparkbot: "SparkBot" };

export default async function BillingPage() {
  const session = await getSession();
  if (!session) redirect("/");

  const b = await loadBilling(session.locationId);

  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Faturamento</h1>
          <p className="page-hd__sub">Assinatura, agentes pagos e uso do mês.</p>
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

        {/* Uso este mês */}
        <div className="card">
          <div className="card-hd"><h3>Uso este mês</h3></div>
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
          <div className="empty">Sem atividade de cobrança este mês.</div>
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
