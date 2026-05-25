import { Settings } from "lucide-react";

export default function SettingsPage() {
  return (
    <div className="page" style={{ maxWidth: 920 }}>
      <div className="page-hd">
        <div>
          <h1 className="page-hd__title">Conta</h1>
          <p className="page-hd__sub">Preferências da sua agência.</p>
        </div>
      </div>
      <div className="card">
        <div className="empty">
          <Settings size={32} style={{ color: "var(--ink-4)" }} />
          <p style={{ marginTop: 12 }}>As preferências da conta entram na próxima fase.</p>
        </div>
      </div>
    </div>
  );
}
