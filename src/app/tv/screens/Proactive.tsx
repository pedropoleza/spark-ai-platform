"use client";

// Tela 5 — Ele trabalha enquanto você atende. Proativo.
// Roteiro 10s: 0.8s alerta Maria · 3.2s mensagem enviada · 4.2s carimbo ·
// 5.5-8.5s feed de atividade em stagger.
import { PROACTIVE } from "../data";
import { TvBrand, TvCorner, TvMascot } from "./shared";

export function ProactiveScreen() {
  return (
    <div className="tv-layer">
      <TvBrand />
      <TvCorner>SparkBot agindo</TvCorner>

      <div style={{ position: "absolute", inset: "190px 96px 90px 96px", display: "grid", gridTemplateColumns: "1.15fr 1fr", gap: 70 }}>
        {/* Copy + alerta + mensagem */}
        <div>
          <h2 className="tv-display" style={{ margin: 0, animation: "tv-rise 0.7s 0.15s both" }}>
            Ele trabalha enquanto <span className="tv-gradient-text">você atende.</span>
          </h2>
          <p className="tv-lede" style={{ marginTop: 16, animation: "tv-rise 0.7s 0.5s both" }}>{PROACTIVE.sub}</p>

          {/* alerta lead esfriando */}
          <div style={{ marginTop: 46, padding: "26px 30px", borderRadius: 24, background: "rgba(255,164,92,0.10)", border: "2px solid rgba(255,164,92,0.55)", display: "flex", alignItems: "center", gap: 24, animation: "tv-pop 0.7s 0.9s both" }}>
            <span style={{ width: 76, height: 76, borderRadius: 20, background: "var(--tv-warn)", display: "grid", placeItems: "center", fontSize: 38, flexShrink: 0 }}>❄</span>
            <div>
              <div style={{ fontSize: 36, fontWeight: 800 }}>{PROACTIVE.alert.name}</div>
              <div style={{ fontSize: 26, color: "var(--tv-ink-2)", marginTop: 4 }}>{PROACTIVE.alert.detail}</div>
            </div>
          </div>

          {/* mensagem que o bot mandou */}
          <div style={{ marginTop: 26, padding: "28px 32px", borderRadius: 24, background: "var(--tv-panel)", border: "1px solid var(--tv-line)", animation: "tv-rise 0.7s 3.2s both" }}>
            <div style={{ fontSize: 30, lineHeight: 1.5, fontStyle: "italic", color: "var(--tv-ink)" }}>{PROACTIVE.message}</div>
            <div style={{ marginTop: 18, fontSize: 27, fontWeight: 800, color: "var(--tv-success)", animation: "tv-fade 0.6s 4.4s both" }}>{PROACTIVE.sentAt}</div>
          </div>
        </div>

        {/* Feed + mascote */}
        <div style={{ position: "relative", display: "flex", flexDirection: "column", justifyContent: "center" }}>
          <div className="tv-glass" style={{ padding: "30px 34px", animation: "tv-rise 0.7s 5s both" }}>
            <div style={{ fontSize: 24, fontWeight: 800, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--tv-ink-3)", marginBottom: 22 }}>Atividade de hoje</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 18 }}>
              {PROACTIVE.feed.map((f, i) => (
                <div key={i} style={{ display: "flex", alignItems: "center", gap: 20, padding: "18px 22px", borderRadius: 18, background: i === 0 ? "rgba(43,212,255,0.10)" : "rgba(255,255,255,0.03)", border: i === 0 ? "1px solid rgba(43,212,255,0.4)" : "1px solid transparent", animation: `tv-slide-right 0.6s ${5.5 + i * 0.7}s both` }}>
                  <span style={{ fontSize: 34 }}>{f.icon}</span>
                  <span style={{ flex: 1, fontSize: 26, fontWeight: i === 0 ? 700 : 500, color: i === 0 ? "var(--tv-ink)" : "var(--tv-ink-2)" }}>{f.text}</span>
                  <span style={{ fontSize: 21, color: "var(--tv-ink-3)", flexShrink: 0 }}>{f.time}</span>
                </div>
              ))}
            </div>
          </div>
          <div style={{ position: "absolute", bottom: -34, right: -26, animation: "tv-pop 0.8s 6s both" }}>
            <TvMascot pose="thumbsup" size={250} />
          </div>
        </div>
      </div>
    </div>
  );
}
