"use client";

import { useEffect, useState } from "react";
import { Mascot, BrandChip, BgOrbs } from "./components";

export function ScreenAttract({ onCTA }: { onCTA: (r: "demo" | "cadastro") => void }) {
  const prompts = [
    "“Marca uma reunião com o João terça 15h.”",
    "“Atualiza: cliente quer pensar até semana que vem.”",
    "“Cliente diabético — qual o melhor seguro?”",
    "“Manda follow-up pra Maria.”",
  ];
  const [idx, setIdx] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setIdx((i) => (i + 1) % prompts.length), 2800);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="absolute-fill bg-grid" style={{ background: "var(--bg)" }}>
      <BgOrbs />

      <div style={{ position: "absolute", top: 36, left: 36, zIndex: 5 }}>
        <BrandChip />
      </div>
      <div style={{ position: "absolute", top: 44, right: 44, zIndex: 5, display: "flex", alignItems: "center", gap: 16 }}>
        <span style={{ padding: "8px 14px", borderRadius: 999, background: "white", border: "1px solid var(--line)", fontSize: 14, fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase" }}>Convenção 2026 • Demonstração</span>
      </div>

      <div style={{ position: "absolute", inset: "120px 64px 80px 64px", display: "grid", gridTemplateColumns: "1fr 1.05fr", gap: 48, alignItems: "center" }}>
        {/* LEFT — copy + CTAs */}
        <div style={{ position: "relative", zIndex: 4 }}>
          <div className="eyebrow" style={{ marginBottom: 24 }}>
            <span style={{ display: "inline-block", width: 28, height: 2, background: "var(--brand-darker)", marginRight: 12, verticalAlign: "middle" }} />
            Conheça o SparkBot
          </div>

          <h1 className="display-xl" style={{ margin: 0, color: "var(--ink)" }}>
            Você fala.<br />
            <span style={{ background: "var(--brand-gradient)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>Ele resolve.</span>
          </h1>

          <p className="lede" style={{ marginTop: 28, maxWidth: 580 }}>
            O copiloto de IA que vive no seu WhatsApp. Manda um áudio — ele <b style={{ color: "var(--ink)" }}>agenda</b>,
            <b style={{ color: "var(--ink)" }}> anota</b>, <b style={{ color: "var(--ink)" }}>atualiza o lead</b> e
            <b style={{ color: "var(--ink)" }}> faz follow-up</b> dentro do seu CRM. Sozinho.
          </p>

          {/* live prompt ticker */}
          <div style={{ marginTop: 36, padding: "20px 24px", background: "white", borderRadius: 22, border: "1px solid var(--line)", boxShadow: "var(--shadow-md)", display: "flex", alignItems: "center", gap: 18, minHeight: 88, maxWidth: 620 }}>
            <div style={{ width: 56, height: 56, borderRadius: 18, background: "var(--brand-gradient)", display: "grid", placeItems: "center", flexShrink: 0, boxShadow: "0 8px 20px rgba(15,181,225,0.35)" }}>
              <svg width="26" height="26" viewBox="0 0 24 24" fill="none">
                <rect x="9" y="3" width="6" height="13" rx="3" fill="white" />
                <path d="M5 11a7 7 0 0 0 14 0M12 18v3" stroke="white" strokeWidth="2" strokeLinecap="round" fill="none" />
              </svg>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>Exemplo de áudio</div>
              <div style={{ fontSize: 22, fontWeight: 600, color: "var(--ink)", lineHeight: 1.35, letterSpacing: "-0.01em", minHeight: 32, transition: "opacity 0.4s" }}>
                {prompts[idx]}
              </div>
            </div>
          </div>

          {/* CTAs */}
          <div style={{ marginTop: 44, display: "flex", gap: 18, alignItems: "center", flexWrap: "wrap" }}>
            <button className="btn btn-primary btn-lg" onClick={() => onCTA("demo")} style={{ animation: "glow-ring 2.6s ease-in-out infinite" }}>
              <svg width="28" height="28" viewBox="0 0 24 24" fill="none"><path d="M5 4l14 8-14 8V4z" fill="white" /></svg>
              Conhecer o SparkBot
            </button>
            <button className="btn btn-secondary btn-lg" onClick={() => onCTA("cadastro")}>
              Quero me cadastrar
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
          </div>

          <div style={{ marginTop: 32, display: "flex", alignItems: "center", gap: 12, color: "var(--ink-3)" }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="9" stroke="currentColor" strokeWidth="2" />
              <path d="M12 8v4l3 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
            <span className="body">Demonstração de 90 segundos · ninguém precisa te ensinar</span>
          </div>
        </div>

        {/* RIGHT — mascot stage */}
        <div style={{ position: "relative", height: "100%", display: "grid", placeItems: "center" }}>
          <div style={{ position: "absolute", width: 600, height: 600, borderRadius: "50%", background: "radial-gradient(circle, rgba(15,181,225,0.20), transparent 65%)", filter: "blur(8px)" }} />
          <OrbitChip angle={-55} distance={260} label="📅 Agenda" delay={0} />
          <OrbitChip angle={55} distance={250} label="📝 Anota" delay={0.4} />
          <OrbitChip angle={150} distance={260} label="🔄 Atualiza lead" delay={0.8} />
          <OrbitChip angle={210} distance={260} label="🎯 Follow-up" delay={1.2} />

          <Mascot pose="wave" size={600} breath ring />

          <div style={{ position: "absolute", bottom: 8 }}>
            <div style={{ padding: "16px 26px", background: "white", borderRadius: 999, boxShadow: "var(--shadow-lg)", display: "flex", alignItems: "center", gap: 14, animation: "float-y 2.4s ease-in-out infinite" }}>
              <span style={{ fontSize: 28 }}>👋</span>
              <span style={{ fontSize: 19, fontWeight: 700 }}>Oi! Toca aí pra conhecer.</span>
            </div>
          </div>
        </div>
      </div>

      <div style={{ position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)", fontSize: 13, color: "var(--ink-4)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>
        sparkleads<span style={{ color: "var(--brand)" }}>.</span>pro
      </div>
    </div>
  );
}

function OrbitChip({ angle, distance, label, delay = 0 }: { angle: number; distance: number; label: string; delay?: number }) {
  const rad = (angle * Math.PI) / 180;
  const x = Math.cos(rad) * distance;
  const y = Math.sin(rad) * distance;
  return (
    <div style={{ position: "absolute", left: `calc(50% + ${x}px)`, top: `calc(50% + ${y}px)`, transform: "translate(-50%, -50%)", zIndex: 3 }}>
      <div style={{ animation: `float-y 3.4s ease-in-out ${delay}s infinite` }}>
        <div style={{ padding: "12px 20px", background: "white", borderRadius: 999, boxShadow: "var(--shadow-md)", border: "1px solid var(--line)", fontSize: 17, fontWeight: 700, whiteSpace: "nowrap" }}>
          {label}
        </div>
      </div>
    </div>
  );
}
