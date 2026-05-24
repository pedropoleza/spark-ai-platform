/* eslint-disable @next/next/no-img-element */
"use client";

import { useMemo, type CSSProperties, type ReactNode } from "react";

// ============ Mascot — sized via prop, with optional ring/breath ============
export type MascotPose = "wave" | "thinking" | "presenting" | "celebrating" | "thumbsup";

export function Mascot({
  pose = "presenting",
  size = 360,
  breath = false,
  ring = false,
  style = {},
  className = "",
}: {
  pose?: MascotPose;
  size?: number;
  breath?: boolean;
  ring?: boolean;
  style?: CSSProperties;
  className?: string;
}) {
  const src = `/demo/assets/mascot-${pose}.png`;
  return (
    <div
      className={"mascot " + className}
      style={{ position: "relative", width: size, height: size, display: "inline-block", ...style }}
    >
      {ring && (
        <>
          <div style={ringStyle(size, 0)} />
          <div style={ringStyle(size, 0.6)} />
          <div style={ringStyle(size, 1.2)} />
        </>
      )}
      <img
        src={src}
        alt="SparkBot"
        style={{
          width: "100%", height: "100%",
          objectFit: "contain",
          position: "relative", zIndex: 2,
          filter: "drop-shadow(0 28px 40px rgba(7,146,186,0.25)) drop-shadow(0 12px 16px rgba(10,22,32,0.10))",
          animation: breath ? "breath 4.5s ease-in-out infinite" : "none",
          transformOrigin: "center bottom",
        }}
      />
    </div>
  );
}
function ringStyle(size: number, delay: number): CSSProperties {
  return {
    position: "absolute",
    left: "50%", top: "50%",
    width: size * 0.75, height: size * 0.75,
    marginLeft: -(size * 0.75) / 2, marginTop: -(size * 0.75) / 2,
    border: "3px solid rgba(15,181,225,0.45)",
    borderRadius: "50%",
    animation: `ring-pulse 2.4s ease-out ${delay}s infinite`,
    zIndex: 1,
  };
}

// ============ Brand chip top-left ============
export function BrandChip({ light = false }: { light?: boolean }) {
  return (
    <div className="brand-chip" style={light ? { background: "rgba(255,255,255,0.12)", borderColor: "rgba(255,255,255,0.2)", color: "white" } : {}}>
      <img src={light ? "/demo/assets/logo-k-light.png" : "/demo/assets/logo-k-blue.png"} alt="" />
      <span style={{ fontSize: 18, letterSpacing: "-0.01em" }}>
        Spark<span style={{ color: light ? "var(--brand)" : "var(--brand-darker)" }}>Bot</span>
      </span>
      <span style={{
        marginLeft: 6, padding: "4px 10px", borderRadius: 999,
        background: light ? "rgba(255,255,255,0.08)" : "var(--brand-tint)",
        color: light ? "white" : "var(--brand-darker)",
        fontSize: 12, fontWeight: 700, letterSpacing: "0.08em", textTransform: "uppercase",
        whiteSpace: "nowrap",
      }}>by Spark Leads</span>
    </div>
  );
}

// ============ Audio waveform (static placeholder, N bars) ============
export function AudioWave({ playing = false, color = "#0FB5E1", height = 28, bars = 28 }: {
  playing?: boolean; color?: string; height?: number; bars?: number;
}) {
  const heights = useMemo(() => {
    return Array.from({ length: bars }, (_, i) => {
      const t = i / bars;
      const env = Math.sin(t * Math.PI) * 0.7 + 0.3;
      const noise = (Math.sin(i * 12.9898) * 43758.5453) % 1;
      return Math.max(0.18, env * (0.5 + Math.abs(noise) * 0.5));
    });
  }, [bars]);
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 3, height }}>
      {heights.map((h, i) => (
        <div key={i} style={{
          width: 3, height: `${h * 100}%`, background: color, borderRadius: 2,
          transformOrigin: "center",
          animation: playing ? `wave-bar 0.9s ease-in-out ${i * 0.04}s infinite` : "none",
        }} />
      ))}
    </div>
  );
}

// ============ Typing indicator (3 dots) ============
export function TypingDots({ color = "#0FB5E1" }: { color?: string }) {
  return (
    <div style={{ display: "flex", gap: 5, padding: "10px 4px" }}>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{
          width: 9, height: 9, borderRadius: 999, background: color,
          animation: `typing-dot 1.2s ease-in-out ${i * 0.15}s infinite`,
        }} />
      ))}
    </div>
  );
}

// ============ Tap-to-continue affordance ============
export function TapHint({ label = "Toque para continuar", style = {} }: { label?: string; style?: CSSProperties }) {
  return (
    <div style={{
      display: "inline-flex", alignItems: "center", gap: 12,
      padding: "12px 22px", background: "rgba(10,22,32,0.06)", borderRadius: 999,
      color: "var(--ink-3)", fontWeight: 600, fontSize: 16,
      animation: "float-y 2.2s ease-in-out infinite", ...style,
    }}>
      <span style={{
        width: 26, height: 26, borderRadius: 999, background: "var(--brand)",
        display: "grid", placeItems: "center",
        boxShadow: "0 0 0 6px rgba(15,181,225,0.22)",
        animation: "glow-ring 2s ease-in-out infinite",
      }}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none">
          <path d="M9 6l6 6-6 6" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </span>
      {label}
    </div>
  );
}

// ============ Confetti burst (CSS dots) ============
export function ConfettiBurst({ x = "50%", y = "50%", count = 32 }: { x?: string; y?: string; count?: number }) {
  const colors = ["#0FB5E1", "#14C5F0", "#FFD23F", "#1DB954", "#FF8A3D"];
  const pieces = useMemo(() => Array.from({ length: count }, (_, i) => ({
    color: colors[i % colors.length],
    angle: (i / count) * Math.PI * 2 + Math.random() * 0.4,
    distance: 80 + Math.random() * 200,
    delay: Math.random() * 0.1,
    size: 6 + Math.random() * 6,
    rot: Math.random() * 720,
  })), [count]);
  return (
    <div style={{ position: "absolute", left: x, top: y, pointerEvents: "none", zIndex: 50 }}>
      {pieces.map((p, i) => (
        <div key={i} style={{
          position: "absolute",
          width: p.size, height: p.size * 0.5,
          background: p.color, borderRadius: 2,
          left: 0, top: 0,
          transform: "translate(-50%,-50%)",
          animation: `confetti-pop 1.2s ease-out ${p.delay}s forwards`,
          "--tx": `${Math.cos(p.angle) * p.distance}px`,
          "--ty": `${Math.sin(p.angle) * p.distance}px`,
          "--rot": `${p.rot}deg`,
        } as CSSProperties} />
      ))}
    </div>
  );
}

// ============ Background ornaments ============
export function BgOrbs() {
  return (
    <>
      <div style={{
        position: "absolute", top: -120, right: -120,
        width: 540, height: 540, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(15,181,225,0.22), transparent 70%)",
        filter: "blur(20px)", pointerEvents: "none",
      }} />
      <div style={{
        position: "absolute", bottom: -160, left: -160,
        width: 600, height: 600, borderRadius: "50%",
        background: "radial-gradient(circle, rgba(255,210,63,0.18), transparent 70%)",
        filter: "blur(24px)", pointerEvents: "none",
      }} />
    </>
  );
}

// ============ Progress dots ============
export function ProgressDots({ total, current }: { total: number; current: number }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
      {Array.from({ length: total }, (_, i) => (
        <div key={i} style={{
          width: i === current ? 32 : 10, height: 10, borderRadius: 999,
          background: i <= current ? "var(--brand)" : "var(--line)",
          transition: "all 0.4s cubic-bezier(0.22,1,0.36,1)",
        }} />
      ))}
    </div>
  );
}

export type { ReactNode };
