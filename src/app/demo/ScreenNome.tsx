"use client";

/**
 * Tela do nome (refactor 2026-06-11) — captura só o primeiro nome ANTES da demo
 * pra personalizar tudo (CRM vira "Painel de {Nome}", bot fala com a pessoa).
 * Lead fica meio-capturado desde o início; WhatsApp+agência só no cadastro final.
 */
import { useEffect, useRef, useState } from "react";
import { Mascot, BrandChip, BgOrbs } from "./components";

export function ScreenNome({ onSubmit, onBack }: { onSubmit: (name: string | null) => void; onBack: () => void }) {
  const [name, setName] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = name.trim().length >= 2;

  // Foco SEM scroll: autoFocus nativo scrolla o palco (overflow:hidden ainda tem
  // scrollTop) e desloca a tela inteira ~160px. preventScroll evita.
  useEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  const submit = () => {
    if (valid) onSubmit(name.trim().slice(0, 40));
  };

  return (
    <div className="absolute-fill bg-grid" style={{ background: "var(--bg)" }}>
      <BgOrbs />

      <div style={{ position: "absolute", top: 36, left: 36, zIndex: 5 }}>
        <BrandChip />
      </div>
      <div style={{ position: "absolute", top: 36, right: 36, zIndex: 5 }}>
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 8, background: "white", border: "1px solid var(--line)", borderRadius: 999, padding: "10px 18px", fontWeight: 700, fontSize: 14, color: "var(--ink-2)", cursor: "pointer", fontFamily: "inherit" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Voltar
        </button>
      </div>

      <div style={{ position: "absolute", inset: "140px 80px 100px 80px", display: "grid", gridTemplateColumns: "auto 1fr", gap: 64, alignItems: "center" }}>
        {/* Mascote */}
        <div style={{ position: "relative" }}>
          <Mascot pose="wave" size={460} breath ring />
          <div style={{ position: "absolute", top: -14, right: -50, background: "white", padding: "14px 22px", borderRadius: 18, boxShadow: "var(--shadow-lg)", border: "1px solid var(--line)", fontSize: 19, fontWeight: 700, whiteSpace: "nowrap", animation: "float-y 2.4s ease-in-out infinite", zIndex: 3 }}>
            Prazer! Eu sou o SparkBot 👋
          </div>
        </div>

        {/* Pergunta */}
        <div style={{ maxWidth: 620 }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>Antes de começar</div>
          <h1 className="display-lg" style={{ margin: 0 }}>
            Como você quer<br />
            <span style={{ background: "var(--brand-gradient)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>ser chamado?</span>
          </h1>
          <p className="lede" style={{ marginTop: 20 }}>
            A demonstração inteira vai falar com você pelo nome — só o primeiro já serve.
          </p>

          <div style={{ marginTop: 32 }}>
            <input
              ref={inputRef}
              className="field"
              value={name}
              placeholder="Seu primeiro nome"
              maxLength={40}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") submit(); }}
              style={{ fontSize: 30, padding: "26px 30px" }}
            />
          </div>

          <div style={{ marginTop: 28, display: "flex", gap: 16, alignItems: "center", flexWrap: "wrap" }}>
            <button
              className="btn btn-primary"
              onClick={submit}
              disabled={!valid}
              style={{ opacity: valid ? 1 : 0.55, cursor: valid ? "pointer" : "not-allowed", animation: valid ? "glow-ring 2.4s ease-in-out infinite" : "none" }}
            >
              Começar
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <button className="btn btn-ghost" onClick={() => onSubmit(null)} style={{ fontSize: 19 }}>
              Prefiro não dizer →
            </button>
          </div>
        </div>
      </div>

      <div style={{ position: "absolute", bottom: 28, left: "50%", transform: "translateX(-50%)", fontSize: 13, color: "var(--ink-4)", letterSpacing: "0.14em", textTransform: "uppercase", fontWeight: 700 }}>
        sparkleads<span style={{ color: "var(--brand)" }}>.</span>pro
      </div>
    </div>
  );
}
