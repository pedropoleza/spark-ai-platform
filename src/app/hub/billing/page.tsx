import { CreditCard } from "lucide-react";

export default function BillingPage() {
  return (
    <div className="page">
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Faturamento</h1>
          <p className="page-hd__sub">Sua assinatura, agentes pagos e uso do mês.</p>
        </div>
      </div>
      <div className="card">
        <div className="empty">
          <CreditCard size={32} style={{ color: "var(--ink-4)" }} />
          <p style={{ marginTop: 12 }}>Os dados de faturamento entram na próxima fase.</p>
        </div>
      </div>
    </div>
  );
}
