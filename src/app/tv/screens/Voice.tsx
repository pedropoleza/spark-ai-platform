"use client";

/* eslint-disable @next/next/no-img-element */
// Tela 2 — Você fala. Ele resolve. Chat WhatsApp (tema dark) auto-play.
// Roteiro 10s: 0.8s áudio entra · 2.6s transcrição · 4.4-6.6s typing · 6.7s resposta · 8.6s pill.
import { VOICE } from "../data";
import { TvBrand, TvCorner, TvWave, TvTypingDots } from "./shared";

export function VoiceScreen() {
  return (
    <div className="tv-layer">
      <TvBrand />
      <TvCorner>SparkBot ao vivo</TvCorner>

      <div style={{ position: "absolute", inset: "190px 96px 100px 96px", display: "grid", gridTemplateColumns: "1fr 760px", gap: 80, alignItems: "center" }}>
        {/* Copy */}
        <div>
          <h2 className="tv-display-xl" style={{ margin: 0 }}>
            <span style={{ display: "block", animation: "tv-rise 0.8s 0.2s both" }}>{VOICE.title1}</span>
            <span className="tv-gradient-text" style={{ display: "block", animation: "tv-rise 0.8s 0.6s both" }}>{VOICE.title2}</span>
          </h2>
          <p className="tv-lede" style={{ marginTop: 34, maxWidth: 700, animation: "tv-rise 0.8s 1.2s both" }}>{VOICE.sub}</p>

          <div style={{ marginTop: 52, display: "flex", alignItems: "center", gap: 22, animation: "tv-pop 0.7s 8.6s both" }}>
            <span style={{ width: 64, height: 64, borderRadius: 999, background: "rgba(52,226,122,0.15)", border: "2px solid var(--tv-success)", display: "grid", placeItems: "center", fontSize: 30 }}>📅</span>
            <span style={{ fontSize: 36, fontWeight: 800, color: "var(--tv-success)" }}>{VOICE.pill.replace("📅 ", "")}</span>
          </div>
        </div>

        {/* Phone — WhatsApp dark */}
        <div style={{ height: 780, borderRadius: 48, overflow: "hidden", background: "#0B141A", border: "1px solid var(--tv-line)", boxShadow: "0 50px 120px rgba(0,0,0,0.6), 0 0 80px rgba(43,212,255,0.08)", display: "flex", flexDirection: "column", animation: "tv-rise 0.8s 0.3s both" }}>
          {/* header */}
          <div style={{ background: "#1F2C34", padding: "26px 30px", display: "flex", alignItems: "center", gap: 22, flexShrink: 0 }}>
            <span style={{ width: 72, height: 72, borderRadius: "50%", background: "white", display: "grid", placeItems: "center", overflow: "hidden" }}>
              <img src="/demo/assets/logo-k-blue.png" alt="" style={{ width: 62, height: 62, borderRadius: "50%" }} />
            </span>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 32, fontWeight: 700 }}>SparkBot</div>
              <div style={{ fontSize: 22, color: "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", gap: 10 }}>
                <span style={{ width: 11, height: 11, borderRadius: 999, background: "var(--tv-success)" }} />
                online · seu copiloto
              </div>
            </div>
          </div>

          {/* mensagens */}
          <div style={{ flex: 1, padding: "30px 26px", display: "flex", flexDirection: "column", gap: 18 }}>
            {/* áudio do rep */}
            <div style={{ alignSelf: "flex-end", maxWidth: "88%", background: "#005C4B", borderRadius: "24px 24px 6px 24px", padding: "20px 24px", animation: "tv-pop 0.6s 0.8s both" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 18 }}>
                <span style={{ width: 58, height: 58, borderRadius: "50%", background: "rgba(255,255,255,0.15)", display: "grid", placeItems: "center", flexShrink: 0 }}>
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="#7CE7FF"><path d="M8 5v14l11-7z" /></svg>
                </span>
                <TvWave />
                <span style={{ fontSize: 22, color: "rgba(255,255,255,0.65)" }}>0:11</span>
              </div>
              <div style={{ marginTop: 16, paddingTop: 16, borderTop: "1px solid rgba(255,255,255,0.18)", fontSize: 26, lineHeight: 1.4, fontStyle: "italic", color: "rgba(255,255,255,0.92)", animation: "tv-fade 0.8s 2.6s both" }}>
                {VOICE.transcript}
              </div>
            </div>

            {/* typing (aparece e some, fora do fluxo) + resposta do bot no mesmo lugar */}
            <div style={{ position: "relative" }}>
              <div style={{ position: "absolute", left: 0, top: 0, background: "#1F2C34", borderRadius: "24px 24px 24px 6px", padding: "16px 24px", animation: "tv-show-hide 2.4s 4.4s both", opacity: 0 }}>
                <TvTypingDots />
              </div>
              <div style={{ maxWidth: "92%", width: "fit-content", background: "#1F2C34", borderRadius: "24px 24px 24px 6px", padding: "22px 28px", fontSize: 28, lineHeight: 1.45, whiteSpace: "pre-wrap", animation: "tv-pop 0.7s 6.7s both", opacity: 0 }}>
                {VOICE.reply}
                <div style={{ textAlign: "right", fontSize: 20, color: "rgba(255,255,255,0.5)", marginTop: 8 }}>
                  agora <span style={{ color: "#53BDEB" }}>✓✓</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
