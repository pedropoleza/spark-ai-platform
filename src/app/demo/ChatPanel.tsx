/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { AudioWave, TypingDots } from "./components";
import type { Scene } from "./data";

export interface ChatMsg {
  from: "user" | "bot";
  kind: "audio" | "typing" | "text";
  text?: string;
  transcript?: string | null;
  duration?: string;
}

// ============ WhatsApp-style chat panel (left side of Tela 2) ============
export function ChatPanel({
  messages, scenario, onSendAudio, sendEnabled, sceneIndex,
}: {
  messages: ChatMsg[];
  scenario: Scene;
  onSendAudio: () => void;
  sendEnabled: boolean;
  sceneIndex: number;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  return (
    <div style={{
      width: "100%", height: "100%", borderRadius: 28, overflow: "hidden",
      background: "white", boxShadow: "var(--shadow-xl)",
      display: "flex", flexDirection: "column", border: "1px solid var(--line)", position: "relative",
    }}>
      {/* WhatsApp header */}
      <div style={{
        background: "#075E54", color: "white", padding: "18px 18px 16px",
        display: "flex", alignItems: "center", gap: 14, flexShrink: 0,
      }}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.85 }}>
          <path d="M15 18l-6-6 6-6" stroke="white" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "white", overflow: "hidden", display: "grid", placeItems: "center", flexShrink: 0 }}>
          <img src="/demo/assets/logo-k-blue.png" alt="" style={{ width: 38, height: 38, borderRadius: "50%" }} />
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 700, letterSpacing: "-0.005em" }}>SparkBot</div>
          <div style={{ fontSize: 13, opacity: 0.75, display: "flex", alignItems: "center", gap: 6 }}>
            <span style={{ width: 6, height: 6, borderRadius: 999, background: "#7CFFB0", display: "inline-block" }} />
            online · seu copiloto
          </div>
        </div>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.7 }}>
          <path d="M15.5 8.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0zM12 14c-4 0-7 2-7 5h14c0-3-3-5-7-5z" stroke="white" strokeWidth="1.8" />
        </svg>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.7 }}>
          <circle cx="12" cy="5" r="1.8" fill="white" /><circle cx="12" cy="12" r="1.8" fill="white" /><circle cx="12" cy="19" r="1.8" fill="white" />
        </svg>
      </div>

      {/* Messages area */}
      <div ref={scrollRef} className="wa-pattern" style={{
        flex: 1, overflowY: "auto", padding: "20px 18px 100px",
        display: "flex", flexDirection: "column", gap: 12,
      }}>
        <div style={{ alignSelf: "center", padding: "6px 14px", background: "rgba(225,245,254,0.92)", borderRadius: 10, fontSize: 12, color: "#5C6B78", fontWeight: 600, marginBottom: 4 }}>
          HOJE
        </div>
        {messages.map((m, i) => <ChatMessage key={i} message={m} />)}
      </div>

      <ChatComposer sendEnabled={sendEnabled} scenario={scenario} onSendAudio={onSendAudio} sceneIndex={sceneIndex} />
    </div>
  );
}

function ChatMessage({ message }: { message: ChatMsg }) {
  const { from, kind, text, transcript, duration } = message;
  const outgoing = from === "user";

  if (kind === "typing") {
    return (
      <div style={{
        alignSelf: "flex-start", background: "white", padding: "10px 14px",
        borderRadius: "12px 12px 12px 4px", boxShadow: "0 1px 1px rgba(0,0,0,0.08)",
        animation: "slide-up 0.3s ease-out",
      }}>
        <TypingDots color="#0FB5E1" />
      </div>
    );
  }

  if (kind === "audio") {
    return (
      <div style={{ alignSelf: outgoing ? "flex-end" : "flex-start", maxWidth: "82%", animation: "pop-in 0.4s cubic-bezier(0.22,1,0.36,1)" }}>
        <div style={{
          background: outgoing ? "var(--whatsapp-out)" : "white",
          padding: "10px 12px",
          borderRadius: outgoing ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
          boxShadow: "0 1px 1px rgba(0,0,0,0.08)",
          display: "flex", flexDirection: "column", gap: 8,
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <div style={{ width: 36, height: 36, borderRadius: "50%", background: outgoing ? "#A4D67E" : "var(--brand-tint)", display: "grid", placeItems: "center" }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill={outgoing ? "white" : "var(--brand)"}><path d="M8 5v14l11-7z" /></svg>
            </div>
            <div style={{ flex: 1 }}>
              <AudioWave playing={false} color={outgoing ? "#4A8C3A" : "#0FB5E1"} height={22} bars={28} />
            </div>
            <span style={{ fontSize: 11, color: "var(--ink-3)", fontVariantNumeric: "tabular-nums" }}>{duration}</span>
          </div>
          {transcript && (
            <div style={{
              fontSize: 14, color: outgoing ? "#3A5C2A" : "#243341", fontStyle: "italic", lineHeight: 1.35,
              borderTop: outgoing ? "1px solid rgba(74,140,58,0.15)" : "1px solid var(--line)", paddingTop: 8,
            }}>
              <span style={{ opacity: 0.65, fontStyle: "normal", fontWeight: 700, fontSize: 11, letterSpacing: "0.1em", textTransform: "uppercase", display: "block", marginBottom: 4 }}>
                Transcrição
              </span>
              &ldquo;{transcript}&rdquo;
            </div>
          )}
          <div style={{ alignSelf: "flex-end", display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: "var(--ink-4)" }}>
            agora
            {outgoing && <svg width="14" height="10" viewBox="0 0 16 11" fill="none"><path d="M1 5l3.5 3.5L11 2M5 5l3.5 3.5L15 2" stroke="#34B7F1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
          </div>
        </div>
      </div>
    );
  }

  // Default: text message
  return (
    <div style={{
      alignSelf: outgoing ? "flex-end" : "flex-start", maxWidth: "84%",
      background: outgoing ? "var(--whatsapp-out)" : "white",
      padding: "10px 12px 6px",
      borderRadius: outgoing ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
      boxShadow: "0 1px 1px rgba(0,0,0,0.08)",
      animation: "pop-in 0.4s cubic-bezier(0.22,1,0.36,1)", position: "relative",
    }}>
      <div style={{ fontSize: 15, lineHeight: 1.4, color: "var(--ink)", whiteSpace: "pre-wrap" }}>
        {renderFormatted(text)}
      </div>
      <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, fontSize: 10, color: "var(--ink-4)", marginTop: 4 }}>
        agora
        {outgoing && <svg width="14" height="10" viewBox="0 0 16 11" fill="none"><path d="M1 5l3.5 3.5L11 2M5 5l3.5 3.5L15 2" stroke="#34B7F1" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>}
      </div>
    </div>
  );
}

// minimal "*bold*" + "_italic_" formatter to mimic WhatsApp
function renderFormatted(text?: string): ReactNode {
  if (!text) return null;
  const parts: ReactNode[] = [];
  const lines = text.split("\n");
  lines.forEach((line, li) => {
    const tokens = line.split(/(\*[^*]+\*|_[^_]+_)/g);
    tokens.forEach((tok, ti) => {
      const key = `${li}-${ti}`;
      if (/^\*[^*]+\*$/.test(tok)) parts.push(<b key={key} style={{ fontWeight: 700 }}>{tok.slice(1, -1)}</b>);
      else if (/^_[^_]+_$/.test(tok)) parts.push(<i key={key}>{tok.slice(1, -1)}</i>);
      else parts.push(<span key={key}>{tok}</span>);
    });
    if (li < lines.length - 1) parts.push(<br key={`br-${li}`} />);
  });
  return parts;
}

function ChatComposer({ sendEnabled, scenario, onSendAudio, sceneIndex }: {
  sendEnabled: boolean; scenario: Scene; onSendAudio: () => void; sceneIndex: number;
}) {
  const [holding, setHolding] = useState(false);
  const [holdProgress, setHoldProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    setHolding(false);
    setHoldProgress(0);
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, [sceneIndex]);

  const startHold = () => {
    if (!sendEnabled) return;
    setHolding(true);
    setHoldProgress(0);
    const start = Date.now();
    intervalRef.current = setInterval(() => {
      const p = Math.min(1, (Date.now() - start) / 900);
      setHoldProgress(p);
      if (p >= 1) {
        if (intervalRef.current) clearInterval(intervalRef.current);
        setHolding(false);
        setHoldProgress(0);
        onSendAudio();
      }
    }, 30);
  };
  const cancelHold = () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
    setHolding(false);
    setHoldProgress(0);
  };

  const isProactive = scenario && scenario.crmAction === "proactive";

  return (
    <div style={{
      position: "absolute", left: 0, right: 0, bottom: 0, padding: "12px 14px 14px",
      background: "#F0F0F0", borderTop: "1px solid rgba(0,0,0,0.05)",
      display: "flex", alignItems: "center", gap: 10,
    }}>
      <div style={{
        flex: 1, background: "white", borderRadius: 999, padding: "12px 16px",
        display: "flex", alignItems: "center", gap: 10, color: "var(--ink-4)", fontSize: 15,
      }}>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="1.8" />
          <path d="M8 14s1.5 2 4 2 4-2 4-2M9 10h.01M15 10h.01" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
        </svg>
        <span style={{ flex: 1 }}>Mensagem</span>
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" style={{ opacity: 0.6 }}>
          <path d="M21 16V8a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2zM8 9l3 3-3 3M14 15h3" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </div>

      <button
        onPointerDown={isProactive ? undefined : startHold}
        onPointerUp={cancelHold}
        onPointerLeave={cancelHold}
        onPointerCancel={cancelHold}
        disabled={!sendEnabled || isProactive}
        style={{
          position: "relative", width: 64, height: 64, borderRadius: "50%",
          background: isProactive ? "#C2CDD6" : sendEnabled ? "var(--brand-gradient)" : "#C2CDD6",
          border: 0, cursor: sendEnabled && !isProactive ? "pointer" : "default",
          display: "grid", placeItems: "center",
          boxShadow: sendEnabled && !isProactive ? "0 8px 24px rgba(15,181,225,0.45)" : "none",
          flexShrink: 0,
          transform: holding ? "scale(1.15)" : "scale(1)",
          transition: "transform 0.15s, background 0.2s",
          animation: sendEnabled && !isProactive && !holding ? "glow-ring 1.8s ease-in-out infinite" : "none",
        }}
      >
        <svg width="28" height="28" viewBox="0 0 24 24" fill="white">
          <rect x="9" y="3" width="6" height="13" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" stroke="white" strokeWidth="2" strokeLinecap="round" fill="none" />
        </svg>
        {holding && (
          <svg style={{ position: "absolute", inset: -6, transform: "rotate(-90deg)" }} viewBox="0 0 80 80">
            <circle cx="40" cy="40" r="36" stroke="rgba(255,255,255,0.4)" strokeWidth="4" fill="none" />
            <circle cx="40" cy="40" r="36" stroke="white" strokeWidth="4" fill="none"
              strokeDasharray={226} strokeDashoffset={226 - 226 * holdProgress} strokeLinecap="round" />
          </svg>
        )}
      </button>

      {sendEnabled && !isProactive && (
        <div style={{
          position: "absolute", right: 20, bottom: 92, padding: "8px 14px",
          background: "var(--ink)", color: "white", borderRadius: 14,
          fontSize: 13, fontWeight: 600, whiteSpace: "nowrap",
          animation: "float-y 1.8s ease-in-out infinite", boxShadow: "0 8px 18px rgba(10,22,32,0.25)",
        }}>
          Segure para gravar ↓
          <span style={{ position: "absolute", bottom: -6, right: 24, width: 12, height: 12, background: "var(--ink)", transform: "rotate(45deg)" }} />
        </div>
      )}
      {isProactive && (
        <div style={{ position: "absolute", left: 0, right: 0, bottom: 92, textAlign: "center", fontSize: 13, color: "var(--ink-3)", fontWeight: 600 }}>
          O SparkBot está agindo por conta própria…
        </div>
      )}
    </div>
  );
}
