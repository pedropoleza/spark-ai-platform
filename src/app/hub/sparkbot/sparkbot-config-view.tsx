"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

const TZ_OPTIONS = [
  { id: "America/New_York", label: "Leste dos EUA (ET) — Florida, NY" },
  { id: "America/Chicago", label: "Centro dos EUA (CT)" },
  { id: "America/Denver", label: "Montanha dos EUA (MT)" },
  { id: "America/Los_Angeles", label: "Pacífico dos EUA (PT)" },
  { id: "America/Sao_Paulo", label: "Brasília (BRT)" },
  { id: "Europe/Lisbon", label: "Lisboa" },
];

const TONE_FIELDS: ReadonlyArray<[keyof ToneState, string, string]> = [
  ["creativity", "Criatividade", "Mais alto = respostas mais soltas e variadas"],
  ["formality", "Formalidade", "Mais alto = mais formal; mais baixo = casual"],
  ["naturalness", "Naturalidade", "Mais alto = soa mais humano, menos robótico"],
  ["aggressiveness", "Assertividade", "Mais alto = mais direto e proativo"],
];

interface ToneState {
  creativity: number;
  formality: number;
  naturalness: number;
  aggressiveness: number;
}

const sectionCard: React.CSSProperties = {
  background: "#fff",
  border: "1px solid var(--border, rgba(15,23,42,0.1))",
  borderRadius: 14,
  padding: 20,
  marginBottom: 16,
};
const labelStyle: React.CSSProperties = { display: "block", fontSize: 13, fontWeight: 600, marginBottom: 6 };
const hintStyle: React.CSSProperties = { fontSize: 12, color: "#64748b", marginTop: 2 };
const inputStyle: React.CSSProperties = {
  width: "100%",
  maxWidth: 460,
  padding: "9px 11px",
  borderRadius: 9,
  border: "1px solid rgba(15,23,42,0.15)",
  fontSize: 14,
  background: "#fff",
};

export function SparkbotConfigView() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [agencyFound, setAgencyFound] = useState(false);

  // per-rep (do admin logado) — sincronizado com o que o bot define via chat
  const [verbosity, setVerbosity] = useState("normal");
  const [timezone, setTimezone] = useState("");
  const [briefing, setBriefing] = useState(true);
  // agência (admin-only)
  const [tone, setTone] = useState<ToneState>({ creativity: 50, formality: 50, naturalness: 50, aggressiveness: 50 });
  const [instr, setInstr] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetch("/api/hub/sparkbot-config")
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (!d.ok) {
          setErr("Não consegui carregar as configurações.");
          return;
        }
        setIsAdmin(!!d.is_admin);
        setVerbosity(d.prefs?.verbosity ?? "normal");
        setTimezone(typeof d.prefs?.timezone === "string" ? d.prefs.timezone : "");
        setBriefing(d.prefs?.daily_briefing_enabled !== false);
        if (d.agency?.agent_found) {
          setAgencyFound(true);
          if (d.agency.tone) {
            setTone({
              creativity: d.agency.tone.creativity ?? 50,
              formality: d.agency.tone.formality ?? 50,
              naturalness: d.agency.tone.naturalness ?? 50,
              aggressiveness: d.agency.tone.aggressiveness ?? 50,
            });
          }
          setInstr(typeof d.agency.custom_instructions === "string" ? d.agency.custom_instructions : "");
        }
      })
      .catch(() => {
        if (!cancelled) setErr("Falha de rede ao carregar.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const save = async () => {
    setSaving(true);
    setErr(null);
    setSaved(false);
    try {
      const body: Record<string, unknown> = {
        prefs: {
          verbosity,
          daily_briefing_enabled: briefing,
          ...(timezone ? { timezone } : {}),
        },
      };
      if (isAdmin && agencyFound) {
        body.agency = { tone, custom_instructions: instr };
      }
      const res = await fetch("/api/hub/sparkbot-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (d.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2800);
      } else {
        setErr("Não consegui salvar. Tente de novo.");
      }
    } catch {
      setErr("Falha de rede ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", paddingBottom: 90 }}>
      <div style={{ marginBottom: 18 }}>
        <Link href="/hub" style={{ fontSize: 13, color: "#64748b", textDecoration: "none" }}>
          ← Início
        </Link>
        <h1 style={{ fontSize: 24, fontWeight: 700, margin: "8px 0 2px" }}>Configurar SparkBot</h1>
        <p style={{ color: "#64748b", fontSize: 14, margin: 0 }}>
          O que o bot define sozinho na conversa também fica aqui — e os dois ficam sincronizados.
        </p>
      </div>

      {loading ? (
        <div style={{ color: "#64748b", padding: 24 }}>Carregando…</div>
      ) : (
        <>
          {/* ---- SUAS PREFERÊNCIAS (per-rep) ---- */}
          <div style={sectionCard}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 2 }}>Suas preferências</div>
            <div style={{ ...hintStyle, marginBottom: 16 }}>
              Como o SparkBot trabalha com você. Só afeta a sua experiência.
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Tamanho das respostas</label>
              <select style={inputStyle} value={verbosity} onChange={(e) => setVerbosity(e.target.value)}>
                <option value="brief">Curtas e diretas</option>
                <option value="normal">Equilibradas</option>
                <option value="detailed">Detalhadas</option>
              </select>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={labelStyle}>Fuso horário</label>
              <select style={inputStyle} value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                <option value="">— Detectar automático —</option>
                {timezone && !TZ_OPTIONS.some((t) => t.id === timezone) && (
                  <option value={timezone}>{timezone}</option>
                )}
                {TZ_OPTIONS.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 9, cursor: "pointer", fontSize: 14 }}>
              <input type="checkbox" checked={briefing} onChange={(e) => setBriefing(e.target.checked)} />
              <span>Resumo matinal (8h: agenda do dia + resumo de ontem)</span>
            </label>
          </div>

          {/* ---- CONFIG DA AGÊNCIA (admin-only) ---- */}
          {isAdmin && agencyFound && (
            <div style={{ ...sectionCard, borderColor: "rgba(21,94,239,0.25)" }}>
              <div style={{ fontSize: 15, fontWeight: 700, color: "#155EEF" }}>Config do SparkBot · Agência</div>
              <div style={{ ...hintStyle, marginBottom: 16 }}>
                Personalidade e instruções gerais. <strong>Afeta o SparkBot de TODOS os reps.</strong>
              </div>

              {TONE_FIELDS.map(([key, label, hint]) => (
                <div key={key} style={{ marginBottom: 16 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                    <label style={{ ...labelStyle, marginBottom: 2 }}>{label}</label>
                    <span style={{ fontSize: 13, fontWeight: 700, color: "#155EEF" }}>{tone[key]}</span>
                  </div>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    step={5}
                    value={tone[key]}
                    onChange={(e) => setTone((t) => ({ ...t, [key]: Number(e.target.value) }))}
                    style={{ width: "100%", maxWidth: 460 }}
                  />
                  <div style={hintStyle}>{hint}</div>
                </div>
              ))}

              <div style={{ marginTop: 8 }}>
                <label style={labelStyle}>Instruções do SparkBot</label>
                <textarea
                  value={instr}
                  onChange={(e) => setInstr(e.target.value)}
                  rows={6}
                  placeholder="Como o SparkBot deve se comportar com a equipe (tom, regras da operação, atalhos, o que priorizar)…"
                  style={{ ...inputStyle, maxWidth: "100%", resize: "vertical", minHeight: 110, fontFamily: "inherit" }}
                />
              </div>
            </div>
          )}

          {isAdmin && !agencyFound && (
            <div style={{ ...sectionCard, color: "#64748b", fontSize: 13 }}>
              Não encontrei o agente SparkBot da agência pra editar personalidade/instruções. Verifique se o
              account_assistant está ativo.
            </div>
          )}

          {err && <div style={{ color: "#dc2626", fontSize: 13, marginBottom: 10 }}>{err}</div>}
        </>
      )}

      {/* Barra de salvar fixa */}
      {!loading && (
        <div
          style={{
            position: "fixed",
            bottom: 0,
            left: 0,
            right: 0,
            background: "rgba(255,255,255,0.92)",
            backdropFilter: "blur(6px)",
            borderTop: "1px solid rgba(15,23,42,0.1)",
            padding: "12px 20px",
            display: "flex",
            justifyContent: "flex-end",
            alignItems: "center",
            gap: 12,
            zIndex: 30,
          }}
        >
          {saved && <span style={{ color: "#16a34a", fontSize: 13, fontWeight: 600 }}>Salvo ✅</span>}
          <button className="btn btn--primary" onClick={save} disabled={saving}>
            {saving ? "Salvando…" : "Salvar"}
          </button>
        </div>
      )}
    </div>
  );
}
