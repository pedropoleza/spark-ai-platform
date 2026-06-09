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

// Tipo do attachment retornado pelo /upload — espelha RepInput não-text/audio.
type AttachmentKind = "image" | "document" | "tabular";
interface PainelAttachment {
  kind: AttachmentKind;
  // image:
  base64_data_uri?: string;
  filename?: string;
  // document:
  extracted_text?: string;
  // tabular:
  tabular?: {
    filename: string;
    columns: string[];
    total_rows: number;
    rows: Array<Record<string, unknown>>;
    sheets?: Array<{ name: string; total_rows: number; columns: string[] }>;
    active_sheet?: string;
  };
  /** Resumo curto pro chip ("Excel lista.xlsx — 47 linhas, 3 colunas") */
  summary: string;
}

const SUGGESTIONS = [
  "Quem tá na minha agenda hoje?",
  "Resume meus opps abertos",
  "Cliente diabético — qual rate no FlexLife?",
  "Importa esses leads pra mim (anexa CSV)",
];

const ACCEPT_FILES = ".png,.jpg,.jpeg,.webp,.gif,.pdf,.csv,.xlsx,.xls,image/*,application/pdf,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel";

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
  const [attachment, setAttachment] = useState<PainelAttachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Etapa 2.5 do plano de gaps (Pedro 2026-05-28): status do bot pra colorir
  // o dot no header + tooltip. Antes era dot verde sempre — quando agente
  // pausado pela agência ou silence-gate ativava, user mandava msg e bot
  // não respondia. Parecia bug.
  const [botStatus, setBotStatus] = useState<{ online: boolean; status: string; message: string }>({
    online: true, status: "online", message: "Conectado.",
  });
  const scrollRef = useRef<HTMLDivElement>(null);
  const mediaRec = useRef<MediaRecorder | null>(null);
  const recChunks = useRef<Blob[]>([]);
  const recTimer = useRef<NodeJS.Timeout | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragCounterRef = useRef(0);
  // Etapa 3.5: error streak do inbox polling (controla backoff exponencial).
  const inboxErrorStreak = useRef(0);

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
          // Mescla com optimistic local. Fix bug observado em prod 2026-05-05:
          // antes só dedupava por ID, mas tmp-u-X NUNCA casava com server UUID
          // — locais ficavam pra sempre, aparecendo duplicados ao lado das
          // versões persistidas. Agora dedup também por content+role+timing
          // (±30s) — captura o caso de o /send ter respondido mas estado
          // local ainda ter tmp-* pendente.
          setMessages((prev) => {
            const serverIds = new Set<string>(data.messages.map((m: Message) => m.id));
            const locals = prev.filter((m) => {
              if (!m.id.startsWith("tmp-")) return false;
              if (serverIds.has(m.id)) return false;
              // Procura server msg "equivalente" (mesmo role+content em ±30s)
              const localTs = new Date(m.created_at).getTime();
              const eq = (data.messages as Message[]).some(
                (sm) =>
                  sm.role === m.role &&
                  sm.content === m.content &&
                  Math.abs(new Date(sm.created_at).getTime() - localTs) < 30_000,
              );
              return !eq;
            });
            return [...data.messages, ...locals];
          });
          // Mark all read (rep tá olhando o painel)
          fetch(`/api/sparkbot/inbox`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message_ids: [] }),
          }).catch(() => {});
        }
        // Etapa 3.5 (Pedro 2026-05-28): reset error streak após sucesso.
        inboxErrorStreak.current = 0;
      } catch (err) {
        // Etapa 3.5: logging + backoff exponencial após 3 falhas seguidas
        // (antes era silenciosa = quando rede ficava lenta, polling parava
        // sem aviso e rep só via "nada nova" sem entender).
        inboxErrorStreak.current = (inboxErrorStreak.current || 0) + 1;
        if (inboxErrorStreak.current === 3 || inboxErrorStreak.current % 10 === 0) {
          console.warn(
            `[embed-inbox] polling falhou ${inboxErrorStreak.current}x:`,
            err instanceof Error ? err.message.slice(0, 120) : err,
          );
        }
      }
    };
    fetchInbox();
    // Etapa 3.5: pollerEffectiveInterval cresce após erros (6s → 12s → 24s).
    const pickInterval = () =>
      inboxErrorStreak.current >= 5
        ? 24_000
        : inboxErrorStreak.current >= 3
        ? 12_000
        : 6_000;
    let iv = setInterval(fetchInbox, pickInterval());
    // Re-cria interval a cada 30s pra ajustar pace baseado em streak atual.
    const adjustTimer = setInterval(() => {
      clearInterval(iv);
      iv = setInterval(fetchInbox, pickInterval());
    }, 30_000);
    return () => {
      clearInterval(iv);
      clearInterval(adjustTimer);
    };
  }, [token]);

  // Etapa 2.5 (Pedro 2026-05-28): polling do rep-status a cada 60s. Falha
  // silenciosa preserva estado anterior — não pisca quando rede oscila.
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    const fetchStatus = async () => {
      try {
        const res = await fetch("/api/sparkbot/rep-status", { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const j = (await res.json()) as { online?: boolean; status?: string; message?: string };
        if (cancelled) return;
        setBotStatus({
          online: j.online !== false,
          status: j.status || "online",
          message: j.message || "Conectado.",
        });
      } catch { /* silencia */ }
    };
    fetchStatus();
    const iv = setInterval(fetchStatus, 60_000);
    return () => { cancelled = true; clearInterval(iv); };
  }, [token]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    if (!token || sending) return;
    const text = (overrideText ?? input).trim();
    // Pode mandar com attachment sem texto, ou texto sem attachment, mas
    // não vazio total
    if (!text && !attachment) return;
    setInput("");
    setSending(true);
    setError(null);

    // Conteúdo legível pra histórico optimistic
    const optimisticContent = (() => {
      if (!attachment) return text;
      const filename = attachment.filename || attachment.tabular?.filename || "arquivo";
      const icon = attachment.kind === "image" ? "🖼️" : attachment.kind === "tabular" ? "📊" : "📄";
      const meta = attachment.kind === "tabular"
        ? ` (${attachment.tabular!.total_rows} linhas)`
        : "";
      return `${icon} ${filename}${meta}${text ? `\n${text}` : ""}`;
    })();

    const userTmpId = `tmp-u-${Date.now()}`;
    const agentTmpId = `tmp-a-${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      { id: userTmpId, role: "user", content: optimisticContent, channel: "web_ui", created_at: new Date().toISOString() },
      { id: agentTmpId, role: "agent", content: "", channel: "web_ui", created_at: new Date().toISOString(), pending: true },
    ]);

    // Constrói payload — attachment vai como RepInput "puro" (sem campo summary)
    const attachmentPayload = attachment ? buildAttachmentPayload(attachment) : null;
    // Limpa anexo da UI antes mesmo da response (rep pode anexar próximo)
    setAttachment(null);

    // Fix bug observado em prod 2026-05-05: client-side timeout pra não
    // deixar UI travada infinita se /send demorar > Vercel maxDuration.
    // Antes, bot lento → 3 dots eternos → user clica de novo → polling
    // duplica a msg n vezes na UI.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 65_000);

    try {
      const res = await fetch(`/api/sparkbot/send`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, attachment: attachmentPayload }),
        signal: controller.signal,
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.reason || "erro ao enviar");
        setMessages((prev) => prev.filter((m) => m.id !== agentTmpId && m.id !== userTmpId));
        return;
      }
      // Substitui tmp-u-X pelo ID real do server (data.user_message_id) E
      // tmp-a-X pela resposta. Sem isso, polling do inbox NÃO conseguia
      // dedupar (tmp-u-X nunca casava com server UUID), causando o bug
      // visual de mensagens duplicadas observado em prod 2026-05-05.
      setMessages((prev) =>
        prev.map((m) => {
          if (m.id === userTmpId && data.user_message_id) {
            return { ...m, id: data.user_message_id };
          }
          if (m.id === agentTmpId) {
            return { ...m, content: data.text || "(sem resposta)", pending: false };
          }
          return m;
        }),
      );
    } catch (err) {
      const isAbort = err instanceof Error && err.name === "AbortError";
      setError(
        isAbort
          ? "Demorei demais pra responder. Tenta de novo (sua msg foi recebida — pode aparecer quando refresh)."
          : "falha de rede",
      );
      setMessages((prev) => prev.filter((m) => m.id !== agentTmpId));
    } finally {
      clearTimeout(timeoutId);
      setSending(false);
      setTimeout(() => textareaRef.current?.focus(), 50);
    }
  }, [token, input, sending, attachment]);

  // ---------- File upload ----------
  const uploadFile = useCallback(async (file: File) => {
    if (!token || uploading) return;
    if (file.size > 12 * 1024 * 1024) {
      setError("Arquivo maior que 12 MB");
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch(`/api/sparkbot/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        body: fd,
      });
      const data = await res.json();
      if (!data.ok) {
        setError(data.message || data.reason || "Falha no upload");
        return;
      }
      // /upload retorna { kind, attachment (RepInput-like), summary }
      // Adapta pro shape local PainelAttachment
      const a = data.attachment;
      const local: PainelAttachment = a.kind === "image"
        ? { kind: "image", base64_data_uri: a.base64_data_uri, filename: a.filename, summary: data.summary }
        : a.kind === "document"
        ? { kind: "document", filename: a.filename, extracted_text: a.extracted_text, summary: data.summary }
        : { kind: "tabular", tabular: a.tabular, summary: data.summary };
      setAttachment(local);
      setTimeout(() => textareaRef.current?.focus(), 50);
    } catch (err) {
      setError(err instanceof Error ? err.message : "falha no upload");
    } finally {
      setUploading(false);
    }
  }, [token, uploading]);

  const cancelAttachment = useCallback(() => setAttachment(null), []);

  // Click no botão 📎
  const onPickFile = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const onFileInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) uploadFile(f);
    e.target.value = ""; // permite re-pick do mesmo arquivo
  }, [uploadFile]);

  // Drag-and-drop globally on root
  useEffect(() => {
    if (!token) return;
    const onDragEnter = (e: DragEvent) => {
      if (!e.dataTransfer?.types.includes("Files")) return;
      dragCounterRef.current++;
      setDragOver(true);
    };
    const onDragLeave = () => {
      dragCounterRef.current--;
      if (dragCounterRef.current <= 0) setDragOver(false);
    };
    const onDragOver = (e: DragEvent) => { e.preventDefault(); };
    const onDrop = (e: DragEvent) => {
      e.preventDefault();
      dragCounterRef.current = 0;
      setDragOver(false);
      const f = e.dataTransfer?.files?.[0];
      if (f) uploadFile(f);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("drop", onDrop);
    };
  }, [token, uploadFile]);

  // Paste de imagem (ctrl+v) na composer
  useEffect(() => {
    if (!token) return;
    const onPaste = (e: ClipboardEvent) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.kind === "file") {
          const f = item.getAsFile();
          if (f) {
            e.preventDefault();
            uploadFile(f);
            return;
          }
        }
      }
    };
    window.addEventListener("paste", onPaste);
    return () => window.removeEventListener("paste", onPaste);
  }, [token, uploadFile]);

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
        <button
          className="header-gear"
          onClick={() => setShowSettings(true)}
          title="Preferências"
          aria-label="Preferências"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
        <span className="header-status" title={botStatus.message} aria-label={`Status: ${botStatus.status}`}>
          <span className={`dot${botStatus.status === "paused" ? " dot--paused" : botStatus.status === "silenced" ? " dot--silenced" : ""}`} />
        </span>
      </header>

      {showSettings && (
        <SchedulingSettingsModal token={token} onClose={() => setShowSettings(false)} />
      )}

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

      {/* DRAG OVERLAY */}
      {dragOver && (
        <div className="drag-overlay">
          <div className="drag-card">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
            <div className="drag-title">Solta aqui</div>
            <div className="drag-sub">Imagem · PDF · CSV · Excel</div>
          </div>
        </div>
      )}

      {/* HIDDEN FILE INPUT */}
      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPT_FILES}
        onChange={onFileInputChange}
        style={{ display: "none" }}
      />

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
        <div className="composer-wrap">
          {(attachment || uploading) && (
            <div className="attach-chip">
              {uploading ? (
                <>
                  <div className="chip-icon-spinner" />
                  <div className="chip-meta">
                    <div className="chip-title">Processando arquivo…</div>
                  </div>
                </>
              ) : attachment ? (
                <>
                  <AttachmentIcon kind={attachment.kind} attachment={attachment} />
                  <div className="chip-meta">
                    <div className="chip-title">
                      {attachment.filename || attachment.tabular?.filename || "arquivo"}
                    </div>
                    <div className="chip-sub">{attachment.summary}</div>
                  </div>
                  <button className="chip-x" onClick={cancelAttachment} aria-label="Remover anexo">×</button>
                </>
              ) : null}
            </div>
          )}
          <div className="composer">
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={
                transcribing ? "Transcrevendo…"
                : uploading ? "Aguarde o arquivo…"
                : attachment ? "Mensagem (opcional)…"
                : "Manda uma pergunta ou anexa arquivo (📎 / Ctrl+V / arrasta)"
              }
              rows={1}
              disabled={sending || transcribing}
              className="textarea"
            />
            <button
              className="attach-btn"
              onClick={onPickFile}
              disabled={sending || transcribing || uploading}
              title="Anexar arquivo (imagem, PDF, CSV, Excel)"
              aria-label="Anexar arquivo"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
              </svg>
            </button>
            <button
              className="mic-btn"
              onClick={startRecording}
              disabled={sending || transcribing || uploading}
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
              disabled={(!input.trim() && !attachment) || sending || transcribing || uploading}
              title="Enviar"
              aria-label="Enviar"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="22" y1="2" x2="11" y2="13"/>
                <polygon points="22 2 15 22 11 13 2 9 22 2" fill="currentColor"/>
              </svg>
            </button>
          </div>
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
        .header-gear {
          width: 32px; height: 32px; flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
          border: 0; border-radius: 10px; cursor: pointer;
          background: transparent; color: var(--sb-muted);
          transition: background 0.15s, color 0.15s;
        }
        .header-gear:hover { background: rgba(22,117,242,0.08); color: var(--sb-brand); }
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
        /* Pedro 2026-05-28 — variantes de status (paused/silenced) substituem
           a animação verde fixa quando o bot não está totalmente online. */
        .dot--silenced {
          background: #f59e0b;
          box-shadow: 0 0 0 3px rgba(245, 158, 11, 0.18);
        }
        .dot--paused {
          background: #ef4444;
          box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.18);
          animation: none;
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

        .composer-wrap {
          display: flex;
          flex-direction: column;
          background: rgba(255,255,255,0.95);
          backdrop-filter: blur(8px);
          border-top: 1px solid var(--sb-border);
        }
        .composer {
          display: flex;
          align-items: flex-end;
          gap: 8px;
          padding: 12px 14px;
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
        .attach-btn, .mic-btn, .send-btn {
          width: 38px;
          height: 38px;
          flex-shrink: 0;
          border: 0;
          border-radius: 12px;
          cursor: pointer;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          transition: transform 0.12s, box-shadow 0.15s, background 0.15s, color 0.15s, border-color 0.15s;
        }
        .attach-btn, .mic-btn {
          background: var(--sb-bg);
          color: var(--sb-muted);
          border: 1px solid var(--sb-border);
        }
        .attach-btn:hover:not(:disabled), .mic-btn:hover:not(:disabled) {
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
        .send-btn:disabled, .mic-btn:disabled, .attach-btn:disabled { opacity: 0.4; cursor: not-allowed; }

        /* Attachment chip acima da composer */
        .attach-chip {
          display: flex; align-items: center; gap: 12px;
          margin: 8px 14px 0;
          padding: 10px 12px;
          background: linear-gradient(180deg, #ffffff, #f8fafc);
          border: 1px solid var(--sb-border);
          border-radius: 12px;
          box-shadow: 0 1px 2px rgba(15,23,42,0.04);
          animation: chipIn 0.18s ease-out;
        }
        @keyframes chipIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        .chip-thumb {
          width: 40px; height: 40px;
          border-radius: 8px;
          overflow: hidden;
          flex-shrink: 0;
          background: var(--sb-bg);
          border: 1px solid var(--sb-border);
        }
        .chip-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .chip-icon {
          width: 40px; height: 40px;
          border-radius: 8px;
          display: flex; align-items: center; justify-content: center;
          flex-shrink: 0;
        }
        .chip-icon-spinner {
          width: 24px; height: 24px;
          border: 2.5px solid rgba(22,117,242,0.2);
          border-top-color: var(--sb-brand);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
          margin-left: 8px;
        }
        @keyframes spin { to { transform: rotate(360deg); } }
        .chip-meta { flex: 1; min-width: 0; }
        .chip-title {
          font-weight: 600; font-size: 13px; color: var(--sb-text);
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .chip-sub {
          font-size: 11.5px; color: var(--sb-muted); margin-top: 2px;
          white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
        }
        .chip-x {
          width: 26px; height: 26px;
          border: 0; border-radius: 50%;
          background: rgba(15,23,42,0.05); color: var(--sb-muted);
          cursor: pointer; font-size: 18px; line-height: 1;
          display: inline-flex; align-items: center; justify-content: center;
          transition: background 0.15s, color 0.15s;
        }
        .chip-x:hover { background: #fee2e2; color: #dc2626; }

        /* Drag overlay full-screen */
        .drag-overlay {
          position: absolute; top: 0; left: 0; right: 0; bottom: 0;
          background: rgba(22,117,242,0.08);
          backdrop-filter: blur(6px);
          z-index: 100;
          display: flex; align-items: center; justify-content: center;
          pointer-events: none;
          animation: fadeIn 0.15s ease-out;
        }
        @keyframes fadeIn { from { opacity: 0; } to { opacity: 1; } }
        .drag-card {
          background: white;
          border: 2px dashed var(--sb-brand);
          border-radius: 20px;
          padding: 32px 48px;
          color: var(--sb-brand);
          text-align: center;
          box-shadow: 0 16px 40px rgba(22,117,242,0.18);
        }
        .drag-card svg { color: var(--sb-brand); }
        .drag-title { font-weight: 700; font-size: 18px; margin-top: 8px; color: var(--sb-text); }
        .drag-sub { font-size: 12px; color: var(--sb-muted); margin-top: 4px; letter-spacing: 0.04em; }

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

/* ============================================================
 *  SCHEDULING SETTINGS — calendário padrão (Agendamento V2, E4)
 * ============================================================ */
interface SchedCalendar { id: string; name: string }
interface SchedCurrent {
  default_calendar_id?: string;
  default_calendar_name?: string;
  default_duration_min?: number;
}

// Fusos comuns do público (EUA + BR). Se o salvo não estiver aqui, é mostrado
// extra no select (não some). "" = bot detecta automático.
const TZ_OPTIONS = [
  { id: "America/New_York", label: "Leste dos EUA (ET) — Florida, NY" },
  { id: "America/Chicago", label: "Centro dos EUA (CT)" },
  { id: "America/Denver", label: "Montanha dos EUA (MT)" },
  { id: "America/Los_Angeles", label: "Pacífico dos EUA (PT)" },
  { id: "America/Sao_Paulo", label: "Brasília (BRT)" },
  { id: "Europe/Lisbon", label: "Lisboa" },
];

function SchedulingSettingsModal({ token, onClose }: { token: string | null; onClose: () => void }) {
  const [loading, setLoading] = useState(true);
  const [calendars, setCalendars] = useState<SchedCalendar[]>([]);
  const [selectedCal, setSelectedCal] = useState<string>(""); // "" = perguntar toda vez
  const [duration, setDuration] = useState<string>(""); // string pra input vazio
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedOk, setSavedOk] = useState(false);
  // Prefs gerais per-rep (Pedro 2026-06-09): tamanho das respostas + fuso + resumo matinal.
  const [verbosity, setVerbosity] = useState<string>("normal");
  const [timezone, setTimezone] = useState<string>("");
  const [briefing, setBriefing] = useState<boolean>(true);
  // Config de AGÊNCIA (admin-only): personalidade + instruções do SparkBot (afeta todos).
  const [isAdmin, setIsAdmin] = useState(false);
  const [agencyTone, setAgencyTone] = useState({ creativity: 50, formality: 50, naturalness: 50, aggressiveness: 50 });
  const [agencyInstr, setAgencyInstr] = useState("");

  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/sparkbot/scheduling-prefs`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        const data = await res.json();
        if (cancelled) return;
        if (!data.ok) {
          setError("Não consegui carregar as preferências.");
          return;
        }
        setCalendars(Array.isArray(data.calendars) ? data.calendars : []);
        if (data.calendars_error) setError(data.calendars_error);
        const cur: SchedCurrent = data.current || {};
        setSelectedCal(cur.default_calendar_id || "");
        setDuration(cur.default_duration_min ? String(cur.default_duration_min) : "");
        // Prefs gerais (fuso/verbosity/briefing) — endpoint próprio, não-bloqueante.
        const pr = await fetch(`/api/sparkbot/preferences`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json()).catch(() => null);
        if (pr?.ok && !cancelled) {
          setVerbosity(typeof pr.verbosity === "string" ? pr.verbosity : "normal");
          setTimezone(typeof pr.timezone === "string" ? pr.timezone : "");
          setBriefing(pr.daily_briefing_enabled !== false);
        }
        // Config de agência — só admin/owner recebe o conteúdo (server-side gate).
        const ag = await fetch(`/api/sparkbot/agency-config`, {
          headers: { Authorization: `Bearer ${token}` },
        }).then((r) => r.json()).catch(() => null);
        if (ag?.ok && ag.is_admin && !cancelled) {
          setIsAdmin(true);
          if (ag.tone) {
            setAgencyTone({
              creativity: ag.tone.creativity ?? 50,
              formality: ag.tone.formality ?? 50,
              naturalness: ag.tone.naturalness ?? 50,
              aggressiveness: ag.tone.aggressiveness ?? 50,
            });
          }
          setAgencyInstr(typeof ag.custom_instructions === "string" ? ag.custom_instructions : "");
        }
      } catch {
        if (!cancelled) setError("Falha de rede ao carregar.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [token]);

  const handleSave = async () => {
    if (!token) return;
    setSaving(true);
    setError(null);
    setSavedOk(false);
    try {
      // Prefs gerais primeiro (fuso/verbosity/briefing) — não dependem de GHL,
      // então salvam mesmo se a lista de calendários estiver fora do ar.
      const prefRes = await fetch(`/api/sparkbot/preferences`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          verbosity,
          daily_briefing_enabled: briefing,
          ...(timezone ? { timezone } : {}),
        }),
      });
      const prefData = await prefRes.json().catch(() => ({}));
      if (!prefData.ok) {
        setError("Não consegui salvar as preferências. Tente de novo.");
        return;
      }

      // Config de agência (admin-only) — afeta o SparkBot de todos os reps.
      if (isAdmin) {
        const agRes = await fetch(`/api/sparkbot/agency-config`, {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ tone: agencyTone, custom_instructions: agencyInstr }),
        });
        const agData = await agRes.json().catch(() => ({}));
        if (!agData.ok) {
          setError("Salvei suas preferências, mas não consegui salvar a config do SparkBot (agência).");
          return;
        }
      }

      // Etapa 3.6 (Pedro 2026-05-28): se selectedCal === "" (rep limpou
      // calendário padrão), também limpa duration — duration órfã sem
      // calendário não faz sentido e confunde o agendador.
      const isClearingCalendar = selectedCal === "";
      if (isClearingCalendar) {
        setDuration("");
      }
      const durNum = !isClearingCalendar && duration.trim()
        ? parseInt(duration, 10)
        : undefined;
      const res = await fetch(`/api/sparkbot/scheduling-prefs`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          default_calendar_id: selectedCal, // "" limpa a pref
          ...(durNum && !isNaN(durNum) ? { default_duration_min: durNum } : {}),
          // Se está limpando calendário, força default_duration_min=null pro
          // backend remover a pref órfã.
          ...(isClearingCalendar ? { default_duration_min: null } : {}),
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setError(
          data.reason === "calendar_not_found"
            ? "Esse calendário não existe mais. Escolha outro."
            : "Não consegui salvar. Tente de novo.",
        );
        return;
      }
      setSavedOk(true);
      setTimeout(onClose, 700);
    } catch {
      setError("Falha de rede ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="sched-overlay" onClick={onClose}>
      <div className="sched-modal" onClick={(e) => e.stopPropagation()}>
        <div className="sched-head">
          <div>
            <div className="sched-title">Preferências</div>
            <div className="sched-sub">Como o SparkBot trabalha com você</div>
          </div>
          <button className="sched-x" onClick={onClose} aria-label="Fechar">×</button>
        </div>

        <div className="sched-body">
          {loading ? (
            <div className="sched-loading">Carregando…</div>
          ) : (
            <>
              <label className="sched-label">Calendário padrão</label>
              <select
                className="sched-select"
                value={selectedCal}
                onChange={(e) => setSelectedCal(e.target.value)}
                disabled={calendars.length === 0}
              >
                <option value="">— Perguntar toda vez —</option>
                {calendars.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              {calendars.length === 0 && (
                <p className="sched-hint">Nenhum calendário disponível nesta conta.</p>
              )}

              <label className="sched-label" style={{ marginTop: 14 }}>
                Duração padrão (min) <span className="sched-opt">opcional</span>
              </label>
              <input
                className="sched-input"
                type="number"
                min={5}
                max={480}
                step={5}
                placeholder="usa a duração do calendário"
                value={duration}
                onChange={(e) => setDuration(e.target.value)}
              />

              <label className="sched-label" style={{ marginTop: 16 }}>Tamanho das respostas</label>
              <select className="sched-select" value={verbosity} onChange={(e) => setVerbosity(e.target.value)}>
                <option value="brief">Curtas e diretas</option>
                <option value="normal">Equilibradas</option>
                <option value="detailed">Detalhadas</option>
              </select>

              <label className="sched-label" style={{ marginTop: 14 }}>Fuso horário</label>
              <select className="sched-select" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                <option value="">— Detectar automático —</option>
                {timezone && !TZ_OPTIONS.some((t) => t.id === timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
                {TZ_OPTIONS.map((t) => (
                  <option key={t.id} value={t.id}>{t.label}</option>
                ))}
              </select>

              <label
                style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 16, fontSize: 13, cursor: "pointer" }}
              >
                <input type="checkbox" checked={briefing} onChange={(e) => setBriefing(e.target.checked)} />
                <span>Resumo matinal (8h: agenda do dia + resumo de ontem)</span>
              </label>

              {isAdmin && (
                <>
                  <div style={{ marginTop: 18, paddingTop: 14, borderTop: "1px solid rgba(15,23,42,0.1)" }}>
                    <div style={{ fontSize: 13, fontWeight: 700, color: "#155EEF" }}>Config do SparkBot · Agência</div>
                    <div style={{ fontSize: 11, color: "#64748b", marginTop: 2 }}>
                      Afeta o SparkBot de TODOS os reps. Só você (admin) vê isto.
                    </div>
                  </div>

                  {([
                    ["creativity", "Criatividade"],
                    ["formality", "Formalidade"],
                    ["naturalness", "Naturalidade"],
                    ["aggressiveness", "Assertividade"],
                  ] as const).map(([key, label]) => (
                    <div key={key} style={{ marginTop: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span>{label}</span>
                        <span style={{ color: "#64748b" }}>{agencyTone[key]}</span>
                      </div>
                      <input
                        type="range"
                        min={0}
                        max={100}
                        step={5}
                        value={agencyTone[key]}
                        onChange={(e) => setAgencyTone((t) => ({ ...t, [key]: Number(e.target.value) }))}
                        style={{ width: "100%" }}
                      />
                    </div>
                  ))}

                  <label className="sched-label" style={{ marginTop: 14 }}>Instruções do SparkBot</label>
                  <textarea
                    className="sched-input"
                    rows={4}
                    placeholder="Como o SparkBot deve se comportar com a equipe (tom, regras, atalhos da operação)…"
                    value={agencyInstr}
                    onChange={(e) => setAgencyInstr(e.target.value)}
                    style={{ resize: "vertical", minHeight: 70 }}
                  />
                </>
              )}

              <p className="sched-note">
                Você também pode dizer isso no chat: o bot pergunta na primeira vez que você marca.
              </p>

              {error && <div className="sched-error">{error}</div>}
              {savedOk && <div className="sched-okmsg">Salvo ✅</div>}
            </>
          )}
        </div>

        <div className="sched-foot">
          <button className="sched-btn-ghost" onClick={onClose} disabled={saving}>Cancelar</button>
          <button className="sched-btn" onClick={handleSave} disabled={saving || loading}>
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </div>
      </div>

      <style jsx>{`
        .sched-overlay {
          position: fixed; inset: 0; z-index: 200;
          display: flex; align-items: center; justify-content: center;
          background: rgba(15,23,42,0.45); backdrop-filter: blur(4px);
          animation: schedFade 0.15s ease-out;
          padding: 16px;
        }
        @keyframes schedFade { from { opacity: 0; } to { opacity: 1; } }
        .sched-modal {
          width: 100%; max-width: 380px;
          max-height: 88vh; display: flex; flex-direction: column;
          background: #fff; border-radius: 18px;
          box-shadow: 0 20px 50px rgba(15,23,42,0.25);
          overflow: hidden;
          animation: schedPop 0.18s ease-out;
          font-family: var(--sb-font);
        }
        @keyframes schedPop { from { opacity: 0; transform: translateY(8px) scale(0.98); } to { opacity: 1; transform: none; } }
        .sched-head {
          display: flex; align-items: flex-start; justify-content: space-between;
          padding: 16px 18px; border-bottom: 1px solid var(--sb-border);
        }
        .sched-title { font-weight: 700; font-size: 15px; color: var(--sb-text); }
        .sched-sub { font-size: 11.5px; color: var(--sb-muted); margin-top: 2px; }
        .sched-x {
          width: 28px; height: 28px; border: 0; border-radius: 50%;
          background: rgba(15,23,42,0.05); color: var(--sb-muted);
          font-size: 19px; line-height: 1; cursor: pointer; flex-shrink: 0;
          display: inline-flex; align-items: center; justify-content: center;
        }
        .sched-x:hover { background: #fee2e2; color: #dc2626; }
        .sched-body { padding: 16px 18px; overflow-y: auto; flex: 1 1 auto; }
        .sched-loading { color: var(--sb-muted); font-size: 13px; padding: 12px 0; text-align: center; }
        .sched-label {
          display: block; font-size: 12px; font-weight: 600; color: var(--sb-text); margin-bottom: 6px;
        }
        .sched-opt { font-weight: 400; color: var(--sb-muted); font-size: 11px; }
        .sched-select, .sched-input {
          width: 100%; padding: 10px 12px; font-size: 14px;
          font-family: var(--sb-font); color: var(--sb-text);
          background: var(--sb-bg); border: 1px solid var(--sb-border);
          border-radius: 12px; outline: none;
          transition: border-color 0.15s, box-shadow 0.15s;
        }
        .sched-select:focus, .sched-input:focus {
          border-color: var(--sb-brand); box-shadow: 0 0 0 4px var(--sb-brand-glow); background: #fff;
        }
        .sched-hint { font-size: 11.5px; color: #b45309; margin: 6px 0 0; }
        .sched-note { font-size: 11.5px; color: var(--sb-muted); margin: 14px 0 0; line-height: 1.5; }
        .sched-error {
          margin-top: 12px; padding: 8px 12px; border-radius: 10px;
          background: #fef2f2; color: #b91c1c; font-size: 12.5px; border: 1px solid #fecaca;
        }
        .sched-okmsg {
          margin-top: 12px; padding: 8px 12px; border-radius: 10px;
          background: #ecfdf5; color: #047857; font-size: 12.5px; border: 1px solid #a7f3d0;
        }
        .sched-foot {
          display: flex; justify-content: flex-end; gap: 8px;
          padding: 14px 18px; border-top: 1px solid var(--sb-border);
        }
        .sched-btn, .sched-btn-ghost {
          padding: 9px 16px; border-radius: 11px; font-size: 13px; font-weight: 600;
          cursor: pointer; font-family: var(--sb-font); border: 0;
          transition: background 0.15s, transform 0.12s, box-shadow 0.15s;
        }
        .sched-btn-ghost { background: var(--sb-bg); color: var(--sb-muted); border: 1px solid var(--sb-border); }
        .sched-btn-ghost:hover:not(:disabled) { background: #f1f5f9; }
        .sched-btn {
          background: linear-gradient(135deg, var(--sb-brand) 0%, var(--sb-brand-2) 100%);
          color: #fff; box-shadow: 0 4px 12px var(--sb-brand-glow);
        }
        .sched-btn:hover:not(:disabled) { transform: translateY(-1px); }
        .sched-btn:disabled, .sched-btn-ghost:disabled { opacity: 0.5; cursor: not-allowed; }
      `}</style>
    </div>
  );
}

/** Constrói payload pra mandar pro /send (RepInput-like, sem `summary`) */
function buildAttachmentPayload(a: PainelAttachment): Record<string, unknown> {
  if (a.kind === "image") {
    return {
      kind: "image",
      base64_data_uri: a.base64_data_uri,
      filename: a.filename,
    };
  }
  if (a.kind === "document") {
    return {
      kind: "document",
      extracted_text: a.extracted_text,
      filename: a.filename,
    };
  }
  // tabular
  return {
    kind: "tabular",
    tabular: a.tabular,
  };
}

function AttachmentIcon({ kind, attachment }: { kind: AttachmentKind; attachment: PainelAttachment }) {
  if (kind === "image" && attachment.base64_data_uri) {
    return (
      <div className="chip-thumb">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={attachment.base64_data_uri} alt="" />
      </div>
    );
  }
  // PDF / Tabular: ícone SVG colorido
  const color = kind === "tabular" ? "#16a34a" : "#dc2626"; // verde Excel, vermelho PDF
  const icon = kind === "tabular" ? (
    <>
      <path d="M3 3h18v18H3z" fill="none" stroke={color} strokeWidth="1.6"/>
      <path d="M3 9h18M3 15h18M9 3v18M15 3v18" stroke={color} strokeWidth="1.2"/>
    </>
  ) : (
    <>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" fill="none" stroke={color} strokeWidth="1.6"/>
      <path d="M14 2v6h6" stroke={color} strokeWidth="1.6"/>
      <text x="12" y="17" textAnchor="middle" fontSize="6" fill={color} fontWeight="700">PDF</text>
    </>
  );
  return (
    <div className="chip-icon" style={{ background: kind === "tabular" ? "#dcfce7" : "#fee2e2" }}>
      <svg width="22" height="22" viewBox="0 0 24 24">{icon}</svg>
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
