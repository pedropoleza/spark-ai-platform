/**
 * Sparkbot Web — painel de chat (renderizado dentro do iframe injetado pelo
 * loader.js no painel da Spark Leads).
 *
 * Aesthetic direction: refined-tech. Branca/azul (Spark blue #1675F2),
 * mascote robô amigável, micro-animações sutis, tipografia balanceada.
 *
 * Comportamento:
 *   - Recebe ?token=...&repName=... na URL
 *   - sendMessage usa result.text da resposta direta (não depende de polling)
 *   - Áudio via MediaRecorder → POST /api/sparkbot/transcribe → texto na composer
 *   - Polling do inbox 5s pra capturar mensagens proativas (lembretes)
 */

"use client";

import { useEffect, useRef, useState, useCallback, Suspense } from "react";

interface Message {
  id: string;
  role: "user" | "agent";
  content: string;
  channel: string;
  created_at: string;
  is_proactive?: boolean;
  pending?: boolean;
}

const SUGGESTIONS = [
  "Quem tá na minha agenda hoje?",
  "Resume meus opps abertos",
  "Cliente diabético — qual rate no FlexLife?",
  "Como funciona Emergency Contact List?",
];

function SparkbotPanel() {
  const [token, setToken] = useState<string | null>(null);
  const [repName, setRepName] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  const [recDuration, setRecDuration] = useState(0);
  const [transcribing, setTranscribing] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const recChunks = useRef<Blob[]>([]);
  const recTimer = useRef<NodeJS.Timeout | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Boot: lê token + repName da URL
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    setToken(params.get("token"));
    setRepName(params.get("repName") || "");
  }, []);

  // Auto-scroll
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, sending]);

  // Polling do inbox (só pra mensagens proativas — não dependemos pra resposta direta)
  useEffect(() => {
    if (!token) return;
    const fetchInbox = async () => {
      try {
        const res = await fetch(`/api/sparkbot/inbox?limit=50`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (data.ok && Array.isArray(data.messages)) {
          // Mescla com optimistic local: mantém locais não persistidos no fim
          setMessages((prev) => {
            const serverIds = new Set(data.messages.map((m: Message) => m.id));
            const locals = prev.filter((m) => m.id.startsWith("tmp-") && !serverIds.has(m.id));
            return [...data.messages, ...locals];
          });
          // Mark all read (rep tá olhando o painel)
          fetch(`/api/sparkbot/inbox`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message_ids: [] }),
          }).catch(() => {});
        }
      } catch { /* silencia */ }
    };
    fetchInbox();
    const iv = setInterval(fetchInbox, 6000);
    return () => clearInterval(iv);
  }, [token]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    if (!token || sending) return;
    const text = (overrideText ?? input).trim();
    if (!text) return;
    setInput("");
    setSending(true);
    setError(null);

    const userTmpId = `tmp-u-${Date.now()}`;
    const agentTmpId = `tmp-a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: userTmpId, role: "user", content: text, channel: "web_ui", created_at: new Date().toISOString() },
      { id: agentTmpId, role: "agent", content: "", channel: "web_ui", created_at: new Date().toISOString(), pending: true },
    ]);

    try {
      const res = await fetch(`/api/sparkbot/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: text }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.reason || "erro ao enviar");
        setMessages((prev) => prev.filter((m) => m.id !== agentTmpId));
        return;
      }
      // FIX: resposta vem no body do POST send, não esperamos polling
      setMessages((prev) =>
        prev.map((m) =>
          m.id === agentTmpId
            ? { ...m, content: data.text || "(sem resposta)", pending: false }
            : m,
        ),
      );
    } catch {
      setError("falha de rede");
      setMessages((prev) => prev.filter((m) => m.id !== agentTmpId));
    } finally {
      setSending(false);
      // Re-foca no input
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [token, input, sending]);

  // ---------- Áudio (MediaRecorder) ----------
  const startRecording = useCallback(async () => {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // webm/opus tem ótimo ratio de tamanho/qualidade e é aceito pelo Whisper
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : "audio/webm";
      const rec = new MediaRecorder(stream, { mimeType });
      recChunks.current = [];
      rec.ondataavailable = (e) => { if (e.data.size > 0) recChunks.current.push(e.data); };
      rec.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        const blob = new Blob(recChunks.current, { type: mimeType });
        if (blob.size < 1000) {
          setError("áudio muito curto");
          return;
        }
        await uploadAudio(blob);
      };
      rec.start();
      mediaRec.current = rec;
      setRecording(true);
      setRecDuration(0);
      const startTs = Date.now();
      recTimer.current = setInterval(() => setRecDuration(Math.floor((Date.now() - startTs) / 1000)), 250);
    } catch (err) {
      setError("permissão de microfone negada");
      console.warn("[Sparkbot] mic error:", err);
    }
  }, []);

  const stopRecording = useCallback(() => {
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    if (mediaRec.current && mediaRec.current.state !== "inactive") mediaRec.current.stop();
    setRecording(false);
  }, []);

  const cancelRecording = useCallback(() => {
    if (recTimer.current) { clearInterval(recTimer.current); recTimer.current = null; }
    if (mediaRec.current && mediaRec.current.state !== "inactive") {
      mediaRec.current.onstop = null; // skip upload
      mediaRec.current.stop();
      mediaRec.current.stream.getTracks().forEach((t) => t.stop());
    }
    recChunks.current = [];
    setRecording(false);
    setRecDuration(0);
  }, []);

  const uploadAudio = useCallback(async (blob: Blob) => {
    if (!token) return;
    setTranscribing(true);
    try {
      const fd = new FormData();
      fd.append("audio", blob, "rec.webm");
      const res = await fetch(`/api/sparkbot/transcribe`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json();
      if (data.ok && data.text) {
        // Auto-envia direto (UX igual WhatsApp). Se rep quiser editar, é
        // só não soltar o gravar — alternativa futura: setInput primeiro
        // e deixar rep editar antes de clicar enviar.
        await sendMessage(data.text);
      } else {
        setError(data.reason || "transcrição falhou");
      }
    } catch {
      setError("falha de rede no áudio");
    } finally {
      setTranscribing(false);
    }
  }, [token, sendMessage]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  if (!token) {
    return (
      <div className="empty">
        <p>Sessão expirada. Recarregue o painel.</p>
        <style jsx>{`
          .empty { padding: 32px; text-align: center; color: #64748b; font-family: var(--sb-font); }
        `}</style>
      </div>
    );
  }

  return (
    <div className="root">
      {/* HEADER */}
      <header className="header">
        <Mascot size={36} animated />
        <div className="header-text">
          <div className="header-title">SparkBot</div>
          <div className="header-sub">copiloto IA · Spark Leads</div>
        </div>
        <span className="header-status" title="online">
          <span className="dot" />
        </span>
      </header>

      {/* CHAT BODY */}
      <div className="scroll" ref={scrollRef}>
        {messages.length === 0 ? (
          <Welcome
            repName={repName}
            onPick={(s) => { setInput(s); textareaRef.current?.focus(); }}
          />
        ) : (
          <div className="messages">
            {messages.map((m) => <Bubble key={m.id} msg={m} />)}
          </div>
        )}
      </div>

      {error && <div className="error" onClick={() => setError(null)}>⚠ {error} <span style={{ opacity: 0.5 }}>(clique pra fechar)</span></div>}

      {/* COMPOSER */}
      {recording ? (
        <div className="rec-bar">
          <div className="rec-pulse"><span className="rec-dot" /></div>
          <div className="rec-info">
            <span className="rec-label">Gravando…</span>
            <span className="rec-time">{formatTime(recDuration)}</span>
          </div>
          <button className="rec-cancel" onClick={cancelRecording} title="Cancelar">×</button>
          <button className="rec-stop" onClick={stopRecording} title="Enviar áudio">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>
          </button>
        </div>
      ) : (
        <div className="composer">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={transcribing ? "Transcrevendo…" : "Manda uma pergunta ou pedido"}
            rows={1}
            disabled={sending || transcribing}
            className="textarea"
          />
          <button
            className="mic-btn"
            onClick={startRecording}
            disabled={sending || transcribing}
            title="Gravar áudio"
            aria-label="Gravar áudio"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="2" width="6" height="12" rx="3"/>
              <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
              <line x1="12" y1="19" x2="12" y2="23"/>
            </svg>
          </button>
          <button
            className="send-btn"
            onClick={() => sendMessage()}
            disabled={!input.trim() || sending || transcribing}
            title="Enviar"
            aria-label="Enviar"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"/>
              <polygon points="22 2 15 22 11 13 2 9 22 2" fill="currentColor"/>
            </svg>
          </button>
        </div>
      )}

      <style jsx global>{`
        :root {
          --sb-brand: #1675F2;
          --sb-brand-2: #2980F2;
          --sb-brand-glow: rgba(22, 117, 242, 0.18);
          --sb-bg: #f8fafc;
          --sb-surface: #ffffff;
          --sb-border: #e5e7eb;
          --sb-text: #0f172a;
          --sb-muted: #64748b;
          --sb-font: 'Open Sans', -apple-system, BlinkMacSystemFont, system-ui, sans-serif;
        }
        body, html { margin: 0; padding: 0; font-family: var(--sb-font); }
        * { box-sizing: border-box; }
      `}</style>

      <style jsx>{`
        .root {
          display: flex;
          flex-direction: column;
          height: 100vh;
          background:
            radial-gradient(circle at 100% 0%, rgba(22,117,242,0.04) 0%, transparent 380px),
            radial-gradient(circle at 0% 100%, rgba(41,128,242,0.03) 0%, transparent 380px),
            var(--sb-bg);
          font-family: var(--sb-font);
          color: var(--sb-text);
        }
        .header {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 18px;
          background: linear-gradient(180deg, #ffffff 0%, rgba(255,255,255,0.85) 100%);
          backdrop-filter: blur(8px);
          border-bottom: 1px solid var(--sb-border);
          box-shadow: 0 1px 0 rgba(15,23,42,0.04);
          position: sticky; top: 0; z-index: 10;
        }
        .header-text { flex: 1; min-width: 0; }
        .header-title {
          font-weight: 700;
          font-size: 16px;
          line-height: 1.2;
          letter-spacing: -0.01em;
          color: var(--sb-text);
        }
        .header-sub {
          font-size: 11px;
          color: var(--sb-muted);
          letter-spacing: 0.02em;
          text-transform: uppercase;
          margin-top: 2px;
        }
        .header-status {
          width: 28px; height: 28px; display: flex; align-items: center; justify-content: center;
        }
        .dot {
          display: block; width: 8px; height: 8px; border-radius: 50%;
          background: #10b981;
          box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18);
          animation: dotPulse 2.4s ease-in-out infinite;
        }
        @keyframes dotPulse {
          0%, 100% { box-shadow: 0 0 0 3px rgba(16, 185, 129, 0.18); }
          50% { box-shadow: 0 0 0 6px rgba(16, 185, 129, 0.06); }
        }
        .scroll {
          flex: 1;
          overflow-y: auto;
          padding: 16px;
          scrollbar-width: thin;
          scrollbar-color: rgba(148,163,184,0.4) transparent;
        }
        .scroll::-webkit-scrollbar { width: 8px; }
        .scroll::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.35); border-radius: 8px; }
        .scroll::-webkit-scrollbar-thumb:hover { background: rgba(148,163,184,0.55); }
        .messages { display: flex; flex-direction: column; gap: 10px; padding-bottom: 4px; }
        .error {
          padding: 10px 16px;
          background: linear-gradient(180deg, #fef2f2, #fee2e2);
          color: #b91c1c;
          border-top: 1px solid #fecaca;
          font-size: 13px;
          cursor: pointer;
        }

        .composer {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          padding: 12px 14px;
          background: rgba(255,255,255,0.95);
          backdrop-filter: blur(8px);
          border-top: 1px solid var(--sb-border);
        }
        .textarea {
          flex: 1;
          padding: 10px 14px;
          font-size: 14px;
          line-height: 1.5;
          font-family: var(--sb-font);
          color: var(--sb-text);
          background: var(--sb-bg);
          border: 1px solid var(--sb-border);
          border-radius: 14px;
          resize: none;
          outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
          max-height: 120px;
        }
        .textarea:focus {
          border-color: var(--sb-brand);
          box-shadow: 0 0 0 4px var(--sb-brand-glow);
          background: var(--sb-surface);
        }
        .textarea:disabled { opacity: 0.6; }
        .mic-btn, .send-btn {
          width: 38px;
          height: 38px;
          flex-shrink: 0;
          border: 0;
          border-radius: 12px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.12s, box-shadow 0.15s, background 0.15s;
        }
        .mic-btn {
          background: var(--sb-bg);
          color: var(--sb-muted);
          border: 1px solid var(--sb-border);
        }
        .mic-btn:hover:not(:disabled) {
          color: var(--sb-brand);
          border-color: var(--sb-brand);
          background: rgba(22,117,242,0.04);
        }
        .send-btn {
          background: linear-gradient(135deg, var(--sb-brand) 0%, var(--sb-brand-2) 100%);
          color: white;
          box-shadow: 0 4px 12px var(--sb-brand-glow);
        }
        .send-btn:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 6px 16px var(--sb-brand-glow);
        }
        .send-btn:active:not(:disabled) { transform: translateY(0); }
        .send-btn:disabled, .mic-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* Recording bar */
        .rec-bar {
          display: flex;
          align-items: center;
          gap: 12px;
          padding: 14px 18px;
          background: linear-gradient(135deg, #fef2f2 0%, #fff 100%);
          border-top: 1px solid #fecaca;
          animation: slideUp 0.2s ease-out;
        }
        @keyframes slideUp {
          from { transform: translateY(8px); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        .rec-pulse {
          width: 36px; height: 36px;
          display: flex; align-items: center; justify-content: center;
          border-radius: 50%;
          background: rgba(239, 68, 68, 0.12);
          animation: ringPulse 1.4s ease-in-out infinite;
        }
        @keyframes ringPulse {
          0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.18); }
          50% { box-shadow: 0 0 0 8px rgba(239,68,68,0); }
        }
        .rec-dot {
          width: 10px; height: 10px; border-radius: 50%;
          background: #ef4444;
        }
        .rec-info { flex: 1; display: flex; flex-direction: column; }
        .rec-label { font-weight: 600; color: #dc2626; font-size: 13px; }
        .rec-time { font-size: 12px; color: #991b1b; font-variant-numeric: tabular-nums; }
        .rec-cancel, .rec-stop {
          width: 38px; height: 38px;
          border: 0; border-radius: 12px; cursor: pointer;
          display: inline-flex; align-items: center; justify-content: center;
          transition: transform 0.12s, background 0.15s;
        }
        .rec-cancel {
          background: var(--sb-bg);
          color: var(--sb-muted);
          font-size: 22px; line-height: 1;
          border: 1px solid var(--sb-border);
        }
        .rec-cancel:hover { background: #fef2f2; color: #dc2626; border-color: #fecaca; }
        .rec-stop {
          background: linear-gradient(135deg, #ef4444, #dc2626);
          color: white;
          box-shadow: 0 4px 10px rgba(239,68,68,0.3);
        }
        .rec-stop:hover { transform: translateY(-1px); }
      `}</style>
    </div>
  );
}

/* ============================================================
 *  MASCOT — robôzinho amigável, SVG inline
 *  Animações: piscar olhos, antena pulsando, "respirando"
 * ============================================================ */
function Mascot({ size = 36, animated = false }: { size?: number; animated?: boolean }) {
  return (
    <div className={animated ? "m-wrap m-anim" : "m-wrap"} style={{ width: size, height: size }}>
      <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden>
        <defs>
          <linearGradient id="bodyG" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#2980F2" />
            <stop offset="1" stopColor="#1267D8" />
          </linearGradient>
          <linearGradient id="faceG" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#0E54B0" />
            <stop offset="1" stopColor="#062E60" />
          </linearGradient>
          <radialGradient id="eyeG" cx="0.5" cy="0.4" r="0.6">
            <stop offset="0" stopColor="#9be3ff" />
            <stop offset="0.7" stopColor="#5eb5ff" />
            <stop offset="1" stopColor="#1675F2" />
          </radialGradient>
        </defs>
        {/* antena */}
        <line x1="32" y1="10" x2="32" y2="18" stroke="#1267D8" strokeWidth="2" strokeLinecap="round" />
        <circle cx="32" cy="8" r="3" fill="#1675F2" className="antena-dot" />
        {/* corpo (cabeça redonda) */}
        <rect x="10" y="16" width="44" height="38" rx="14" fill="url(#bodyG)" />
        {/* visor escuro */}
        <rect x="16" y="22" width="32" height="22" rx="8" fill="url(#faceG)" />
        {/* olhos (azuis brilhantes) */}
        <circle cx="25" cy="33" r="3.4" fill="url(#eyeG)" className="eye eye-l" />
        <circle cx="39" cy="33" r="3.4" fill="url(#eyeG)" className="eye eye-r" />
        {/* sorriso (linha leve) */}
        <path d="M27 39 Q32 42 37 39" stroke="#5eb5ff" strokeWidth="1.6" strokeLinecap="round" fill="none" />
        {/* base/queixo */}
        <rect x="26" y="50" width="12" height="6" rx="3" fill="#0E54B0" />
        {/* highlights */}
        <ellipse cx="20" cy="22" rx="4" ry="2" fill="rgba(255,255,255,0.18)" />
      </svg>
      <style jsx>{`
        .m-wrap { display: inline-block; flex-shrink: 0; }
        .m-anim svg { animation: breathe 3.6s ease-in-out infinite; transform-origin: center; }
        @keyframes breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.04); }
        }
        .m-anim .antena-dot { animation: blip 2s ease-in-out infinite; transform-origin: 32px 8px; }
        @keyframes blip {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; transform: scale(1.3); }
        }
        .m-anim .eye { animation: blink 5s ease-in-out infinite; transform-origin: center; transform-box: fill-box; }
        @keyframes blink {
          0%, 92%, 96%, 100% { transform: scaleY(1); }
          94% { transform: scaleY(0.1); }
        }
      `}</style>
    </div>
  );
}

/* ============================================================
 *  WELCOME
 * ============================================================ */
function Welcome({ repName, onPick }: { repName: string; onPick: (s: string) => void }) {
  return (
    <div className="wrap">
      <div className="hero">
        <Mascot size={72} animated />
      </div>
      <h2 className="title">Oi{repName ? ` ${repName.split(" ")[0]}` : ""} 👋</h2>
      <p className="sub">
        Seu copiloto pronto pra acelerar o dia. Pesquiso contatos, crio notes e tasks,
        agendo lembretes e respondo dúvidas técnicas.
      </p>
      <div className="suggestions">
        <div className="sug-label">Pra começar:</div>
        {SUGGESTIONS.map((s, i) => (
          <button key={i} className="sug" onClick={() => onPick(s)} style={{ animationDelay: `${0.05 * (i + 1)}s` }}>
            <span className="sug-arrow">→</span> <span>{s}</span>
          </button>
        ))}
      </div>
      <style jsx>{`
        .wrap {
          padding: 32px 16px 12px;
          display: flex; flex-direction: column; align-items: center; text-align: center;
          animation: fade 0.4s ease-out;
        }
        @keyframes fade { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .hero { margin-bottom: 16px; filter: drop-shadow(0 8px 20px rgba(22,117,242,0.22)); }
        .title {
          margin: 0 0 6px;
          font-size: 22px;
          font-weight: 700;
          letter-spacing: -0.02em;
          color: #0f172a;
        }
        .sub {
          margin: 0 8px 24px;
          color: #475569;
          font-size: 14px;
          line-height: 1.55;
          max-width: 360px;
        }
        .suggestions {
          width: 100%;
          max-width: 380px;
          display: flex;
          flex-direction: column;
          gap: 8px;
          margin-top: 4px;
        }
        .sug-label {
          font-size: 11px;
          font-weight: 600;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: #94a3b8;
          margin-bottom: 6px;
          text-align: left;
        }
        .sug {
          display: flex;
          align-items: center;
          gap: 10px;
          padding: 12px 14px;
          background: white;
          border: 1px solid #e2e8f0;
          border-radius: 14px;
          font-size: 13.5px;
          color: #0f172a;
          font-family: inherit;
          text-align: left;
          cursor: pointer;
          transition: border-color 0.15s, box-shadow 0.15s, transform 0.12s, background 0.15s;
          opacity: 0; animation: pop 0.4s ease-out forwards;
        }
        @keyframes pop { to { opacity: 1; transform: none; } from { opacity: 0; transform: translateY(6px); } }
        .sug:hover {
          border-color: #1675F2;
          background: rgba(22,117,242,0.04);
          box-shadow: 0 6px 14px rgba(22,117,242,0.12);
          transform: translateY(-1px);
        }
        .sug-arrow { color: #1675F2; font-weight: 600; flex-shrink: 0; }
      `}</style>
    </div>
  );
}

/* ============================================================
 *  BUBBLE
 * ============================================================ */
function Bubble({ msg }: { msg: Message }) {
  const isUser = msg.role === "user";
  const time = new Date(msg.created_at).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
  return (
    <div className={`row ${isUser ? "right" : "left"}`}>
      {!isUser && <div className="ava"><Mascot size={28} /></div>}
      <div className={`bub ${isUser ? "u" : "a"}`}>
        {msg.pending ? (
          <div className="typing"><span /><span /><span /></div>
        ) : (
          <>
            <div className="content">{msg.content}</div>
            <div className="meta">
              {msg.is_proactive && <span className="tag">proativa</span>}
              {msg.channel === "whatsapp" && <span className="tag">WhatsApp</span>}
              <span>{time}</span>
            </div>
          </>
        )}
      </div>
      <style jsx>{`
        .row {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          animation: bubIn 0.3s ease-out;
        }
        @keyframes bubIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
        .row.right { justify-content: flex-end; }
        .ava {
          flex-shrink: 0;
          width: 28px; height: 28px;
          margin-bottom: 4px;
        }
        .bub {
          max-width: 80%;
          padding: 10px 14px;
          border-radius: 16px;
          font-size: 14px;
          line-height: 1.5;
        }
        .bub.u {
          background: linear-gradient(135deg, #1675F2 0%, #2980F2 100%);
          color: white;
          border-bottom-right-radius: 4px;
          box-shadow: 0 4px 14px rgba(22,117,242,0.22);
        }
        .bub.a {
          background: white;
          color: #0f172a;
          border: 1px solid #e2e8f0;
          border-bottom-left-radius: 4px;
          box-shadow: 0 1px 2px rgba(15,23,42,0.04);
        }
        .content { white-space: pre-wrap; word-break: break-word; }
        .meta {
          margin-top: 4px;
          font-size: 10.5px;
          opacity: 0.8;
          display: flex;
          gap: 6px;
          flex-wrap: wrap;
        }
        .tag {
          padding: 1px 6px;
          background: rgba(0,0,0,0.06);
          border-radius: 4px;
          font-size: 10px;
          font-weight: 500;
        }
        .bub.u .tag { background: rgba(255,255,255,0.18); }
        /* Typing indicator */
        .typing { display: inline-flex; gap: 4px; padding: 4px 0; }
        .typing span {
          width: 6px; height: 6px; border-radius: 50%;
          background: #94a3b8;
          animation: dot 1.2s ease-in-out infinite;
        }
        .typing span:nth-child(2) { animation-delay: 0.18s; }
        .typing span:nth-child(3) { animation-delay: 0.36s; }
        @keyframes dot {
          0%, 70%, 100% { transform: translateY(0); opacity: 0.5; }
          35% { transform: translateY(-3px); opacity: 1; }
        }
      `}</style>
    </div>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}

export default function Page() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Carregando…</div>}>
      <SparkbotPanel />
    </Suspense>
  );
}
