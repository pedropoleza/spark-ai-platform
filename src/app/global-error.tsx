"use client";

// global-error captura erros FATAIS de render do App Router (inclusive falhas no
// root layout). Reporta pro Sentry e mostra um fallback mínimo on-brand. Só dispara
// em erro que derruba a árvore inteira de UI — o caso que mais precisa de alerta.
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="pt-BR">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", background: "#f9fafb", color: "#111827" }}>
        <div
          style={{
            minHeight: "100vh",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            gap: 16,
            padding: 24,
            textAlign: "center",
          }}
        >
          <h2 style={{ margin: 0, fontSize: 20, fontWeight: 600 }}>Algo deu errado</h2>
          <p style={{ margin: 0, color: "#6b7280", maxWidth: 420 }}>
            Tivemos um erro inesperado nesta tela. Já fomos notificados. Tente recarregar.
          </p>
          <button
            onClick={() => reset()}
            style={{
              background: "#1675F2",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: "10px 20px",
              fontSize: 14,
              fontWeight: 500,
              cursor: "pointer",
            }}
          >
            Tentar de novo
          </button>
        </div>
      </body>
    </html>
  );
}
