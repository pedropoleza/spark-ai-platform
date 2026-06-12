"use client";

/* eslint-disable @next/next/no-img-element */
// Tela 7 — CTA final: chama pro tablet + QR (app.sparkleads.pro).
// QR em card BRANCO (scanner prefere módulos escuros em fundo claro).
import { CTA, QR_URL } from "../data";
import { TvBrand, TvCorner, TvMascot, TvRings } from "./shared";

export function CtaScreen() {
  return (
    <div className="tv-layer">
      <TvBrand />
      <TvCorner>te esperando no estande</TvCorner>

      <div style={{ position: "absolute", inset: "170px 96px 100px 96px", display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 70, alignItems: "center" }}>
        {/* Mascote */}
        <div style={{ position: "relative", display: "grid", placeItems: "center", width: 560 }}>
          <div style={{ position: "absolute", width: 620, height: 620, borderRadius: "50%", background: "radial-gradient(circle, rgba(43,212,255,0.20), transparent 65%)" }} />
          <TvRings size={500} />
          <div style={{ animation: "tv-pop 0.9s 0.3s both" }}>
            <TvMascot pose="celebrating" size={540} />
          </div>
        </div>

        {/* Copy */}
        <div>
          <h2 className="tv-display-xl" style={{ margin: 0 }}>
            <span style={{ display: "block", animation: "tv-rise 0.8s 0.3s both" }}>Vem ver</span>
            <span className="tv-gradient-text" style={{ display: "block", animation: "tv-rise 0.8s 0.7s both" }}>ao vivo.</span>
          </h2>
          <p className="tv-lede" style={{ marginTop: 34, maxWidth: 640, animation: "tv-rise 0.8s 1.3s both", fontSize: 46, lineHeight: 1.3 }}>
            {CTA.sub}
          </p>
          <div style={{ marginTop: 44, display: "flex", alignItems: "center", gap: 18, animation: "tv-rise 0.8s 2s both" }}>
            <span style={{ width: 16, height: 16, borderRadius: 999, background: "var(--tv-success)", animation: "tv-pulse 1.8s ease-in-out infinite", flexShrink: 0 }} />
            <span style={{ fontSize: 30, color: "var(--tv-ink-2)", fontWeight: 600 }}>Demonstração de 2 minutos · você mesmo pilota</span>
          </div>
        </div>

        {/* QR */}
        <div style={{ textAlign: "center", animation: "tv-pop 0.8s 1s both" }}>
          <div style={{ padding: 36, background: "white", borderRadius: 40, boxShadow: "0 40px 110px rgba(0,0,0,0.55)", animation: "tv-glow 2.6s ease-in-out infinite" }}>
            <img src="/tv/qr.svg" alt="QR code para app.sparkleads.pro" style={{ width: 380, height: 380, display: "block" }} />
          </div>
          <div style={{ marginTop: 26, fontSize: 26, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--tv-ink-3)" }}>{CTA.qrLabel}</div>
          <div style={{ marginTop: 8, fontSize: 38, fontWeight: 800 }}>
            {QR_URL.split(".")[0]}<span className="tv-gradient-text">.{QR_URL.split(".").slice(1).join(".")}</span>
          </div>
        </div>
      </div>
    </div>
  );
}
