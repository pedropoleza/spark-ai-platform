"use client";

import { useState, type ReactNode } from "react";
import { Mascot, BrandChip, BgOrbs } from "./components";

export interface LeadForm { nome: string; whatsapp: string; agencia: string }
type Route = "attract" | "demo" | "cadastro" | "sucesso";

export function ScreenCadastro({ onCTA, onSubmit, initialName }: { onCTA: (r: Route) => void; onSubmit: (f: LeadForm) => void; initialName?: string | null }) {
  // Nome vem pré-preenchido da tela do nome (refactor 2026-06-11) — sobram 2 campos.
  const [form, setForm] = useState<LeadForm>({ nome: initialName || "", whatsapp: "", agencia: "" });
  const [activeField, setActiveField] = useState<string | null>(null);

  const set = (k: keyof LeadForm, v: string) => setForm((f) => ({ ...f, [k]: v }));

  // Formato AMERICANO (Pedro 2026-06-12): convenção é nos EUA — público BR
  // morando lá usa número US: (407) 555-0123, 10 dígitos.
  const fmtPhone = (raw: string) => {
    const d = raw.replace(/\D/g, "").slice(0, 10);
    if (d.length <= 3) return d;
    if (d.length <= 6) return `(${d.slice(0, 3)}) ${d.slice(3)}`;
    return `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}`;
  };

  const valid = form.nome.trim().length >= 2 && form.whatsapp.replace(/\D/g, "").length >= 10 && form.agencia.trim().length >= 2;

  const submit = () => {
    if (!valid) return;
    onSubmit(form);
    onCTA("sucesso");
  };

  return (
    <div className="absolute-fill bg-grid" style={{ background: "var(--bg)" }}>
      <BgOrbs />

      <div style={{ position: "absolute", top: 24, left: 32, zIndex: 5 }}>
        <BrandChip />
      </div>
      <div style={{ position: "absolute", top: 32, right: 32, zIndex: 5 }}>
        <button onClick={() => onCTA("attract")} style={{ display: "flex", alignItems: "center", gap: 8, background: "white", border: "1px solid var(--line)", borderRadius: 999, padding: "10px 18px", fontWeight: 700, fontSize: 14, color: "var(--ink-2)", cursor: "pointer", fontFamily: "inherit" }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>
          Voltar
        </button>
      </div>

      <div style={{ position: "absolute", inset: "110px 56px 56px 56px", display: "grid", gridTemplateColumns: "1fr 1.15fr", gap: 56, alignItems: "center" }}>
        {/* LEFT — copy + mascot */}
        <div style={{ position: "relative" }}>
          <div className="eyebrow" style={{ marginBottom: 18 }}>Falta só um passo</div>
          <h1 className="display-lg" style={{ margin: 0 }}>
            Deixa teu contato.<br />
            <span style={{ background: "var(--brand-gradient)", WebkitBackgroundClip: "text", WebkitTextFillColor: "transparent", backgroundClip: "text" }}>A gente te mostra ao vivo.</span>
          </h1>
          <p className="lede" style={{ marginTop: 24, maxWidth: 540 }}>
            Em até 24h um especialista do Spark Leads te chama pra ativar a plataforma — CRM + SparkBot — na sua operação. Sem demo chata, sem pressão.
          </p>

          <div style={{ marginTop: 36, display: "flex", flexDirection: "column", gap: 14 }}>
            {[
              { ic: "⚡", text: "Ativação em até 48h" },
              { ic: "🛡️", text: "Seus dados ficam só com você" },
              { ic: "🇧🇷", text: "Suporte humano em português" },
            ].map((b, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 14, fontSize: 20, fontWeight: 600, color: "var(--ink-2)" }}>
                <span style={{ width: 44, height: 44, borderRadius: 12, background: "white", border: "1px solid var(--line)", display: "grid", placeItems: "center", fontSize: 22, boxShadow: "var(--shadow-sm)" }}>{b.ic}</span>
                {b.text}
              </div>
            ))}
          </div>

          <div style={{ position: "absolute", bottom: -40, right: 40, width: 200, height: 200 }}>
            <Mascot pose="presenting" size={200} breath />
          </div>
        </div>

        {/* RIGHT — form card */}
        <div style={{ background: "white", borderRadius: 32, padding: 40, boxShadow: "var(--shadow-xl)", border: "1px solid var(--line)", position: "relative" }}>
          <div style={{ position: "absolute", top: -16, left: 40, background: "var(--ink)", color: "white", padding: "8px 16px", borderRadius: 999, fontSize: 12, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", whiteSpace: "nowrap" }}>Acesso antecipado · grátis</div>

          <div style={{ display: "flex", flexDirection: "column", gap: 22 }}>
            <Field label="Seu nome" placeholder="Como você quer ser chamado?" value={form.nome} onChange={(v) => set("nome", v)} focused={activeField === "nome"} onFocus={() => setActiveField("nome")} onBlur={() => setActiveField(null)}
              icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="8" r="4" stroke="currentColor" strokeWidth="2" /><path d="M4 21c0-4 4-7 8-7s8 3 8 7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>} />
            <Field label="WhatsApp (número americano)" placeholder="(407) 555-0123" value={form.whatsapp} onChange={(v) => set("whatsapp", fmtPhone(v))} focused={activeField === "whatsapp"} onFocus={() => setActiveField("whatsapp")} onBlur={() => setActiveField(null)} inputMode="numeric"
              icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M20 4H8a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12V4z" stroke="currentColor" strokeWidth="2" /><path d="M13 16h.01" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" /></svg>} />
            <Field label="Nome da agência ou equipe" placeholder="Ex.: Equipe Lima, Spark Corretora…" value={form.agencia} onChange={(v) => set("agencia", v)} focused={activeField === "agencia"} onFocus={() => setActiveField("agencia")} onBlur={() => setActiveField(null)}
              icon={<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 21h18M5 21V8l7-4 7 4v13M9 21v-6h6v6" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" /></svg>} />

            {/* próximo passo: checkout via QR na tela de sucesso (Pedro 2026-06-12) */}
            <div style={{ padding: 16, background: "var(--bg)", borderRadius: 16, border: "1px dashed var(--line)", display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-3)", letterSpacing: "0.08em", textTransform: "uppercase", background: "white", padding: "4px 10px", borderRadius: 999, border: "1px solid var(--line)", whiteSpace: "nowrap", flexShrink: 0 }}>Próximo passo</span>
              <span style={{ fontSize: 14, color: "var(--ink-3)" }}>Depois do cadastro você já escolhe seu plano e ativa.</span>
            </div>

            <button onClick={submit} disabled={!valid} className="btn btn-primary" style={{ width: "100%", padding: "28px 32px", fontSize: 24, opacity: valid ? 1 : 0.55, cursor: valid ? "pointer" : "not-allowed", animation: valid ? "glow-ring 2.4s ease-in-out infinite" : "none" }}>
              Quero acesso ao SparkBot
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M13 5l7 7-7 7" stroke="currentColor" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
            </button>
            <div style={{ fontSize: 13, color: "var(--ink-3)", textAlign: "center" }}>Ao continuar você concorda em receber contato pelo WhatsApp informado.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

function Field({ label, placeholder, value, onChange, focused, onFocus, onBlur, icon, inputMode }: {
  label: string; placeholder: string; value: string; onChange: (v: string) => void;
  focused: boolean; onFocus: () => void; onBlur: () => void; icon: ReactNode; inputMode?: "numeric" | "text";
}) {
  return (
    <div>
      <label className="field-label">{label}</label>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        <div style={{ position: "absolute", left: 22, color: focused ? "var(--brand)" : "var(--ink-4)", display: "grid", placeItems: "center", transition: "color 0.2s" }}>{icon}</div>
        <input className="field" value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} onFocus={onFocus} onBlur={onBlur} inputMode={inputMode} style={{ paddingLeft: 60 }} />
      </div>
    </div>
  );
}
