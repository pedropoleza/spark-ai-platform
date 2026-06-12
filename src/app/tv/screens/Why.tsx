"use client";

// Tela 6 — Por que Spark Leads. 4 value props grandes em stagger.
import { WHY } from "../data";
import { TvBrand, TvCorner } from "./shared";

export function WhyScreen() {
  return (
    <div className="tv-layer">
      <TvBrand />
      <TvCorner>Spark Leads</TvCorner>

      <div style={{ position: "absolute", top: 210, left: 96, right: 96, textAlign: "center" }}>
        <div className="tv-eyebrow" style={{ animation: "tv-rise 0.7s 0.15s both" }}>{WHY.eyebrow}</div>
        <h2 className="tv-display" style={{ margin: "22px auto 0", maxWidth: 1500, animation: "tv-rise 0.8s 0.4s both" }}>
          Tudo que a sua operação precisa. <span className="tv-gradient-text">Num lugar só.</span>
        </h2>
      </div>

      <div style={{ position: "absolute", left: 96, right: 96, top: 520, bottom: 130, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 28 }}>
        {WHY.props.map((p, i) => (
          <div key={p.title} className="tv-glass" style={{ padding: "44px 36px", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: 24, animation: `tv-pop 0.7s ${0.9 + i * 0.45}s both` }}>
            <span style={{ width: 130, height: 130, borderRadius: 36, background: "rgba(43,212,255,0.10)", border: "1px solid rgba(43,212,255,0.35)", display: "grid", placeItems: "center", fontSize: 64, animation: `tv-float 3.4s ease-in-out ${i * 0.4}s infinite`, boxShadow: "0 0 50px rgba(43,212,255,0.12)" }}>{p.icon}</span>
            <div style={{ fontSize: 38, fontWeight: 800, letterSpacing: "-0.01em" }}>{p.title}</div>
            <div style={{ fontSize: 26, lineHeight: 1.45, color: "var(--tv-ink-2)" }}>{p.sub}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
