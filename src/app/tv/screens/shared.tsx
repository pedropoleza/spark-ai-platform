/* eslint-disable @next/next/no-img-element */
"use client";

// Peças compartilhadas das telas da TV (dark premium).
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

/** Contador animado (easing cúbico), começa após `delay` ms. */
export function CountUp({ to, delay = 0, duration = 2200, prefix = "", suffix = "" }: {
  to: number; delay?: number; duration?: number; prefix?: string; suffix?: string;
}) {
  const [v, setV] = useState(0);
  useEffect(() => {
    let raf = 0;
    let start: number | null = null;
    const t = setTimeout(() => {
      const step = (ts: number) => {
        if (start === null) start = ts;
        const p = Math.min(1, (ts - start) / duration);
        setV(Math.round(to * (1 - Math.pow(1 - p, 3))));
        if (p < 1) raf = requestAnimationFrame(step);
      };
      raf = requestAnimationFrame(step);
    }, delay);
    return () => { clearTimeout(t); cancelAnimationFrame(raf); };
  }, [to, delay, duration]);
  return <>{prefix}{v.toLocaleString("pt-BR")}{suffix}</>;
}

/** Chip de marca (canto superior esquerdo de toda tela). */
export function TvBrand() {
  return (
    <div style={{ position: "absolute", top: 48, left: 56, display: "flex", alignItems: "center", gap: 18, zIndex: 10 }}>
      <span style={{ width: 64, height: 64, borderRadius: 18, background: "var(--tv-gradient)", display: "grid", placeItems: "center", boxShadow: "0 12px 32px rgba(15,181,225,0.4)" }}>
        <img src="/demo/assets/logo-k-light.png" alt="" style={{ width: 56, height: 56, borderRadius: 16 }} />
      </span>
      <span style={{ fontSize: 34, fontWeight: 800, letterSpacing: "-0.01em" }}>
        Spark<span className="tv-gradient-text">Leads</span>
      </span>
      <span style={{ padding: "10px 20px", borderRadius: 999, background: "var(--tv-panel)", border: "1px solid var(--tv-line)", fontSize: 20, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--tv-ink-3)" }}>
        + SparkBot
      </span>
    </div>
  );
}

/** Badge canto superior direito. */
export function TvCorner({ children }: { children: ReactNode }) {
  return (
    <div style={{ position: "absolute", top: 56, right: 64, zIndex: 10, display: "flex", alignItems: "center", gap: 12, padding: "12px 24px", borderRadius: 999, background: "var(--tv-panel)", border: "1px solid var(--tv-line)", fontSize: 22, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--tv-ink-2)" }}>
      <span style={{ width: 12, height: 12, borderRadius: 999, background: "var(--tv-success)", animation: "tv-pulse 1.8s ease-in-out infinite" }} />
      {children}
    </div>
  );
}

/** Mascote com glow pra fundo escuro. */
export function TvMascot({ pose, size, style }: { pose: string; size: number; style?: CSSProperties }) {
  return (
    <img
      src={`/demo/assets/mascot-${pose}.png`}
      alt=""
      style={{
        width: size, height: size, objectFit: "contain",
        filter: "drop-shadow(0 0 60px rgba(43,212,255,0.35)) drop-shadow(0 24px 40px rgba(0,0,0,0.5))",
        animation: "tv-breath 4.5s ease-in-out infinite",
        ...style,
      }}
    />
  );
}

/** Anéis pulsantes atrás de um elemento central. */
export function TvRings({ size }: { size: number }) {
  return (
    <>
      {[0, 0.7, 1.4].map((d) => (
        <span key={d} style={{
          position: "absolute", left: "50%", top: "50%",
          width: size, height: size, marginLeft: -size / 2, marginTop: -size / 2,
          border: "3px solid rgba(43,212,255,0.35)", borderRadius: "50%",
          animation: `tv-ring 2.8s ease-out ${d}s infinite`,
        }} />
      ))}
    </>
  );
}

/** Waveform de áudio (barras animadas). */
export function TvWave({ bars = 26, color = "#7CE7FF", height = 40 }: { bars?: number; color?: string; height?: number }) {
  const hs = Array.from({ length: bars }, (_, i) => {
    const t = i / bars;
    const env = Math.sin(t * Math.PI) * 0.7 + 0.3;
    const noise = Math.abs(Math.sin(i * 12.9898) * 43758.5453 % 1);
    return Math.max(0.2, env * (0.5 + noise * 0.5));
  });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 5, height }}>
      {hs.map((h, i) => (
        <span key={i} style={{ width: 5, height: `${h * 100}%`, background: color, borderRadius: 3, transformOrigin: "center", animation: `tv-wave-bar 0.9s ease-in-out ${i * 0.045}s infinite` }} />
      ))}
    </div>
  );
}

/** Três pontinhos de "digitando…". */
export function TvTypingDots() {
  return (
    <span style={{ display: "inline-flex", gap: 8, padding: "6px 4px" }}>
      {[0, 1, 2].map((i) => (
        <span key={i} style={{ width: 13, height: 13, borderRadius: 999, background: "#7CE7FF", animation: `tv-typing-dot 1.2s ease-in-out ${i * 0.15}s infinite` }} />
      ))}
    </span>
  );
}
