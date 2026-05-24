/* eslint-disable @next/next/no-img-element */
"use client";

import { type CSSProperties } from "react";
import { ConfettiBurst } from "./components";
import { PIPELINE_STAGES, CONTACTS, CALENDAR_EVENTS, type Scene, type CalendarEvent, type PipelineStage, type Contact } from "./data";

export type CrmPhase = "idle" | "reacting" | "done";

// ============ CRM Panel — frames the active scene view ============
export function CrmPanel({ scenario, eventPhase }: { scenario: Scene; eventPhase: CrmPhase; sceneIndex?: number }) {
  const tabsByScene: Record<number, string> = { 1: "Agenda", 2: "Contatos", 3: "Conhecimento", 4: "Início" };
  const activeTab = tabsByScene[scenario.id];

  return (
    <div style={{
      width: "100%", height: "100%", borderRadius: 28, overflow: "hidden",
      background: "white", boxShadow: "var(--shadow-xl)", border: "1px solid var(--line)",
      display: "flex", flexDirection: "column", position: "relative",
    }}>
      {/* Window chrome — fake browser */}
      <div style={{ background: "#F4F8FB", borderBottom: "1px solid var(--line)", padding: "12px 16px", display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
        <div style={{ display: "flex", gap: 6 }}>
          <span style={{ width: 12, height: 12, borderRadius: 999, background: "#FF5F57" }} />
          <span style={{ width: 12, height: 12, borderRadius: 999, background: "#FEBC2E" }} />
          <span style={{ width: 12, height: 12, borderRadius: 999, background: "#28C840" }} />
        </div>
        <div style={{
          marginLeft: 14, flex: 1, background: "white", border: "1px solid var(--line)", borderRadius: 8,
          padding: "6px 14px", fontSize: 12, color: "var(--ink-3)",
          display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap", overflow: "hidden",
        }}>
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
            <path d="M12 2a7 7 0 0 1 7 7c0 1.5-.5 3-1.5 4.5L12 22l-5.5-8.5C5.5 12 5 10.5 5 9a7 7 0 0 1 7-7z" stroke="currentColor" strokeWidth="1.5" fill="none" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>app.sparkleads.pro/{activeTab.toLowerCase()}</span>
          <span style={{ marginLeft: "auto", color: "var(--success)", fontWeight: 700, flexShrink: 0 }}>● ao vivo</span>
        </div>
      </div>

      {/* App body — sidebar + main */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "76px 1fr", minHeight: 0 }}>
        <CrmSidebar active={activeTab} />
        <div style={{ position: "relative", minHeight: 0, overflow: "hidden" }}>
          {scenario.id === 1 && <CrmAgenda phase={eventPhase} />}
          {scenario.id === 2 && <CrmContact phase={eventPhase} />}
          {scenario.id === 3 && <CrmKnowledge phase={eventPhase} />}
          {scenario.id === 4 && <CrmProactive phase={eventPhase} />}
        </div>
      </div>
    </div>
  );
}

function CrmSidebar({ active }: { active: string }) {
  const items = [
    { key: "Início", icon: "home" },
    { key: "Contatos", icon: "users" },
    { key: "Agenda", icon: "calendar" },
    { key: "Conhecimento", icon: "book" },
    { key: "Mensagens", icon: "chat" },
  ];
  return (
    <div style={{ background: "#F8FBFD", borderRight: "1px solid var(--line)", padding: "20px 0", display: "flex", flexDirection: "column", alignItems: "center", gap: 10 }}>
      <div style={{ width: 48, height: 48, borderRadius: 14, background: "var(--brand)", display: "grid", placeItems: "center", marginBottom: 14 }}>
        <img src="/demo/assets/logo-k-light.png" alt="" style={{ width: 44, height: 44, borderRadius: 14 }} />
      </div>
      {items.map((it) => (
        <button key={it.key} title={it.key} style={{
          width: 56, height: 56, borderRadius: 14,
          background: it.key === active ? "var(--brand-tint)" : "transparent",
          color: it.key === active ? "var(--brand-darker)" : "var(--ink-3)",
          border: 0, cursor: "pointer", display: "grid", placeItems: "center", position: "relative", fontFamily: "inherit",
        }}>
          <SidebarIcon icon={it.icon} />
          {it.key === active && (
            <span style={{ position: "absolute", left: -8, top: "50%", transform: "translateY(-50%)", width: 4, height: 28, borderRadius: 4, background: "var(--brand)" }} />
          )}
        </button>
      ))}
    </div>
  );
}

function SidebarIcon({ icon }: { icon: string }) {
  const s = "currentColor";
  const w = 22;
  switch (icon) {
    case "home": return <svg width={w} height={w} viewBox="0 0 24 24" fill="none"><path d="M3 11l9-8 9 8v9a2 2 0 0 1-2 2h-4v-7H9v7H5a2 2 0 0 1-2-2v-9z" stroke={s} strokeWidth="2" strokeLinejoin="round" /></svg>;
    case "users": return <svg width={w} height={w} viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3.5" stroke={s} strokeWidth="2" /><path d="M3 20c0-3 2.5-5 6-5s6 2 6 5" stroke={s} strokeWidth="2" strokeLinecap="round" /><circle cx="17" cy="9" r="2.5" stroke={s} strokeWidth="2" /><path d="M21 17c0-1.8-1.5-3-3.5-3" stroke={s} strokeWidth="2" strokeLinecap="round" /></svg>;
    case "calendar": return <svg width={w} height={w} viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="16" rx="2" stroke={s} strokeWidth="2" /><path d="M3 10h18M8 3v4M16 3v4" stroke={s} strokeWidth="2" strokeLinecap="round" /></svg>;
    case "book": return <svg width={w} height={w} viewBox="0 0 24 24" fill="none"><path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2V5z" stroke={s} strokeWidth="2" /><path d="M20 19v2H6a2 2 0 0 1 0-4h14" stroke={s} strokeWidth="2" /></svg>;
    case "chat": return <svg width={w} height={w} viewBox="0 0 24 24" fill="none"><path d="M21 12a8 8 0 0 1-12.5 6.7L3 20l1.3-5.5A8 8 0 1 1 21 12z" stroke={s} strokeWidth="2" strokeLinejoin="round" /></svg>;
    default: return null;
  }
}

/* ============ CENA 1 — Agenda / Calendário ============ */
function CrmAgenda({ phase }: { phase: CrmPhase }) {
  const days = ["Seg 2", "Ter 3", "Qua 4", "Qui 5", "Sex 6"];
  const hours = [9, 10, 11, 12, 13, 14, 15, 16, 17];
  const newEvent: CalendarEvent = { id: "new", day: 2, start: 15, end: 16, title: "João Silva — Renovação", type: "meeting", isNew: true };

  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "20px 24px 16px", display: "flex", alignItems: "center", gap: 16, borderBottom: "1px solid var(--line)" }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Agenda</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "var(--ink)", letterSpacing: "-0.02em" }}>Esta semana</div>
        </div>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: 8 }}>
          <button style={pillBtnStyle()}>‹</button>
          <button style={pillBtnStyle(true)}>Hoje</button>
          <button style={pillBtnStyle()}>›</button>
        </div>
      </div>

      <div style={{
        flex: 1, padding: "12px 18px 18px", display: "grid",
        gridTemplateColumns: "56px repeat(5, 1fr)", gridTemplateRows: "auto 1fr", gap: 0, minHeight: 0,
      }}>
        <div />
        {days.map((d, i) => (
          <div key={i} style={{ padding: "12px 8px", textAlign: "center", fontSize: 14, fontWeight: 700, color: "var(--ink-2)", borderBottom: "2px solid var(--line)" }}>
            <div style={{ fontSize: 12, color: "var(--ink-3)", letterSpacing: "0.06em", textTransform: "uppercase", fontWeight: 700 }}>{d.split(" ")[0]}</div>
            <div style={{
              display: "inline-grid", placeItems: "center", width: 32, height: 32, borderRadius: 999,
              background: i === 1 ? "var(--brand)" : "transparent", color: i === 1 ? "white" : "var(--ink)",
              fontSize: 16, marginTop: 4, fontWeight: 800,
            }}>{d.split(" ")[1]}</div>
          </div>
        ))}

        <div style={{ gridColumn: "1 / -1", display: "grid", gridTemplateColumns: "56px repeat(5, 1fr)", position: "relative", minHeight: 0, overflow: "auto" }}>
          <div>
            {hours.map((h) => (
              <div key={h} style={{ height: 64, fontSize: 13, color: "var(--ink-3)", fontWeight: 700, textAlign: "right", paddingRight: 10, paddingTop: 6, borderTop: "1px solid var(--line-2)" }}>
                {h}:00
              </div>
            ))}
          </div>
          {days.map((_, dayIdx) => (
            <div key={dayIdx} style={{ position: "relative", borderLeft: "1px solid var(--line-2)" }}>
              {hours.map((h) => <div key={h} style={{ height: 64, borderTop: "1px solid var(--line-2)" }} />)}
              {CALENDAR_EVENTS.filter((e) => e.day - 1 === dayIdx).map((e) => (
                <CalEvent key={e.id} ev={e} startHour={hours[0]} />
              ))}
              {newEvent.day - 1 === dayIdx && phase !== "idle" && (
                <CalEvent ev={newEvent} startHour={hours[0]} highlight />
              )}
            </div>
          ))}
        </div>
      </div>

      {phase === "done" && <ConfettiBurst x="52%" y="58%" count={28} />}
    </div>
  );
}

function CalEvent({ ev, startHour, highlight = false }: { ev: CalendarEvent; startHour: number; highlight?: boolean }) {
  const top = (ev.start - startHour) * 64 + 2;
  const h = (ev.end - ev.start) * 64 - 4;
  const colors: Record<string, { bg: string; border: string; text: string }> = {
    meeting: { bg: "#E6F7FC", border: "#0FB5E1", text: "#0B6E8A" },
    call: { bg: "#FFF4E5", border: "#FF8A3D", text: "#8C4A1F" },
    task: { bg: "#F0EBFF", border: "#8B5CF6", text: "#5B3FB5" },
    internal: { bg: "#F3F7FA", border: "#5C6B78", text: "#243341" },
  };
  const c = colors[ev.type] || colors.meeting;

  if (highlight) {
    return (
      <div style={{
        position: "absolute", left: 4, right: 4, top, height: h, borderRadius: 10,
        background: "var(--brand-gradient)", color: "white", padding: "10px 12px",
        boxShadow: "0 10px 24px rgba(15,181,225,0.45), 0 0 0 2px white",
        animation: "pop-in 0.6s cubic-bezier(0.22,1,0.36,1), glow-ring 2s ease-in-out 0.6s 2",
        overflow: "hidden", zIndex: 5,
      }}>
        <div style={{ fontSize: 12, fontWeight: 800, opacity: 0.9, display: "flex", alignItems: "center", gap: 4, letterSpacing: "0.06em" }}>
          <span>✨ NOVO</span>
        </div>
        <div style={{ fontSize: 14, fontWeight: 800, lineHeight: 1.2, marginTop: 3 }}>{ev.title}</div>
        <div style={{ fontSize: 12, opacity: 0.95, marginTop: 2, fontWeight: 600 }}>{ev.start}:00 — {ev.end}:00</div>
      </div>
    );
  }

  return (
    <div style={{ position: "absolute", left: 4, right: 4, top, height: h, borderRadius: 8, background: c.bg, borderLeft: `3px solid ${c.border}`, color: c.text, padding: "8px 10px", overflow: "hidden" }}>
      <div style={{ fontSize: 13, fontWeight: 700, lineHeight: 1.2, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ev.title}</div>
      <div style={{ fontSize: 11, opacity: 0.8, marginTop: 2 }}>{ev.start}:00</div>
    </div>
  );
}

function pillBtnStyle(primary = false): CSSProperties {
  return {
    padding: "8px 14px", background: primary ? "var(--ink)" : "white",
    color: primary ? "white" : "var(--ink-2)", border: primary ? 0 : "1px solid var(--line)",
    borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit",
  };
}

/* ============ CENA 2 — Ficha contato + Pipeline kanban ============ */
function CrmContact({ phase }: { phase: CrmPhase }) {
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 14 }}>
        <div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Contatos · Funil</div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Pipeline ativo</div>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ padding: "6px 12px", background: "var(--brand-tint)", color: "var(--brand-darker)", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{CONTACTS.length} leads</span>
      </div>

      <div style={{ flex: 1, padding: "14px 14px 0", display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 8, minHeight: 0, overflow: "hidden" }}>
        {PIPELINE_STAGES.map((stage) => <PipelineColumn key={stage.key} stage={stage} phase={phase} />)}
      </div>

      <ContactDetailStrip phase={phase} />
    </div>
  );
}

function PipelineColumn({ stage, phase }: { stage: PipelineStage; phase: CrmPhase }) {
  const isJoaoOrigin = stage.key === "proposta";
  const isJoaoDest = stage.key === "consider";

  const leads = CONTACTS.filter((c) => {
    if (c.id === "joao") return phase === "idle" ? stage.key === "proposta" : stage.key === "consider";
    return c.stage === stage.key;
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ width: 10, height: 10, borderRadius: 999, background: stage.color }} />
          <span style={{ flex: 1, fontSize: 13, fontWeight: 800, color: "var(--ink-2)", letterSpacing: "0.02em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{stage.label}</span>
          <span style={{ background: "var(--bg)", padding: "2px 8px", borderRadius: 999, fontSize: 12, color: "var(--ink-3)", fontWeight: 700, border: "1px solid var(--line)" }}>{leads.length}</span>
        </div>
      </div>
      <div style={{ flex: 1, background: "#F8FBFD", borderRadius: 10, padding: 8, display: "flex", flexDirection: "column", gap: 8, border: "1px dashed var(--line)", position: "relative", overflow: "hidden" }}>
        {phase !== "idle" && isJoaoOrigin && (
          <div style={{ position: "absolute", inset: 8, borderRadius: 8, border: "2px dashed var(--ink-4)", opacity: 0.4, pointerEvents: "none" }} />
        )}
        {phase !== "idle" && isJoaoDest && (
          <div style={{ position: "absolute", inset: -2, borderRadius: 12, boxShadow: "0 0 0 3px var(--brand)", animation: "glow-ring 2s ease-in-out", pointerEvents: "none" }} />
        )}
        {leads.map((c) => <LeadCard key={c.id} contact={c} isMoved={c.id === "joao" && phase !== "idle"} />)}
      </div>
    </div>
  );
}

function LeadCard({ contact, isMoved }: { contact: Contact; isMoved: boolean }) {
  return (
    <div style={{
      background: "white", borderRadius: 10, padding: 10,
      boxShadow: isMoved ? "0 8px 20px rgba(15,181,225,0.35), 0 0 0 2px var(--brand)" : "var(--shadow-sm)",
      animation: isMoved ? "pop-in 0.5s cubic-bezier(0.22,1,0.36,1)" : "none", position: "relative",
    }}>
      {isMoved && (
        <div style={{ position: "absolute", top: -8, right: -6, background: "var(--brand)", color: "white", padding: "3px 8px", borderRadius: 999, fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", boxShadow: "0 4px 10px rgba(15,181,225,0.4)" }}>movido</div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
        <div style={{ width: 26, height: 26, borderRadius: "50%", background: "var(--brand-gradient)", color: "white", fontSize: 10, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0 }}>{contact.initials}</div>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 13, fontWeight: 700, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{contact.name}</div>
        </div>
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, gap: 6 }}>
        <span style={{ color: "var(--ink-3)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{contact.tag}</span>
        <span style={{ color: "var(--success)", fontWeight: 800, whiteSpace: "nowrap", flexShrink: 0 }}>{contact.value}</span>
      </div>
    </div>
  );
}

function ContactDetailStrip({ phase }: { phase: CrmPhase }) {
  return (
    <div style={{ borderTop: "1px solid var(--line)", background: "#F8FBFD", padding: "14px 18px", display: "flex", alignItems: "center", gap: 16 }}>
      <div style={{ width: 48, height: 48, borderRadius: "50%", background: "var(--brand-gradient)", color: "white", fontWeight: 800, fontSize: 16, display: "grid", placeItems: "center", flexShrink: 0 }}>JS</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)" }}>João Silva · Ficha do contato</div>
        <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>{phase === "idle" ? "Aguardando atualização…" : "Última atividade: agora"}</div>
      </div>
      {phase !== "idle" && (
        <div style={{ maxWidth: 360, background: "white", border: "1px solid var(--brand)", borderRadius: 12, padding: "10px 14px", animation: "slide-right 0.5s cubic-bezier(0.22,1,0.36,1)", boxShadow: "0 8px 20px rgba(15,181,225,0.20)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 800, color: "var(--brand-darker)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 4 }}>
            <span>✨ Nova anotação · via SparkBot</span>
          </div>
          <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}>
            &ldquo;Quer pensar até semana que vem. Follow-up sexta, 10h.&rdquo;
          </div>
        </div>
      )}
    </div>
  );
}

/* ============ CENA 3 — Conhecimento (resposta de especialista) ============ */
function CrmKnowledge({ phase }: { phase: CrmPhase }) {
  const options = [
    { tag: "Recomendação principal", title: "Seguradora Prudential — Vida Mais Saúde", body: "Aceita pré-existência com agravo, sem carência longa. Indicada pra perfis 35-55 controlados.", badge: "★ 92% match", color: "#1DB954" },
    { tag: "Alternativa custo-benefício", title: "MetLife Vida Inteligente", body: "Capital de R$ 200-500k, exame médico simplificado pra DM2 estável < 5 anos.", badge: "Custo médio", color: "#0FB5E1" },
    { tag: "Se quiser cobertura ampla", title: "Bradesco Vida + Doenças Graves", body: "Inclui cobertura adicional pra complicações cardiovasculares — relevante pro perfil.", badge: "Cobertura+", color: "#FF8A3D" },
  ];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--line)" }}>
        <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Conhecimento · Base interna</div>
        <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Consulta de especialista</div>
      </div>

      <div style={{ flex: 1, padding: 22, overflow: "auto", minHeight: 0 }}>
        {phase === "idle" ? (
          <div style={{ height: "100%", minHeight: 380, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 18, padding: 40, background: "var(--brand-tint-2)", border: "2px dashed #BCE6F2", borderRadius: 18, textAlign: "center" }}>
            <div style={{ width: 64, height: 64, borderRadius: 18, background: "white", border: "1px solid var(--line)", display: "grid", placeItems: "center", boxShadow: "var(--shadow-sm)" }}>
              <svg width="30" height="30" viewBox="0 0 24 24" fill="none">
                <circle cx="11" cy="11" r="7" stroke="var(--brand-darker)" strokeWidth="2" />
                <path d="M16 16l5 5" stroke="var(--brand-darker)" strokeWidth="2" strokeLinecap="round" />
              </svg>
            </div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 800, color: "var(--ink)" }}>Base de conhecimento pronta</div>
              <div style={{ fontSize: 14, color: "var(--ink-3)", marginTop: 6, maxWidth: 360 }}>Faça uma pergunta técnica por áudio e o SparkBot responde com fontes oficiais do mercado.</div>
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", justifyContent: "center", marginTop: 4 }}>
              {["Doenças pré-existentes", "Capital recomendado", "Comparativos", "SUSEP"].map((t) => (
                <span key={t} style={{ padding: "6px 12px", background: "white", border: "1px solid var(--line)", borderRadius: 999, fontSize: 12, color: "var(--ink-3)", fontWeight: 700 }}>{t}</span>
              ))}
            </div>
          </div>
        ) : (
          <>
            <div style={{ background: "var(--brand-tint)", border: "1px solid #BCE6F2", borderRadius: 14, padding: "14px 18px", marginBottom: 16, display: "flex", gap: 12, alignItems: "flex-start", animation: "slide-up 0.4s ease-out" }}>
              <div style={{ width: 32, height: 32, borderRadius: 999, background: "var(--brand)", color: "white", display: "grid", placeItems: "center", flexShrink: 0, fontSize: 14, fontWeight: 800 }}>?</div>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, color: "var(--brand-darker)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 2 }}>Pergunta do agente</div>
                <div style={{ fontSize: 15, fontWeight: 600, color: "var(--ink)", lineHeight: 1.4 }}>
                  &ldquo;Cliente diabético tipo 2, 47 anos — qual a melhor opção de seguro de vida?&rdquo;
                </div>
              </div>
            </div>

            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {options.map((opt, i) => (
                <div key={i} style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 14, display: "flex", gap: 12, animation: `slide-up 0.5s cubic-bezier(0.22,1,0.36,1) ${i * 0.18 + 0.2}s both` }}>
                  <div style={{ width: 6, alignSelf: "stretch", borderRadius: 999, background: opt.color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                      <span style={{ fontSize: 10, fontWeight: 800, color: opt.color, letterSpacing: "0.08em", textTransform: "uppercase" }}>{opt.tag}</span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "var(--ink-3)", background: "var(--bg)", padding: "2px 8px", borderRadius: 999 }}>{opt.badge}</span>
                    </div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)", marginBottom: 4 }}>{opt.title}</div>
                    <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}>{opt.body}</div>
                  </div>
                </div>
              ))}
            </div>

            {phase === "done" && (
              <div style={{ marginTop: 14, padding: "10px 14px", background: "var(--bg)", borderRadius: 10, fontSize: 11, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 8, animation: "slide-up 0.4s ease-out" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M4 5a2 2 0 0 1 2-2h14v16H6a2 2 0 0 0-2 2V5z" stroke="currentColor" strokeWidth="1.8" /></svg>
                <span>Fontes: Base interna SparkLeads · Manual SUSEP · Tabela atuarial 2026</span>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/* ============ CENA 4 — Proativo (notificação espontânea) ============ */
function CrmProactive({ phase }: { phase: CrmPhase }) {
  const showAlert = phase !== "idle";
  const kpis = [
    { label: "Leads ativos", value: "47", trend: "+5 esta semana", color: "#0FB5E1" },
    { label: "Reuniões hoje", value: "6", trend: "2 confirmadas", color: "#1DB954" },
    { label: "Em risco", value: "3", trend: "SparkBot agindo", color: "#FF8A3D" },
  ];
  const feed = [
    { icon: "🤖", text: "SparkBot enviou follow-up pra Maria Oliveira", time: "agora", brand: true, anim: showAlert },
    { icon: "📅", text: "Nova reunião: João Silva, terça 15h", time: "há 4 min", brand: false, anim: false },
    { icon: "📝", text: "Ficha do João atualizada (etapa: Em consideração)", time: "há 5 min", brand: false, anim: false },
    { icon: "💬", text: "Carlos Mendes respondeu no WhatsApp", time: "há 1h", brand: false, anim: false },
  ];
  return (
    <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
      <div style={{ padding: "20px 24px 16px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 14 }}>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase", whiteSpace: "nowrap" }}>Painel do agente</div>
          <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em", whiteSpace: "nowrap" }}>Hoje, terça-feira</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--success)", fontSize: 12, fontWeight: 800, background: "var(--success-tint)", padding: "8px 12px", borderRadius: 999, whiteSpace: "nowrap", flexShrink: 0 }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: "var(--success)", animation: "pulse 1.6s ease-in-out infinite" }} />
          SparkBot ativo
        </div>
      </div>

      <div style={{ flex: 1, padding: "16px 20px", display: "flex", flexDirection: "column", gap: 12, overflow: "auto", minHeight: 0 }}>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 10 }}>
          {kpis.map((kpi, i) => (
            <div key={i} style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "var(--ink-3)", letterSpacing: "0.04em", textTransform: "uppercase" }}>{kpi.label}</div>
              <div style={{ fontSize: 28, fontWeight: 800, color: kpi.color, marginTop: 4, letterSpacing: "-0.02em" }}>{kpi.value}</div>
              <div style={{ fontSize: 11, color: "var(--ink-3)", marginTop: 2 }}>{kpi.trend}</div>
            </div>
          ))}
        </div>

        {showAlert && (
          <div style={{ background: "linear-gradient(135deg, #FFFAF0 0%, #FFF4E5 100%)", border: "2px solid #FF8A3D", borderRadius: 16, padding: 16, animation: "pop-in 0.6s cubic-bezier(0.22,1,0.36,1)", position: "relative" }}>
            <div style={{ position: "absolute", top: -10, left: 16, background: "var(--brand-gradient)", color: "white", padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", boxShadow: "0 6px 14px rgba(15,181,225,0.4)", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ width: 6, height: 6, borderRadius: 999, background: "white", animation: "pulse 1.4s ease-in-out infinite" }} />
              SparkBot agiu sozinho
            </div>
            <div style={{ display: "flex", gap: 14, marginTop: 8 }}>
              <div style={{ width: 44, height: 44, borderRadius: 12, background: "#FF8A3D", color: "white", display: "grid", placeItems: "center", fontSize: 22, flexShrink: 0 }}>❄</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "var(--ink)" }}>Maria Oliveira esfriou</div>
                <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 2 }}>Sem resposta há 7 dias · Follow-up venceu ontem</div>
              </div>
            </div>
            <div style={{ marginTop: 12, padding: "12px 14px", background: "white", borderRadius: 10, border: "1px solid var(--line)", fontSize: 13, color: "var(--ink-2)", lineHeight: 1.45 }}>
              <div style={{ fontSize: 10, fontWeight: 800, color: "var(--success)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 6 }}>✓ Follow-up enviado às 09:42</div>
              <span style={{ fontStyle: "italic" }}>&ldquo;Oi Maria, tudo bem? Lembrando da nossa conversa sobre o seguro pra família. Topa retomar essa semana?&rdquo;</span>
            </div>
          </div>
        )}

        <div style={{ background: "white", border: "1px solid var(--line)", borderRadius: 14, overflow: "hidden" }}>
          <div style={{ padding: "12px 16px", fontSize: 11, fontWeight: 800, color: "var(--ink-3)", letterSpacing: "0.08em", textTransform: "uppercase", borderBottom: "1px solid var(--line)" }}>Atividade recente</div>
          <div style={{ padding: "8px 0" }}>
            {feed.map((it, i) => (
              <div key={i} style={{ padding: "10px 16px", display: "flex", alignItems: "center", gap: 12, borderTop: i > 0 ? "1px solid var(--line-2)" : "none", animation: it.anim ? "slide-right 0.5s cubic-bezier(0.22,1,0.36,1)" : "none", background: it.brand && it.anim ? "var(--brand-tint)" : "transparent" }}>
                <span style={{ fontSize: 20 }}>{it.icon}</span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, color: "var(--ink-2)", fontWeight: it.brand ? 700 : 500 }}>{it.text}</div>
                </div>
                <span style={{ fontSize: 11, color: "var(--ink-3)", fontWeight: 600 }}>{it.time}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
