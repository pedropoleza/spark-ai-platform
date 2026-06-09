"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ChevronLeft, Bot, SlidersHorizontal, Sparkles, FileText, Check, MessageSquare } from "lucide-react";

/**
 * Tela dedicada de config do SparkBot (Pedro 2026-06-09).
 *
 * Usa o MESMO design system v3 do detail-view dos agentes (.cfg-hdr / .cfg-layout
 * com rail + painel / .fstack / .switch / .slider / .cfg-savebar) — scoped em
 * .hub-root via o HubShell. Antes era inline-style cru ("paia"); agora é paridade
 * visual com a config dos agentes.
 *
 * Sincronização (item 2): os campos aqui são os MESMOS que as tools do bot
 * escrevem (verbosity / timezone / daily_briefing / tone_* / custom_instructions)
 * — uma fonte de verdade só, via /api/hub/sparkbot-config.
 */

type Cat = "prefs" | "personality" | "instructions";

const TZ_OPTIONS = [
  { id: "America/New_York", label: "Leste dos EUA (ET) — Florida, NY" },
  { id: "America/Chicago", label: "Centro dos EUA (CT)" },
  { id: "America/Denver", label: "Montanha dos EUA (MT)" },
  { id: "America/Los_Angeles", label: "Pacífico dos EUA (PT)" },
  { id: "America/Sao_Paulo", label: "Brasília (BRT)" },
  { id: "Europe/Lisbon", label: "Lisboa (WET)" },
];

interface Tone {
  creativity: number;
  formality: number;
  naturalness: number;
  aggressiveness: number;
}
const DEFAULT_TONE: Tone = { creativity: 50, formality: 50, naturalness: 50, aggressiveness: 50 };

const META: Record<Cat, { title: string; sub: string }> = {
  prefs: { title: "Suas preferências", sub: "Como o SparkBot trabalha com você. Só afeta a sua experiência." },
  personality: { title: "Personalidade", sub: "O jeitão do SparkBot com a equipe. Afeta o SparkBot de todos os reps da agência." },
  instructions: { title: "Instruções do SparkBot", sub: "Contexto e regras gerais que o SparkBot sempre segue. Afeta todos os reps." },
};

interface Snapshot {
  verbosity: string;
  timezone: string;
  briefing: boolean;
  tone: Tone;
  instr: string;
}

export function SparkbotConfigView() {
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [savedFlash, setSavedFlash] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [agencyFound, setAgencyFound] = useState(false);
  const [cat, setCat] = useState<Cat>("prefs");

  const [verbosity, setVerbosity] = useState("normal");
  const [timezone, setTimezone] = useState("");
  const [briefing, setBriefing] = useState(true);
  const [tone, setTone] = useState<Tone>(DEFAULT_TONE);
  const [instr, setInstr] = useState("");

  const initial = useRef<Snapshot | null>(null);

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
        const admin = !!d.is_admin;
        const v = d.prefs?.verbosity ?? "normal";
        const tz = typeof d.prefs?.timezone === "string" ? d.prefs.timezone : "";
        const br = d.prefs?.daily_briefing_enabled !== false;
        let tn = DEFAULT_TONE;
        let ins = "";
        let found = false;
        if (d.agency?.agent_found) {
          found = true;
          if (d.agency.tone) {
            tn = {
              creativity: d.agency.tone.creativity ?? 50,
              formality: d.agency.tone.formality ?? 50,
              naturalness: d.agency.tone.naturalness ?? 50,
              aggressiveness: d.agency.tone.aggressiveness ?? 50,
            };
          }
          ins = typeof d.agency.custom_instructions === "string" ? d.agency.custom_instructions : "";
        }
        setIsAdmin(admin);
        setAgencyFound(found);
        setVerbosity(v);
        setTimezone(tz);
        setBriefing(br);
        setTone(tn);
        setInstr(ins);
        initial.current = { verbosity: v, timezone: tz, briefing: br, tone: tn, instr: ins };
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

  const current: Snapshot = { verbosity, timezone, briefing, tone, instr };
  const dirty = initial.current !== null && JSON.stringify(current) !== JSON.stringify(initial.current);

  const discard = () => {
    const i = initial.current;
    if (!i) return;
    setVerbosity(i.verbosity);
    setTimezone(i.timezone);
    setBriefing(i.briefing);
    setTone(i.tone);
    setInstr(i.instr);
  };

  const save = async () => {
    setSaving(true);
    setErr(null);
    try {
      const body: Record<string, unknown> = {
        prefs: { verbosity, daily_briefing_enabled: briefing, ...(timezone ? { timezone } : {}) },
      };
      if (isAdmin && agencyFound) body.agency = { tone, custom_instructions: instr };
      const res = await fetch("/api/hub/sparkbot-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const d = await res.json().catch(() => ({}));
      if (d.ok) {
        initial.current = { verbosity, timezone, briefing, tone, instr };
        setSavedFlash(true);
        setTimeout(() => setSavedFlash(false), 2600);
      } else {
        setErr("Não consegui salvar. Tente de novo.");
      }
    } catch {
      setErr("Falha de rede ao salvar.");
    } finally {
      setSaving(false);
    }
  };

  const showAgency = isAdmin && agencyFound;
  const meta = META[cat];

  return (
    <div>
      {/* Header sticky — paridade com o detail-view dos agentes */}
      <div className="cfg-hdr">
        <Link href="/hub" className="btn btn--quiet btn--icon btn--sm" aria-label="Voltar para o início" title="Voltar para o início">
          <ChevronLeft />
        </Link>
        <div className="amark amark--primary amark--lg" aria-hidden>
          <Bot />
        </div>
        <div className="grow" style={{ minWidth: 0 }}>
          <h1 style={{ fontSize: 18, fontWeight: 600, letterSpacing: "-.01em", margin: 0 }}>Configurar SparkBot</h1>
          <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>
            O que o bot define sozinho na conversa também fica aqui — e os dois ficam sincronizados.
          </div>
        </div>
        <div className="row" style={{ gap: 8, flexShrink: 0 }}>
          {savedFlash && (
            <span className="pill pill--ok" style={{ height: 26 }}>
              <Check style={{ width: 13, height: 13 }} /> Salvo
            </span>
          )}
          <a href="/embed/sparkbot" className="btn btn--ghost btn--sm">
            <MessageSquare /> Abrir SparkBot
          </a>
        </div>
      </div>

      <div className="page" style={{ maxWidth: 1040 }}>
        {loading ? (
          <div className="empty">Carregando…</div>
        ) : (
          <div className="cfg-layout">
            {/* Rail de categorias */}
            <nav className="cfg-rail">
              <div>
                <div className="cfg-rail__group">Você</div>
                <RailItem id="prefs" label="Preferências" Icon={SlidersHorizontal} cat={cat} setCat={setCat} />
              </div>
              {showAgency && (
                <div>
                  <div className="cfg-rail__group">Agência</div>
                  <RailItem id="personality" label="Personalidade" Icon={Sparkles} cat={cat} setCat={setCat} />
                  <RailItem id="instructions" label="Instruções" Icon={FileText} cat={cat} setCat={setCat} />
                </div>
              )}
              {isAdmin && !agencyFound && (
                <div className="cfg-rail__group" style={{ color: "var(--ink-4)", fontWeight: 500, textTransform: "none", letterSpacing: 0, lineHeight: 1.4 }}>
                  Agente da agência não encontrado — só dá pra editar suas preferências.
                </div>
              )}
            </nav>

            {/* Painel */}
            <div className="cfg-panel">
              <div className="cfg-panel__hd">
                <div>
                  <div className="cfg-panel__title">{meta.title}</div>
                  <div className="cfg-panel__sub">{meta.sub}</div>
                </div>
              </div>

              {/* Se um cat de agência tá ativo mas não é admin/não achou agente, volta pra prefs */}
              {(cat === "personality" || cat === "instructions") && !showAgency ? (
                <div className="empty">Sem acesso a esta seção.</div>
              ) : cat === "prefs" ? (
                <>
                  <Field label="Tamanho das respostas" hint="O quanto o SparkBot escreve em cada mensagem.">
                    <Seg
                      value={verbosity}
                      options={[
                        { v: "brief", l: "Curtas" },
                        { v: "normal", l: "Equilibradas" },
                        { v: "detailed", l: "Detalhadas" },
                      ]}
                      onChange={setVerbosity}
                    />
                  </Field>
                  <Field label="Fuso horário" hint="Usado na agenda, lembretes e no resumo matinal.">
                    <select className="select" aria-label="Fuso horário" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
                      <option value="">Detectar automático</option>
                      {timezone && !TZ_OPTIONS.some((t) => t.id === timezone) && <option value={timezone}>{timezone}</option>}
                      {TZ_OPTIONS.map((t) => (
                        <option key={t.id} value={t.id}>
                          {t.label}
                        </option>
                      ))}
                    </select>
                  </Field>
                  <Toggle
                    label="Resumo matinal"
                    hint="Todo dia às 8h: sua agenda do dia + resumo de ontem."
                    checked={briefing}
                    onChange={() => setBriefing((b) => !b)}
                  />
                </>
              ) : cat === "personality" ? (
                <Field label="Personalidade" hint="Onde o SparkBot fica em cada eixo.">
                  <Sld label="Criatividade" left="Conservador" right="Criativo" value={tone.creativity} onChange={(v) => setTone((t) => ({ ...t, creativity: v }))} />
                  <Sld label="Formalidade" left="Casual" right="Formal" value={tone.formality} onChange={(v) => setTone((t) => ({ ...t, formality: v }))} />
                  <Sld label="Naturalidade" left="Robótico" right="Humano" value={tone.naturalness} onChange={(v) => setTone((t) => ({ ...t, naturalness: v }))} />
                  <Sld label="Assertividade" left="Tímido" right="Direto" value={tone.aggressiveness} onChange={(v) => setTone((t) => ({ ...t, aggressiveness: v }))} />
                </Field>
              ) : (
                <Field label="Instruções" hint="Como o SparkBot deve se comportar com a equipe — tom, regras da operação, o que priorizar.">
                  <textarea
                    className="textarea"
                    rows={9}
                    maxLength={8000}
                    value={instr}
                    onChange={(e) => setInstr(e.target.value)}
                    placeholder="Ex: Você é o assistente da Alves Cury Financial. Seja direto e prático, foque em ajudar o corretor a fechar mais vendas de seguro de vida. Sempre confirme dados do contato antes de agendar."
                  />
                </Field>
              )}

              {err && <div style={{ color: "var(--danger)", fontSize: 13, marginTop: 14 }}>{err}</div>}
            </div>
          </div>
        )}

        {dirty && (
          <div className="cfg-savebar">
            <span className="cfg-savebar__msg">
              <span className="cfg-savebar__dot" /> Você tem alterações não salvas
            </span>
            <div className="row" style={{ gap: 8 }}>
              <button className="btn btn--on-dark btn--sm" onClick={discard} disabled={saving}>
                Descartar
              </button>
              <button className="btn btn--primary btn--sm" onClick={save} disabled={saving}>
                <Check /> {saving ? "Salvando…" : "Salvar alterações"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ─── Helpers (espelham os do agent-detail-view) ──────────────────── */

function RailItem({
  id,
  label,
  Icon,
  cat,
  setCat,
}: {
  id: Cat;
  label: string;
  Icon: typeof Bot;
  cat: Cat;
  setCat: (c: Cat) => void;
}) {
  return (
    <button className="cfg-rail__item" aria-current={cat === id ? "true" : undefined} onClick={() => setCat(id)}>
      <Icon />
      <span>{label}</span>
    </button>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="fstack">
      <div className="fstack__head">
        <div className="fstack__lbl">{label}</div>
        <div className="fstack__hint">{hint || " "}</div>
      </div>
      <div className="fstack__ctrl">{children}</div>
    </div>
  );
}

function Sld({ label, left, right, value, onChange }: { label: string; left: string; right: string; value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <div className="row between" style={{ marginBottom: 5 }}>
        <span style={{ fontSize: 13, fontWeight: 500 }}>{label}</span>
        <span className="tnum" style={{ fontSize: 12, color: "var(--primary)", fontWeight: 600 }}>
          {value}
        </span>
      </div>
      <input className="slider" type="range" min={0} max={100} value={value} onChange={(ev) => onChange(Number(ev.target.value))} />
      <div className="row between" style={{ marginTop: 4, fontSize: 11, color: "var(--ink-4)" }}>
        <span>{left}</span>
        <span>{right}</span>
      </div>
    </div>
  );
}

function Seg<T extends string>({ value, options, onChange }: { value: T; options: { v: T; l: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={o.v} aria-pressed={value === o.v} onClick={() => onChange(o.v)}>
          {o.l}
        </button>
      ))}
    </div>
  );
}

function Toggle({ label, hint, checked, onChange }: { label: string; hint?: string; checked: boolean; onChange: () => void }) {
  return (
    <div className="row between" style={{ padding: "11px 0", borderBottom: "1px solid var(--line-faint)" }}>
      <div>
        <div style={{ fontSize: 13.5, fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{hint}</div>}
      </div>
      <button type="button" className="switch" role="switch" aria-checked={checked} aria-label={label} onClick={onChange} />
    </div>
  );
}
