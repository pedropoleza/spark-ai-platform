import { Loader2 } from "lucide-react";

/**
 * Loading boundary do /hub (fix C1 ultra-review 2026-05-26). As telas são
 * force-dynamic com várias queries; sem este boundary o iframe ficava em branco
 * durante o fetch. On-brand, leve.
 */
export default function HubLoading() {
  return (
    <div className="page" style={{ display: "grid", placeItems: "center", minHeight: 320 }}>
      <div className="row" style={{ gap: 10, color: "var(--ink-3)", fontSize: 14 }}>
        <Loader2 size={18} className="animate-spin" />
        Carregando…
      </div>
    </div>
  );
}
