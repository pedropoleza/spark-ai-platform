"use client";

import { useEffect } from "react";
import { AlertTriangle, WifiOff, Lock, Search, Clock } from "lucide-react";

/**
 * Error boundary do /hub (fix C1 ultra-review 2026-05-26). Sem ele, um throw num
 * loader (ex: query falhando) quebrava a estética inteira dentro do iframe do
 * Spark Leads. Agora mostra um card amigável com "tentar de novo" (reset).
 *
 * Etapa 3.7 (Pedro 2026-05-28): diferencia contexto do erro (404/timeout/auth/
 * network/genérico) pra mensagem ficar mais útil.
 */

type ErrorKind = "not_found" | "timeout" | "unauthorized" | "network" | "generic";

function classifyError(error: Error & { digest?: string }): {
  kind: ErrorKind;
  title: string;
  detail: string;
  Icon: typeof AlertTriangle;
} {
  const msg = (error?.message || "").toLowerCase();
  if (/404|not[\s_-]?found|notfound/.test(msg)) {
    return {
      kind: "not_found",
      title: "Não achei o que você procura",
      detail: "Pode ter sido removido ou nunca existiu. Volte pra tela anterior e tente outro caminho.",
      Icon: Search,
    };
  }
  if (/timeout|timed[\s_-]?out|etimedout|deadline/.test(msg)) {
    return {
      kind: "timeout",
      title: "Demorou demais",
      detail: "A consulta ao Spark Leads passou do tempo. Pode ser instabilidade momentânea — tente de novo em alguns segundos.",
      Icon: Clock,
    };
  }
  if (/unauthor|401|403|forbidden|auth|jwt|token/.test(msg)) {
    return {
      kind: "unauthorized",
      title: "Sessão expirou",
      detail: "Sua sessão pode ter caído. Atualize a página pra fazer login de novo.",
      Icon: Lock,
    };
  }
  if (/network|fetch failed|econnref|enotfound|disconnected/.test(msg)) {
    return {
      kind: "network",
      title: "Sem conexão",
      detail: "Não consegui falar com o servidor. Confira sua internet e tente de novo.",
      Icon: WifiOff,
    };
  }
  return {
    kind: "generic",
    title: "Algo deu errado",
    detail: "Não consegui carregar esta tela. Tente de novo — se continuar, recarregue a página.",
    Icon: AlertTriangle,
  };
}

export default function HubError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[hub] erro de renderização:", error?.message, error?.digest);
  }, [error]);

  const { title, detail, Icon, kind } = classifyError(error);

  return (
    <div className="page" style={{ display: "grid", placeItems: "center", minHeight: 360 }}>
      <div className="card" style={{ maxWidth: 460, textAlign: "center", padding: 28 }}>
        <Icon
          size={22}
          style={{
            color: kind === "network" || kind === "unauthorized" ? "var(--danger, #ef4444)" : "var(--warning)",
            margin: "0 auto 10px",
          }}
        />
        <h3 style={{ fontSize: 16, marginBottom: 6 }}>{title}</h3>
        <p className="muted" style={{ fontSize: 13.5, lineHeight: 1.5, marginBottom: 16 }}>
          {detail}
        </p>
        <div className="row" style={{ gap: 8, justifyContent: "center" }}>
          {kind === "unauthorized" ? (
            <button className="btn btn--primary" onClick={() => window.location.reload()}>
              Recarregar
            </button>
          ) : (
            <button className="btn btn--primary" onClick={reset}>
              Tentar de novo
            </button>
          )}
        </div>
        {error?.digest && (
          <div className="muted" style={{ fontSize: 11, marginTop: 12, fontFamily: "monospace" }}>
            ref: {error.digest}
          </div>
        )}
      </div>
    </div>
  );
}
