"use client";

import { useEffect, useRef, useState } from "react";
import { X, Send } from "lucide-react";
import { AMark } from "@/components/hub/primitives";

type Msg = { from: "user" | "bot" | "err"; text: string };

/**
 * Chat de teste inline (lead agents). Bate no /api/agents/test, que NÃO escreve
 * no CRM (execute_actions default false) — é simulação pura. Histórico fica numa
 * agent_test_session efêmera no backend.
 */
export function TestChat({
  agentId,
  agentName,
  templateKey,
  onClose,
}: {
  agentId: string;
  agentName: string;
  templateKey: string;
  onClose: () => void;
}) {
  const [msgs, setMsgs] = useState<Msg[]>([
    { from: "bot", text: `Modo teste de "${agentName}". Simule uma mensagem que um lead enviaria.` },
  ]);
  const [val, setVal] = useState("");
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs, loading]);

  async function send() {
    const text = val.trim();
    if (!text || loading) return;
    setMsgs((m) => [...m, { from: "user", text }]);
    setVal("");
    setLoading(true);
    try {
      const res = await fetch("/api/agents/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent_id: agentId, message: text, session_id: sessionId }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "falha no teste");
      if (data.session_id) setSessionId(data.session_id);
      const raw = data.response?.message;
      const reply = Array.isArray(raw) ? raw.join("\n") : raw || "(sem resposta)";
      setMsgs((m) => [...m, { from: "bot", text: reply }]);
    } catch (err) {
      setMsgs((m) => [...m, { from: "err", text: "Não consegui responder: " + (err instanceof Error ? err.message : "erro") }]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 95, display: "grid", placeItems: "center" }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="card"
        style={{ width: "min(560px, 94vw)", maxHeight: "84vh", display: "flex", flexDirection: "column", boxShadow: "var(--shadow-3)" }}
      >
        <div className="card-hd">
          <div className="row" style={{ gap: 10 }}>
            <AMark templateKey={templateKey} size="sm" />
            <div>
              <h3 style={{ fontSize: 14, margin: 0 }}>{agentName}</h3>
              <div style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Modo teste · não escreve no Spark Leads</div>
            </div>
          </div>
          <button className="btn btn--quiet btn--icon" onClick={onClose} aria-label="Fechar">
            <X />
          </button>
        </div>

        <div
          ref={scrollRef}
          className="scroll"
          style={{ flex: 1, padding: 16, overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, minHeight: 280 }}
        >
          {msgs.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.from === "user" ? "flex-end" : "flex-start",
                maxWidth: "80%",
                padding: "9px 12px",
                borderRadius: 12,
                background: m.from === "user" ? "var(--primary)" : m.from === "err" ? "var(--danger-soft)" : "var(--surface-2)",
                color: m.from === "user" ? "#fff" : m.from === "err" ? "var(--danger)" : "var(--ink)",
                fontSize: 13.5,
                lineHeight: 1.45,
                whiteSpace: "pre-wrap",
              }}
            >
              {m.text}
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: "flex-start", fontSize: 12.5, color: "var(--ink-3)", padding: "4px 6px" }}>digitando…</div>
          )}
        </div>

        <div style={{ padding: 12, borderTop: "1px solid var(--line)", display: "flex", gap: 8 }}>
          <input
            className="input"
            placeholder="Digite uma mensagem de lead…"
            value={val}
            onChange={(e) => setVal(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && send()}
            autoFocus
          />
          <button className="btn btn--primary" onClick={send} disabled={loading || !val.trim()} aria-label="Enviar">
            <Send size={14} />
          </button>
        </div>
      </div>
    </div>
  );
}
