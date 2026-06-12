"use client";

// Tela 1 — Abertura. Roteiro 10s: 0-2s headline sobe linha a linha;
// 2-4s lede; 4.5-8s chips orbitam o mascote em stagger.
import { HERO } from "../data";
import { TvBrand, TvCorner, TvMascot, TvRings } from "./shared";

export function HeroScreen() {
  return (
    <div className="tv-layer">
      <TvBrand />
      <TvCorner>{HERO.badge}</TvCorner>

      <div style={{ position: "absolute", inset: "200px 96px 120px 96px", display: "grid", gridTemplateColumns: "1.05fr 1fr", gap: 40, alignItems: "center" }}>
        {/* Copy */}
        <div>
          <div className="tv-eyebrow" style={{ marginBottom: 30, animation: "tv-rise 0.7s 0.2s both" }}>
            <span style={{ display: "inline-block", width: 44, height: 3, background: "var(--tv-brand-bright)", marginRight: 18, verticalAlign: "middle" }} />
            {HERO.eyebrow}
          </div>
          {/* 92px: cada frase precisa caber em 1 linha na coluna (~830px) */}
          <h1 className="tv-display" style={{ margin: 0 }}>
            <span style={{ display: "block", animation: "tv-rise 0.8s 0.5s both" }}>{HERO.line1}</span>
            <span className="tv-gradient-text" style={{ display: "block", animation: "tv-rise 0.8s 1.1s both" }}>{HERO.line2}</span>
          </h1>
          <p className="tv-lede" style={{ marginTop: 36, maxWidth: 760, animation: "tv-rise 0.8s 2s both" }}>
            Funil, agenda e WhatsApp num lugar só — com um copiloto de IA que resolve por você.
          </p>
        </div>

        {/* Mascote + chips orbitando */}
        <div style={{ position: "relative", display: "grid", placeItems: "center", height: "100%" }}>
          <div style={{ position: "absolute", width: 700, height: 700, borderRadius: "50%", background: "radial-gradient(circle, rgba(43,212,255,0.18), transparent 65%)" }} />
          <TvRings size={520} />
          <div style={{ animation: "tv-pop 0.9s 0.4s both" }}>
            <TvMascot pose="wave" size={560} />
          </div>
          {/* offsets fixos (não órbita): chips nos 4 cantos, sem cobrir o mascote nem cortar na borda */}
          {HERO.chips.map((c, i) => {
            const pos = [
              { x: 245, y: -290 },
              { x: 215, y: 300 },
              { x: -255, y: 265 },
              { x: -270, y: -260 },
            ][i];
            return (
              // 3 camadas: translate estático ≠ camada com animação (animation sobrescreve transform)
              <div key={c} style={{ position: "absolute", left: `calc(50% + ${pos.x}px)`, top: `calc(50% + ${pos.y}px)`, transform: "translate(-50%,-50%)" }}>
                <div style={{ animation: `tv-pop 0.7s ${4.5 + i * 0.5}s both` }}>
                  <div style={{ padding: "18px 32px", borderRadius: 999, background: "rgba(10,22,32,0.85)", border: "1px solid rgba(43,212,255,0.4)", boxShadow: "0 14px 40px rgba(0,0,0,0.5), 0 0 30px rgba(43,212,255,0.15)", fontSize: 28, fontWeight: 700, whiteSpace: "nowrap", animation: "tv-float 3.2s ease-in-out infinite" }}>
                    {c}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
