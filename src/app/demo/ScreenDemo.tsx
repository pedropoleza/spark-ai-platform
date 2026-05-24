/* eslint-disable @next/next/no-img-element */
"use client";

import { useEffect, useRef, useState } from "react";
import { ChatPanel, type ChatMsg } from "./ChatPanel";
import { CrmPanel, type CrmPhase } from "./CrmPanel";
import { BrandChip, ProgressDots, type MascotPose } from "./components";
import { SCENES, type Scene } from "./data";

type Route = "attract" | "demo" | "cadastro" | "sucesso";
type Phase = "ready" | "userSent" | "typing" | "responded" | "complete" | "auto";

export function ScreenDemo({ onCTA }: { onCTA: (r: Route) => void }) {
  const [sceneIndex, setSceneIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>("ready");
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const scenario = SCENES[sceneIndex];

  const clearTimers = () => {
    timersRef.current.forEach((t) => clearTimeout(t));
    timersRef.current = [];
  };
  useEffect(() => clearTimers, []);

  // Reset for each scene
  useEffect(() => {
    clearTimers();
    setMessages([]);
    if (scenario.crmAction === "proactive") {
      setPhase("auto");
      timersRef.current.push(setTimeout(() => runProactive(scenario), 1200));
    } else {
      setPhase("ready");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sceneIndex]);

  // Arrow keys to navigate scenes
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") setSceneIndex((i) => Math.min(SCENES.length - 1, i + 1));
      if (e.key === "ArrowLeft") setSceneIndex((i) => Math.max(0, i - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // -------- User-triggered audio flow (scenes 1, 2, 3) ----------
  const handleSendAudio = () => {
    if (phase !== "ready") return;
    clearTimers();
    setMessages([{ from: "user", kind: "audio", transcript: scenario.audioTranscript, duration: scenario.audioDuration }]);
    setPhase("userSent");

    timersRef.current.push(setTimeout(() => {
      setMessages((m) => [...m, { from: "bot", kind: "typing" }]);
      setPhase("typing");
    }, 900));

    timersRef.current.push(setTimeout(() => {
      setMessages((m) => {
        const filtered = m.filter((mm) => mm.kind !== "typing");
        return [...filtered, { from: "bot", kind: "text", text: scenario.botSteps[1].text }];
      });
      setPhase("responded");
    }, 2300));

    timersRef.current.push(setTimeout(() => setPhase("complete"), 4200));
  };

  // -------- Proactive auto flow (scene 4) ----------
  const runProactive = (sc: Scene) => {
    setMessages([{ from: "bot", kind: "typing" }]);
    timersRef.current.push(setTimeout(() => {
      setMessages([{ from: "bot", kind: "text", text: sc.botSteps[0].text }]);
      setPhase("responded");
    }, 1100));
    timersRef.current.push(setTimeout(() => setPhase("complete"), 3300));
  };

  let crmPhase: CrmPhase = "idle";
  if (phase === "responded") crmPhase = "reacting";
  if (phase === "complete") crmPhase = "done";

  const goNext = () => {
    if (sceneIndex < SCENES.length - 1) setSceneIndex(sceneIndex + 1);
    else onCTA("cadastro");
  };
  const goBack = () => {
    if (sceneIndex > 0) setSceneIndex(sceneIndex - 1);
    else onCTA("attract");
  };

  return (
    <div className="absolute-fill" style={{ background: "linear-gradient(180deg, #F3F7FA 0%, #E9F2F7 100%)" }}>
      {/* Top bar */}
      <div style={{ position: "absolute", top: 24, left: 32, right: 32, display: "flex", alignItems: "center", gap: 20, zIndex: 10 }}>
        <button onClick={goBack} style={{ display: "flex", alignItems: "center", gap: 8, background: "white", border: "1px solid var(--line)", borderRadius: 999, padding: "10px 18px", fontWeight: 700, fontSize: 14, color: "var(--ink-2)", cursor: "pointer", fontFamily: "inherit", boxShadow: "var(--shadow-sm)" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {sceneIndex === 0 ? "Voltar" : "Cena anterior"}
        </button>
        <BrandChip />
        <div style={{ flex: 1 }} />
        <div style={{ background: "white", border: "1px solid var(--line)", borderRadius: 999, padding: "10px 18px", display: "flex", alignItems: "center", gap: 14, boxShadow: "var(--shadow-sm)" }}>
          <span style={{ fontSize: 12, fontWeight: 800, color: "var(--brand-darker)", letterSpacing: "0.08em", textTransform: "uppercase" }}>Superpoder {sceneIndex + 1}/{SCENES.length}</span>
          <span style={{ width: 1, height: 18, background: "var(--line)" }} />
          <ProgressDots total={SCENES.length} current={sceneIndex} />
        </div>
      </div>

      {/* Scene title + sub */}
      <div style={{ position: "absolute", top: 96, left: 32, right: 32, display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 28, alignItems: "center", zIndex: 5 }}>
        <div style={{ padding: "12px 18px 12px 14px", background: "var(--ink)", color: "white", borderRadius: 16, display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ width: 36, height: 36, borderRadius: 10, background: "var(--brand-gradient)", display: "grid", placeItems: "center", fontWeight: 800, fontSize: 16 }}>0{sceneIndex + 1}</span>
          <span style={{ fontSize: 16, fontWeight: 800, letterSpacing: "-0.01em" }}>{scenario.superpower}</span>
        </div>
        <div style={{ minWidth: 0 }}>
          <h2 className="display-sm" style={{ margin: 0, color: "var(--ink)" }}>{scenario.title}</h2>
          <div className="body-lg" style={{ marginTop: 4, color: "var(--ink-3)" }}>{scenario.sub}</div>
        </div>
        <div style={{ width: 130, height: 130, position: "relative", flexShrink: 0 }}>
          <SceneMascot phase={phase} sceneIndex={sceneIndex} />
        </div>
      </div>

      {/* Main stage: Chat (left) + CRM (right) */}
      <div style={{ position: "absolute", top: 232, left: 32, right: 32, bottom: 120, display: "grid", gridTemplateColumns: "440px 1fr", gap: 28 }}>
        <div style={{ position: "relative", height: "100%" }}>
          <ChatPanel messages={messages} scenario={scenario} onSendAudio={handleSendAudio} sendEnabled={phase === "ready"} sceneIndex={sceneIndex} />
        </div>
        <div style={{ position: "relative", height: "100%" }}>
          <CrmPanel scenario={scenario} eventPhase={crmPhase} sceneIndex={sceneIndex} />
          {(crmPhase === "reacting" || crmPhase === "done") && (
            <div style={{ position: "absolute", bottom: 20, right: 20, padding: "10px 16px", background: "var(--ink)", color: "white", borderRadius: 999, fontSize: 13, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 8, zIndex: 5, boxShadow: "var(--shadow-lg)", animation: "slide-up 0.4s ease-out" }}>
              <span style={{ width: 8, height: 8, borderRadius: 999, background: "#7CFFB0", animation: "pulse 1.4s ease-in-out infinite" }} />
              CRM atualizando
            </div>
          )}
        </div>
      </div>

      {/* Bottom CTA bar */}
      <div style={{ position: "absolute", left: 32, right: 32, bottom: 28, display: "flex", alignItems: "center", gap: 16 }}>
        <div style={{ flex: 1, minWidth: 0, padding: "16px 22px", background: "white", border: "1px solid var(--line)", borderRadius: 18, display: "flex", alignItems: "center", gap: 14, boxShadow: "var(--shadow-sm)" }}>
          <div style={{ width: 36, height: 36, borderRadius: 10, background: phase === "complete" ? "var(--success-tint)" : "var(--brand-tint)", display: "grid", placeItems: "center", color: phase === "complete" ? "var(--success)" : "var(--brand-darker)", flexShrink: 0 }}>
            {phase === "complete" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
            ) : phase === "ready" ? (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><rect x="10" y="3" width="4" height="12" rx="2" /><path d="M6 11a6 6 0 0 0 12 0" stroke="currentColor" strokeWidth="2" fill="none" strokeLinecap="round" /></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" /><path d="M12 8v5l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>
              {phase === "complete" ? "Mágica feita" : phase === "ready" ? "Sua vez" : "Acontecendo agora"}
            </div>
            <div style={{ fontSize: 17, fontWeight: 700, color: "var(--ink)", marginTop: 2 }}>
              <HelperLabel phase={phase} scenario={scenario} />
            </div>
          </div>
        </div>

        <button onClick={goNext} disabled={phase !== "complete"} style={{
          padding: "20px 36px",
          background: phase === "complete" ? "var(--brand-gradient)" : "var(--line)",
          color: phase === "complete" ? "white" : "var(--ink-4)",
          border: 0, borderRadius: 18, fontSize: 20, fontWeight: 800, letterSpacing: "-0.005em",
          cursor: phase === "complete" ? "pointer" : "not-allowed", fontFamily: "inherit",
          display: "flex", alignItems: "center", gap: 12,
          boxShadow: phase === "complete" ? "var(--shadow-brand)" : "none",
          animation: phase === "complete" ? "glow-ring 2.2s ease-in-out infinite" : "none",
          transition: "all 0.3s", whiteSpace: "nowrap",
        }}>
          {sceneIndex < SCENES.length - 1 ? "Próximo superpoder" : "Quero esse copiloto"}
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </button>
      </div>
    </div>
  );
}

function HelperLabel({ phase, scenario }: { phase: Phase; scenario: Scene }) {
  if (scenario.crmAction === "proactive") {
    if (phase === "auto") return <>O SparkBot está checando seus leads…</>;
    if (phase === "typing" || phase === "responded") return <>Veja só — ele mandou follow-up sem você pedir.</>;
    if (phase === "complete") return <>Pronto. Olha o CRM atualizado e o follow-up enviado.</>;
    return <>Aguardando…</>;
  }
  if (phase === "ready") return <>Segure o botão azul pra mandar o áudio.</>;
  if (phase === "userSent" || phase === "typing") return <>SparkBot ouvindo e organizando…</>;
  if (phase === "responded") return <>Olha o CRM se atualizando à direita →</>;
  if (phase === "complete") return <>Pronto. Reunião lançada, lead atualizado, follow-up agendado.</>;
  return <></>;
}

function SceneMascot({ phase, sceneIndex }: { phase: Phase; sceneIndex: number }) {
  let pose: MascotPose = "presenting";
  if (sceneIndex === 0) pose = "wave";
  if (sceneIndex === 1) pose = "presenting";
  if (sceneIndex === 2) pose = "thinking";
  if (sceneIndex === 3) pose = "celebrating";
  if (phase === "complete") pose = "thumbsup";
  if (phase === "typing" || phase === "userSent") pose = "thinking";

  const bubbleText =
    phase === "ready" ? "Manda áudio aí 🎙️" :
    (phase === "userSent" || phase === "typing") ? "Tô resolvendo…" :
    phase === "responded" ? "Olha o CRM! ✨" :
    phase === "complete" ? "Feito! 🎉" :
    phase === "auto" ? "Cuidando dos leads…" : "";

  return (
    <div style={{ width: "100%", height: "100%", position: "relative", animation: "breath 4s ease-in-out infinite" }}>
      {bubbleText && (
        <div key={bubbleText} style={{ position: "absolute", right: 115, top: 14, background: "white", padding: "10px 16px", borderRadius: 16, boxShadow: "var(--shadow-md)", border: "1px solid var(--line)", fontSize: 14, fontWeight: 700, color: "var(--ink-2)", whiteSpace: "nowrap", animation: "pop-in 0.4s ease-out", zIndex: 2 }}>
          {bubbleText}
          <span style={{ position: "absolute", right: -6, top: 16, width: 12, height: 12, background: "white", transform: "rotate(45deg)", borderRight: "1px solid var(--line)", borderTop: "1px solid var(--line)" }} />
        </div>
      )}
      <img src={`/demo/assets/mascot-${pose}.png`} alt="" style={{ width: "100%", height: "100%", objectFit: "contain", filter: "drop-shadow(0 12px 20px rgba(7,146,186,0.28))" }} />
    </div>
  );
}
