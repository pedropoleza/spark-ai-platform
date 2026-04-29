/**
 * Sparkbot Web — painel de chat (renderizado dentro do iframe injetado pelo
 * loader.js no GHL).
 *
 * Recebe `?token=...&repName=...` na URL. Token é o JWT do /check-admin.
 * Toda chamada à API usa esse token no Authorization header.
 *
 * Stack: client component standalone — sem auth do dashboard, sem layout
 * do app. Renderiza sozinho dentro do iframe.
 */

"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";

interface Message {
  id: string;
  role: "user" | "agent";
  content: string;
  channel: string;
  created_at: string;
  is_read: boolean;
  is_proactive: boolean;
}

function SparkbotPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [repName, setRepName] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Lê token+repName da URL na primeira render
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
    setRepName(params.get("repName") || "");
  }, []);

  // Auto-scroll pro fim quando msgs mudam
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  // Polling do inbox a cada 5s enquanto painel aberto (3x mais rápido que
  // o loader do header — quando rep está olhando, queremos resposta rápida)
  useEffect(() => {
    if (!token) return;
    const fetchInbox = async () => {
      try {
        const res = await fetch(`/api/sparkbot/inbox?limit=50`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.messages)) {
          setMessages(data.messages);
          // Marca como lidas (rep tá olhando o painel)
          fetch(`/api/sparkbot/inbox`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message_ids: [] }),
          }).catch(() => {});
        }
      } catch { /* ignora erros transientes */ }
    };
    fetchInbox();
    const iv = setInterval(fetchInbox, 5000);
    return () => clearInterval(iv);
  }, [token]);

  const sendMessage = useCallback(async () => {
    if (!token || !input.trim() || sending) return;
    const text = input.trim();
    setInput("");
    setSending(true);
    setError(null);

    // Optimistic: adiciona msg do user na UI imediatamente
    const optimisticMsg: Message = {
      id: `tmp-${Date.now()}`,
      role: "user",
      content: text,
      channel: "web_ui",
      created_at: new Date().toISOString(),
      is_read: true,
      is_proactive: false,
    };
    setMessages((prev) => [...prev, optimisticMsg]);

    try {
      const res = await fetch(`/api/sparkbot/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.reason || "erro ao enviar");
        // Remove optimistic
        setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
        return;
      }
      // Resposta do agent vai ser pega no próximo poll do inbox
    } catch (err) {
      setError("falha de rede");
      setMessages((prev) => prev.filter((m) => m.id !== optimisticMsg.id));
    } finally {
      setSending(false);
    }
  }, [token, input, sending]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!token) {
    return (
      <div style={s.empty}>
        <p>Token ausente. Recarregue o GHL.</p>
      </div>
    );
  }

  return (
    <div style={s.root}>
      <div style={s.scroll} ref={scrollRef}>
        {messages.length === 0 ? (
          <div style={s.welcome}>
            <h2 style={s.h2}>Sparkbot</h2>
            <p style={s.welcomeText}>
              Oi{repName ? ` ${repName}` : ""}, sou seu copiloto. Posso ler e mexer no GHL — pesquisar contatos, criar notes/tasks, agendar appointments, tirar dúvidas sobre NLG e Brazillionaires.
            </p>
            <p style={s.welcomeHint}>Manda uma pergunta ou pedido pra começar.</p>
          </div>
        ) : (
          messages.map((m) => <MessageBubble key={m.id} msg={m} />)
        )}
        {sending && (
          <div style={{ ...s.bubble, ...s.agentBubble, opacity: 0.6 }}>
            <span style={s.typing}>•••</span>
          </div>
        )}
      </div>

      {error && <div style={s.error}>Erro: {error}</div>}

      <div style={s.composer}>
        <textarea
          style={s.textarea}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Manda uma mensagem… (Enter pra enviar, Shift+Enter pra quebrar linha)"
          rows={2}
          disabled={sending}
        />
        <button
          style={{ ...s.sendBtn, opacity: input.trim() && !sending ? 1 : 0.4 }}
          onClick={sendMessage}
          disabled={!input.trim() || sending}
        >
          {sending ? "…" : "Enviar"}
        </button>
      </div>
    </div>
  );
}

function MessageBubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const time = new Date(msg.created_at).toLocaleTimeString("pt-BR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  return (
    <div
      style={{
        ...s.bubbleRow,
        justifyContent: isUser ? "flex-end" : "flex-start",
      }}
    >
      <div
        style={{
          ...s.bubble,
          ...(isUser ? s.userBubble : s.agentBubble),
        }}
      >
        <div style={s.bubbleContent}>{msg.content}</div>
        <div style={s.bubbleMeta}>
          {msg.is_proactive && <span style={s.tag}>proativa</span>}
          {msg.channel === "whatsapp" && <span style={s.tag}>WhatsApp</span>}
          <span>{time}</span>
        </div>
      </div>
    </div>
  );
}

const s: Record<string, React.CSSProperties> = {
  root: {
    display: "flex",
    flexDirection: "column",
    height: "100vh",
    background: "#f8fafc",
    fontFamily: "system-ui, -apple-system, sans-serif",
  },
  empty: {
    padding: 32,
    textAlign: "center",
    color: "#6b7280",
    fontFamily: "system-ui, sans-serif",
  },
  scroll: {
    flex: 1,
    overflowY: "auto",
    padding: 16,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  welcome: {
    padding: 24,
    background: "white",
    borderRadius: 12,
    border: "1px solid #e5e7eb",
  },
  h2: { margin: "0 0 8px", fontSize: 18, color: "#111827" },
  welcomeText: { margin: "0 0 8px", color: "#374151", lineHeight: 1.5 },
  welcomeHint: { margin: 0, color: "#9ca3af", fontSize: 13 },
  bubbleRow: { display: "flex" },
  bubble: {
    maxWidth: "85%",
    padding: "10px 14px",
    borderRadius: 16,
    fontSize: 14,
    lineHeight: 1.5,
  },
  userBubble: {
    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
    color: "white",
    borderBottomRightRadius: 4,
  },
  agentBubble: {
    background: "white",
    color: "#111827",
    border: "1px solid #e5e7eb",
    borderBottomLeftRadius: 4,
  },
  bubbleContent: { whiteSpace: "pre-wrap", wordBreak: "break-word" },
  bubbleMeta: {
    marginTop: 4,
    fontSize: 11,
    opacity: 0.7,
    display: "flex",
    gap: 6,
    flexWrap: "wrap",
  },
  tag: {
    padding: "1px 6px",
    background: "rgba(0,0,0,0.06)",
    borderRadius: 4,
    fontSize: 10,
    fontWeight: 500,
  },
  typing: { fontSize: 18, letterSpacing: 2 },
  error: {
    padding: "8px 16px",
    background: "#fef2f2",
    color: "#dc2626",
    borderTop: "1px solid #fecaca",
    fontSize: 13,
  },
  composer: {
    display: "flex",
    gap: 8,
    padding: 12,
    background: "white",
    borderTop: "1px solid #e5e7eb",
    alignItems: "flex-end",
  },
  textarea: {
    flex: 1,
    padding: "10px 12px",
    fontSize: 14,
    border: "1px solid #d1d5db",
    borderRadius: 10,
    resize: "none",
    outline: "none",
    fontFamily: "inherit",
    lineHeight: 1.5,
  },
  sendBtn: {
    padding: "10px 16px",
    background: "linear-gradient(135deg, #6366f1, #8b5cf6)",
    color: "white",
    border: 0,
    borderRadius: 10,
    fontSize: 14,
    fontWeight: 600,
    cursor: "pointer",
    transition: "opacity 0.2s",
  },
};

// Wrapper Suspense é defesa pro Next 15: useSearchParams hook precisa
// de Suspense boundary mesmo sendo chamado indiretamente.
export default function Page() {
  return (
    <Suspense fallback={<div>Carregando…</div>}>
      <SparkbotPanel />
    </Suspense>
  );
}
