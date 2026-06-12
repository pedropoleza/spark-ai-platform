"use client";

/**
 * TV do estande — attract loop. Plano: _planning/tv-estande-attract-loop.md.
 * 7 telas × 10s, crossfade, palco 1920×1080 auto-escalado (qualquer TV).
 * Controles de teste/estande: ?s=12 muda o ritmo · ?screen=funil fixa uma tela ·
 * espaço pausa · setas avançam. Robustez 8h+: remount limpo por tela (key),
 * wake lock, reload silencioso a cada 4h (higiene de memória).
 */
import { useEffect, useRef, useState } from "react";
import { HeroScreen } from "./screens/Hero";
import { VoiceScreen } from "./screens/Voice";
import { FunnelScreen } from "./screens/Funnel";
import { AgendaScreen } from "./screens/Agenda";
import { ProactiveScreen } from "./screens/Proactive";
import { WhyScreen } from "./screens/Why";
import { CtaScreen } from "./screens/Cta";

const SCREENS: { key: string; Comp: () => React.JSX.Element }[] = [
  { key: "hero", Comp: HeroScreen },
  { key: "voz", Comp: VoiceScreen },
  { key: "funil", Comp: FunnelScreen },
  { key: "agenda", Comp: AgendaScreen },
  { key: "proativo", Comp: ProactiveScreen },
  { key: "porque", Comp: WhyScreen },
  { key: "cta", Comp: CtaScreen },
];

const DEFAULT_SECONDS = 10;
const TRANSITION_MS = 800;
const RELOAD_AFTER_MS = 4 * 60 * 60 * 1000;

function TvApp() {
  // Config via query (lida 1x no mount — componente é client-only)
  const [cfg] = useState(() => {
    const p = new URLSearchParams(location.search);
    const s = parseFloat(p.get("s") || "");
    const fixedKey = p.get("screen");
    const fixed = fixedKey ? SCREENS.findIndex((x) => x.key === fixedKey) : -1;
    return {
      seconds: Number.isFinite(s) && s >= 3 ? s : DEFAULT_SECONDS,
      fixed: fixed >= 0 ? fixed : null,
    };
  });

  const [current, setCurrent] = useState(cfg.fixed ?? 0);
  const [prev, setPrev] = useState<number | null>(null);
  const [paused, setPaused] = useState(false);
  const exitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const goto = (next: number) => {
    const n = ((next % SCREENS.length) + SCREENS.length) % SCREENS.length;
    setPrev(current);
    setCurrent(n);
    if (exitTimer.current) clearTimeout(exitTimer.current);
    exitTimer.current = setTimeout(() => setPrev(null), TRANSITION_MS);
  };

  // Avanço automático
  useEffect(() => {
    if (paused || cfg.fixed !== null) return;
    const t = setTimeout(() => goto(current + 1), cfg.seconds * 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current, paused]);

  // Teclado (teste/estande): espaço pausa, setas avançam
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " ") { e.preventDefault(); setPaused((v) => !v); }
      if (e.key === "ArrowRight") goto(current + 1);
      if (e.key === "ArrowLeft") goto(current - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  // Wake lock — segura a tela acesa onde a API existir (re-pede ao voltar visível)
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const acquire = async () => {
      try {
        const wl = (navigator as Navigator & { wakeLock?: { request: (t: "screen") => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl) lock = await wl.request("screen");
      } catch { /* sem suporte/permissão — TV deve ter screensaver desligado */ }
    };
    acquire();
    const onVis = () => { if (document.visibilityState === "visible") acquire(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      document.removeEventListener("visibilitychange", onVis);
      lock?.release().catch(() => {});
    };
  }, []);

  // Reload de higiene a cada 4h (loop roda o evento inteiro sem acumular memória)
  useEffect(() => {
    const t = setTimeout(() => location.reload(), RELOAD_AFTER_MS);
    return () => clearTimeout(t);
  }, []);

  const Current = SCREENS[current].Comp;
  const Prev = prev !== null ? SCREENS[prev].Comp : null;

  return (
    <>
      {Prev && prev !== null && (
        <div className="tv-layer tv-exit" key={`prev-${prev}`}>
          <Prev />
        </div>
      )}
      <div className="tv-layer tv-enter" key={`cur-${current}`}>
        <Current />
      </div>

      {/* Progresso (dots + barra da tela ativa) */}
      <div style={{ position: "absolute", bottom: 26, left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "center", gap: 14, zIndex: 20 }}>
        {SCREENS.map((s, i) =>
          i === current ? (
            <span key={`${s.key}-${current}`} style={{ width: 88, height: 10, borderRadius: 999, background: "rgba(255,255,255,0.14)", overflow: "hidden" }}>
              <span style={{
                display: "block", height: "100%", borderRadius: 999, background: "var(--tv-gradient)",
                animation: cfg.fixed === null ? `tv-progress ${cfg.seconds}s linear both` : "none",
                animationPlayState: paused ? "paused" : "running",
                width: cfg.fixed !== null ? "100%" : undefined,
              }} />
            </span>
          ) : (
            <span key={s.key} style={{ width: 10, height: 10, borderRadius: 999, background: "rgba(255,255,255,0.18)" }} />
          )
        )}
      </div>

      {paused && (
        <div style={{ position: "absolute", top: 130, left: "50%", transform: "translateX(-50%)", zIndex: 30, padding: "10px 24px", borderRadius: 999, background: "rgba(0,0,0,0.6)", border: "1px solid var(--tv-line)", fontSize: 22, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--tv-ink-2)" }}>
          ⏸ pausado — espaço retoma
        </div>
      )}
    </>
  );
}

// ============ Botão de tela cheia (Pedro 2026-06-12) ============
// Fullscreen exige gesto do usuário — botão some quando já está em tela cheia
// (Esc traz de volta). Atalho: tecla F. Cobre browser de smart TV sem F11.
type FsDocument = Document & {
  webkitFullscreenElement?: Element | null;
  webkitExitFullscreen?: () => void;
};
type FsElement = HTMLElement & { webkitRequestFullscreen?: () => void };

function enterFullscreen() {
  const el = document.documentElement as FsElement;
  try {
    if (el.requestFullscreen) el.requestFullscreen().catch(() => {});
    else el.webkitRequestFullscreen?.();
  } catch { /* sem suporte — segue em janela */ }
}

function FullscreenButton() {
  const [isFs, setIsFs] = useState(false);

  useEffect(() => {
    const doc = document as FsDocument;
    const onChange = () => setIsFs(!!(document.fullscreenElement || doc.webkitFullscreenElement));
    document.addEventListener("fullscreenchange", onChange);
    document.addEventListener("webkitfullscreenchange", onChange);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "f" || e.key === "F") enterFullscreen();
    };
    window.addEventListener("keydown", onKey);
    onChange();
    return () => {
      document.removeEventListener("fullscreenchange", onChange);
      document.removeEventListener("webkitfullscreenchange", onChange);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  if (isFs) return null;
  return (
    <button
      onClick={enterFullscreen}
      style={{
        position: "fixed", right: 28, bottom: 28, zIndex: 100,
        display: "flex", alignItems: "center", gap: 12,
        padding: "16px 28px", borderRadius: 999,
        background: "rgba(10,22,32,0.85)", border: "1px solid rgba(43,212,255,0.45)",
        color: "var(--tv-ink)", fontSize: 22, fontWeight: 700, fontFamily: "inherit",
        cursor: "pointer", boxShadow: "0 14px 40px rgba(0,0,0,0.5)",
        animation: "tv-glow 2.6s ease-in-out infinite",
      }}
    >
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
        <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
      Tela cheia
    </button>
  );
}

// ============ Palco 1920×1080 escalado pro viewport ============
export default function TvPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const fit = () => {
      const el = stageRef.current;
      if (!el) return;
      const scale = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
      el.style.transform = `scale(${scale})`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div className="tv-host">
      <div className="tv-stage" ref={stageRef}>
        {mounted && <TvApp />}
      </div>
      {mounted && <FullscreenButton />}
    </div>
  );
}
