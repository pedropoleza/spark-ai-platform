/* eslint-disable @next/next/no-img-element */
"use client";

// Tela de sucesso (Pedro 2026-06-12): depois do cadastro, CHECKOUT na hora —
// QR pro sparkleads.pro/#planos (pessoa escolhe o plano no próprio celular).
// Callback humano em 24h vira o fallback de quem não escanear.
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
        <div style={{ width: 1260, padding: 48, background: "white", borderRadius: 36, boxShadow: "var(--shadow-xl)", border: "1px solid var(--line)", position: "relative", display: "grid", gridTemplateColumns: "auto 1fr auto", gap: 44, alignItems: "center" }}>
          {/* mascote */}
          <div style={{ position: "relative" }}>
            <Mascot pose="celebrating" size={260} breath />
            <div style={{ position: "absolute", top: -8, left: -14, background: "var(--success)", color: "white", padding: "8px 16px", borderRadius: 999, fontWeight: 800, fontSize: 14, letterSpacing: "0.04em", boxShadow: "0 10px 24px rgba(29,185,84,0.4)", display: "flex", alignItems: "center", gap: 8, transform: "rotate(-8deg)" }}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="white" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              Tudo certo!
            </div>
          </div>

          {/* copy */}
          <div style={{ minWidth: 0 }}>
            <div className="eyebrow" style={{ color: "var(--success)" }}>Cadastro recebido</div>
            <h1 className="display-md" style={{ margin: "10px 0 0", fontSize: 52 }}>
              Valeu, {firstName}!<br />
              <span style={{ background: "var(--brand-gradient)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>Agora escolhe teu plano.</span>
            </h1>
            <p className="body-lg" style={{ marginTop: 16 }}>
              Escaneia o QR com teu celular, vê os planos e já ativa o Spark Leads na tua operação — leva 2 minutos.
            </p>

            <div style={{ marginTop: 20, padding: "14px 18px", background: "var(--brand-tint-2)", borderRadius: 14, border: "1px solid #BCE6F2", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 22 }}>💬</span>
              <span style={{ fontSize: 15, color: "var(--ink-2)", lineHeight: 1.4 }}>
                Prefere falar com alguém antes? Tranquilo — em até 24h um especialista te chama no WhatsApp que você cadastrou.
              </span>
            </div>

            <div style={{ marginTop: 24, display: "flex", gap: 14, flexWrap: "wrap" }}>
              <button className="btn btn-primary" style={{ padding: "18px 30px", fontSize: 20 }} onClick={() => onCTA("demo")}>
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M5 4l14 8-14 8V4z" fill="white" /></svg>
                Rever a demonstração
              </button>
              <button className="btn btn-secondary" style={{ padding: "18px 30px", fontSize: 20 }} onClick={() => onCTA("attract")}>Voltar ao início</button>
            </div>
          </div>

          {/* QR checkout */}
          <div style={{ textAlign: "center" }}>
            <div style={{ position: "relative", padding: 22, background: "white", borderRadius: 26, border: "2px solid var(--brand)", boxShadow: "0 24px 60px rgba(15,181,225,0.25)", animation: "glow-ring 2.6s ease-in-out infinite" }}>
              <div style={{ position: "absolute", top: -14, left: "50%", transform: "translateX(-50%)", background: "var(--ink)", color: "white", padding: "6px 16px", borderRadius: 999, fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                Escolher meu plano
              </div>
              <img src="/demo/qr-checkout.svg" alt="QR code para sparkleads.pro/#planos" style={{ width: 250, height: 250, display: "block" }} />
            </div>
            <div style={{ marginTop: 14, fontSize: 13, fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", color: "var(--ink-3)" }}>Aponta a câmera 📱</div>
            <div style={{ marginTop: 4, fontSize: 19, fontWeight: 800, color: "var(--ink)" }}>
              sparkleads<span style={{ color: "var(--brand-darker)" }}>.pro/#planos</span>
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
