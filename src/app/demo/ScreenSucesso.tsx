"use client";

import { useEffect, useState } from "react";
import { Mascot, BrandChip, BgOrbs, ConfettiBurst } from "./components";
import type { LeadForm } from "./ScreenCadastro";

type Route = "attract" | "demo" | "cadastro" | "sucesso";

export function ScreenSucesso({ form, onCTA }: { form: LeadForm | null; onCTA: (r: Route) => void }) {
  const [showConfetti, setShowConfetti] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setShowConfetti(false), 1500);
    return () => clearTimeout(t);
  }, []);

  const firstName = (form?.nome || "").split(" ")[0] || "amigo";

  return (
    <div className="absolute-fill bg-grid" style={{ background: "linear-gradient(180deg, #E6F7FC 0%, #F3F7FA 100%)" }}>
      <BgOrbs />
      <div style={{ position: "absolute", top: 24, left: 32, zIndex: 5 }}>
        <BrandChip />
      </div>

      {showConfetti && <ConfettiBurst x="50%" y="40%" count={56} />}

      <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center" }}>
        <div style={{ width: 1100, padding: 56, background: "white", borderRadius: 36, boxShadow: "var(--shadow-xl)", border: "1px solid var(--line)", position: "relative", display: "grid", gridTemplateColumns: "auto 1fr", gap: 48, alignItems: "center" }}>
          {/* mascot */}
          <div style={{ position: "relative" }}>
            <Mascot pose="celebrating" size={340} breath ring />
            <div style={{ position: "absolute", top: -10, left: -10, background: "var(--success)", color: "white", padding: "10px 18px", borderRadius: 999, fontWeight: 800, fontSize: 16, letterSpacing: "0.04em", boxShadow: "0 10px 24px rgba(29,185,84,0.4)", display: "flex", alignItems: "center", gap: 8, transform: "rotate(-8deg)" }}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Tudo certo!
            </div>
          </div>

          {/* copy */}
          <div>
            <div className="eyebrow" style={{ color: "var(--success)" }}>Cadastro recebido</div>
            <h1 className="display-md" style={{ margin: "12px 0 0" }}>
              Valeu, {firstName}!<br />
              <span style={{ background: "var(--brand-gradient)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>A gente fala com você em breve.</span>
            </h1>
            <p className="body-lg" style={{ marginTop: 18 }}>
              Em até 24h um especialista te chama no WhatsApp que você cadastrou pra ativar o SparkBot na sua operação.
            </p>

            <div style={{ marginTop: 24, padding: 22, background: "var(--brand-tint-2)", borderRadius: 18, border: "1px solid #BCE6F2", display: "flex", flexDirection: "column", gap: 18 }}>
              {[
                { n: "1", t: "Te ligamos no WhatsApp", s: "Em até 24h pra alinhar a ativação" },
                { n: "2", t: "Conectamos o SparkBot ao seu CRM", s: "Sem você fazer nada técnico" },
                { n: "3", t: "Você manda áudio. Ele resolve.", s: "Como você viu na demonstração" },
              ].map((step) => (
                <div key={step.n} style={{ display: "flex", gap: 14, alignItems: "flex-start" }}>
                  <Step n={step.n} />
                  <div style={{ paddingTop: 2 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)", lineHeight: 1.3 }}>{step.t}</div>
                    <div style={{ fontSize: 14, color: "var(--ink-3)", marginTop: 4 }}>{step.s}</div>
                  </div>
                </div>
              ))}
            </div>

            <div style={{ marginTop: 28, display: "flex", gap: 14, flexWrap: "wrap" }}>
              <button className="btn btn-primary" onClick={() => onCTA("demo")}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M5 4l14 8-14 8V4z" fill="white" /></svg>
                Ver o SparkBot em ação
              </button>
              <button className="btn btn-secondary" onClick={() => onCTA("attract")}>Voltar ao início</button>
            </div>
          </div>
        </div>
      </div>

      <div style={{ position: "absolute", bottom: 24, left: "50%", transform: "translateX(-50%)", fontSize: 13, color: "var(--ink-4)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>
        sparkleads<span style={{ color: "var(--brand)" }}>.</span>pro
      </div>
    </div>
  );
}

function Step({ n }: { n: string }) {
  return (
    <span style={{ width: 32, height: 32, borderRadius: 999, background: "var(--brand-gradient)", color: "white", fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0, boxShadow: "0 6px 14px rgba(15,181,225,0.35)" }}>{n}</span>
  );
}
