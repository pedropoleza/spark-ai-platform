"use client";

import { useEffect } from "react";
import { AlertTriangle } from "lucide-react";

/**
 * Error boundary do /hub (fix C1 ultra-review 2026-05-26). Sem ele, um throw num
 * loader (ex: query falhando) quebrava a estética inteira dentro do iframe do
 * Spark Leads. Agora mostra um card amigável com "tentar de novo" (reset).
 */
export default function HubError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[hub] erro de renderização:", error?.message, error?.digest);
  }, [error]);

  return (
    <div className="page" style={{ display: "grid", placeItems: "center", minHeight: 360 }}>
      <div className="card" style={{ maxWidth: 440, textAlign: "center", padding: 28 }}>
        <AlertTriangle size={22} style={{ color: "var(--warning)", margin: "0 auto 10px" }} />
        <h3 style={{ fontSize: 16, marginBottom: 6 }}>Algo deu errado</h3>
        <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 16 }}>
          Não consegui carregar esta tela. Tente de novo — se continuar, recarregue a página.
        </p>
        <button className="btn btn--primary" onClick={reset}>Tentar de novo</button>
      </div>
    </div>
  );
}
