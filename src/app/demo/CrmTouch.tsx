"use client";

/**
 * Cenas de TOQUE do Ato 1 (refactor 2026-06-11) — a pessoa opera o CRM mock:
 *  - CrmFunnelTouch: arrasta o card do João no kanban (fallback: toque pega/solta).
 *  - CrmContactsTouch: abre a ficha da Maria (conversa WhatsApp + notas + follow-up vencido).
 * Atenção drag: o palco do quiosque usa transform:scale() — coordenadas de pointer
 * são convertidas dividindo pela escala (rect.width / offsetWidth). O hit-test das
 * colunas usa getBoundingClientRect puro (espaço de tela), que é scale-agnóstico.
 */
import { useRef, useState, type CSSProperties } from "react";
import { CrmFrame } from "./CrmPanel";
import { ConfettiBurst } from "./components";
import { PIPELINE_STAGES, CONTACTS, MARIA_THREAD, MARIA_NOTES, type Contact } from "./data";

// ============ Coach strip (instrução → sucesso) ============
function CoachStrip({ done, text, doneText }: { done: boolean; text: string; doneText: string }) {
  return (
    <div style={{
      padding: "12px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 12,
      background: done ? "var(--success-tint)" : "var(--brand-tint)", flexShrink: 0, transition: "background 0.3s",
    }}>
      <span style={{
        width: 32, height: 32, borderRadius: 999, flexShrink: 0, display: "grid", placeItems: "center",
        background: done ? "var(--success)" : "var(--brand)", color: "white",
        animation: done ? "pop-in 0.4s ease-out" : "glow-ring 2s ease-in-out infinite",
      }}>
        {done ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 12l5 5L20 7" stroke="white" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" /></svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M9 11.5V5a1.5 1.5 0 0 1 3 0v5l4.5 1c1 .25 1.6 1.2 1.4 2.2l-.8 4.1a2 2 0 0 1-2 1.7H10a2 2 0 0 1-1.5-.7L5 14.5a1.4 1.4 0 0 1 2-2l2 1.8z" stroke="white" strokeWidth="1.8" strokeLinejoin="round" /></svg>
        )}
      </span>
      <span key={done ? "done" : "task"} style={{ fontSize: 16, fontWeight: 700, color: done ? "#14803C" : "var(--brand-darker)", animation: "slide-right 0.35s ease-out" }}>
        {done ? doneText : text}
      </span>
    </div>
  );
}

/* ============================================================================
   CENA 1 — Funil por toque (kanban com drag)
   ========================================================================== */
export function CrmFunnelTouch({ done, coach, successLabel, onSuccess, userName }: {
  done: boolean; coach: string; successLabel: string; onSuccess: () => void; userName?: string | null;
}) {
  const [joaoStage, setJoaoStage] = useState<"contato" | "proposta">(done ? "proposta" : "contato");
  const [dragPos, setDragPos] = useState<{ x: number; y: number } | null>(null);
  const [lifted, setLifted] = useState(false);
  const [missedStage, setMissedStage] = useState<string | null>(null);
  const [burst, setBurst] = useState(false);

  const boardRef = useRef<HTMLDivElement>(null);
  const colRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const gestureRef = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const missTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const joao = CONTACTS.find((c) => c.id === "joao")!;
  const dragging = dragPos !== null;

  const toBoardCoords = (cx: number, cy: number) => {
    const board = boardRef.current;
    if (!board) return { x: 0, y: 0 };
    const rect = board.getBoundingClientRect();
    const scale = rect.width / board.offsetWidth || 1;
    return { x: (cx - rect.left) / scale, y: (cy - rect.top) / scale };
  };

  const hitStage = (cx: number, cy: number): string | null => {
    for (const s of PIPELINE_STAGES) {
      const el = colRefs.current[s.key];
      if (!el) continue;
      const r = el.getBoundingClientRect();
      if (cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom) return s.key;
    }
    return null;
  };

  const succeed = () => {
    setJoaoStage("proposta");
    setLifted(false);
    setBurst(true);
    onSuccess();
  };

  const miss = (stage: string | null) => {
    setLifted(false);
    if (stage && stage !== "proposta") {
      setMissedStage(stage);
      if (missTimerRef.current) clearTimeout(missTimerRef.current);
      missTimerRef.current = setTimeout(() => setMissedStage(null), 600);
    }
  };

  const onCardPointerDown = (e: React.PointerEvent) => {
    if (done || joaoStage === "proposta") return;
    try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId); } catch { /* pointer já encerrado — segue sem capture */ }
    gestureRef.current = { x: e.clientX, y: e.clientY, moved: false };
  };
  const onCardPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (!g) return;
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) < 10) return;
    g.moved = true;
    setDragPos(toBoardCoords(e.clientX, e.clientY));
  };
  const onCardPointerUp = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    gestureRef.current = null;
    setDragPos(null);
    if (!g) return;
    if (g.moved) {
      const stage = hitStage(e.clientX, e.clientY);
      if (stage === "proposta") succeed();
      else miss(stage);
    } else {
      // Toque simples: modo pega-e-solta (fallback do drag pra quem só toca)
      setLifted((v) => !v);
    }
  };

  const onColumnTap = (stageKey: string) => {
    if (!lifted || done) return;
    if (stageKey === "proposta") succeed();
    else miss(stageKey);
  };

  return (
    <CrmFrame activeTab="Contatos" userName={userName}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 24px 12px", display: "flex", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Contatos · Funil</div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Pipeline ativo</div>
          </div>
          <div style={{ flex: 1 }} />
          <span style={{ padding: "6px 12px", background: "var(--brand-tint)", color: "var(--brand-darker)", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{CONTACTS.length} leads · R$ 836.000 no funil</span>
        </div>

        <CoachStrip done={done} text={lifted ? "Boa! Agora toca na coluna Proposta pra soltar o João 👇" : `👆 ${coach}`} doneText={successLabel} />

        <div ref={boardRef} style={{ flex: 1, padding: 14, display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))", gap: 10, minHeight: 0, position: "relative" }}>
          {PIPELINE_STAGES.map((stage) => {
            const leads = CONTACTS.filter((c) => (c.id === "joao" ? joaoStage === stage.key : c.stage === stage.key));
            const isTarget = stage.key === "proposta";
            const highlightTarget = (dragging || lifted) && isTarget && !done;
            return (
              <div
                key={stage.key}
                ref={(el) => { colRefs.current[stage.key] = el; }}
                onClick={() => onColumnTap(stage.key)}
                style={{ display: "flex", flexDirection: "column", minHeight: 0, animation: missedStage === stage.key ? "shake-x 0.5s ease-in-out" : "none" }}
              >
                <div style={{ marginBottom: 10 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <span style={{ width: 10, height: 10, borderRadius: 999, background: stage.color }} />
                    <span style={{ flex: 1, fontSize: 13, fontWeight: 800, color: "var(--ink-2)", letterSpacing: "0.02em", textTransform: "uppercase", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{stage.label}</span>
                    <span style={{ background: "var(--bg)", padding: "2px 8px", borderRadius: 999, fontSize: 12, color: "var(--ink-3)", fontWeight: 700, border: "1px solid var(--line)" }}>{leads.length}</span>
                  </div>
                </div>
                <div style={{
                  flex: 1, background: highlightTarget ? "var(--brand-tint-2)" : "#F8FBFD", borderRadius: 10, padding: 8,
                  display: "flex", flexDirection: "column", gap: 8, position: "relative", overflow: "hidden",
                  border: highlightTarget ? "2px dashed var(--brand)" : "1px dashed var(--line)",
                  boxShadow: highlightTarget ? "0 0 0 3px rgba(15,181,225,0.25)" : "none",
                  transition: "all 0.25s",
                }}>
                  {highlightTarget && (
                    <div style={{ position: "absolute", left: "50%", bottom: 14, transform: "translateX(-50%)", padding: "6px 14px", background: "var(--brand)", color: "white", borderRadius: 999, fontSize: 12, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", whiteSpace: "nowrap", animation: "float-y 1.6s ease-in-out infinite", zIndex: 3 }}>
                      Solta aqui
                    </div>
                  )}
                  {leads.map((c) => {
                    const isJoao = c.id === "joao";
                    return (
                      <TouchLeadCard
                        key={c.id}
                        contact={c}
                        moved={isJoao && joaoStage === "proposta"}
                        draggable={isJoao && joaoStage === "contato" && !done}
                        ghosted={isJoao && dragging}
                        lifted={isJoao && lifted}
                        onPointerDown={isJoao ? onCardPointerDown : undefined}
                        onPointerMove={isJoao ? onCardPointerMove : undefined}
                        onPointerUp={isJoao ? onCardPointerUp : undefined}
                      />
                    );
                  })}
                  {burst && isTarget && <ConfettiBurst x="50%" y="36%" count={26} />}
                </div>
              </div>
            );
          })}

          {/* Ghost que segue o dedo durante o drag */}
          {dragging && (
            <div style={{
              position: "absolute", left: dragPos.x, top: dragPos.y, width: 210,
              transform: "translate(-50%, -65%) rotate(3deg)", pointerEvents: "none", zIndex: 60,
            }}>
              <CardInner contact={joao} style={{ boxShadow: "0 24px 48px rgba(10,22,32,0.30), 0 0 0 2px var(--brand)", background: "white", borderRadius: 10, padding: 10 }} />
            </div>
          )}
        </div>
      </div>
    </CrmFrame>
  );
}

function TouchLeadCard({ contact, moved, draggable, ghosted, lifted, onPointerDown, onPointerMove, onPointerUp }: {
  contact: Contact; moved: boolean; draggable: boolean; ghosted: boolean; lifted: boolean;
  onPointerDown?: (e: React.PointerEvent) => void;
  onPointerMove?: (e: React.PointerEvent) => void;
  onPointerUp?: (e: React.PointerEvent) => void;
}) {
  return (
    <div
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{
        background: "white", borderRadius: 10, padding: 10, position: "relative",
        boxShadow: moved || lifted ? "0 8px 20px rgba(15,181,225,0.35), 0 0 0 2px var(--brand)" : "var(--shadow-sm)",
        animation: moved ? "pop-in 0.5s cubic-bezier(0.22,1,0.36,1)" : draggable && !ghosted && !lifted ? "glow-ring 2.2s ease-in-out infinite" : "none",
        opacity: ghosted ? 0.3 : 1,
        transform: lifted ? "translateY(-6px) scale(1.04)" : "none",
        cursor: draggable ? "grab" : "default",
        touchAction: draggable ? "none" : "auto",
        transition: "transform 0.2s, opacity 0.2s",
        userSelect: "none",
      }}
    >
      {moved && (
        <div style={{ position: "absolute", top: -8, right: -6, background: "var(--brand)", color: "white", padding: "3px 8px", borderRadius: 999, fontSize: 10, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", boxShadow: "0 4px 10px rgba(15,181,225,0.4)", zIndex: 2 }}>movido</div>
      )}
      {draggable && !ghosted && !lifted && (
        <div style={{ position: "absolute", top: -12, left: "50%", transform: "translateX(-50%)", background: "var(--ink)", color: "white", padding: "4px 10px", borderRadius: 999, fontSize: 10, fontWeight: 800, whiteSpace: "nowrap", animation: "float-y 1.8s ease-in-out infinite", zIndex: 2 }}>
        arrasta 👋
        </div>
      )}
      <CardInner contact={contact} />
    </div>
  );
}

function CardInner({ contact, style }: { contact: Contact; style?: CSSProperties }) {
  return (
    <div style={style}>
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

/* ============================================================================
   CENA 2 — Lista de contatos + ficha da Maria (conversa WhatsApp dentro do CRM)
   ========================================================================== */
export function CrmContactsTouch({ done, coach, successLabel, onOpened, userName }: {
  done: boolean; coach: string; successLabel: string; onOpened: () => void; userName?: string | null;
}) {
  const [open, setOpen] = useState(done);

  const openMaria = () => {
    setOpen(true);
    if (!done) onOpened();
  };

  return (
    <CrmFrame activeTab="Contatos" userName={userName}>
      <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "16px 24px 12px", display: "flex", alignItems: "center", gap: 16 }}>
          <div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", fontWeight: 700, letterSpacing: "0.1em", textTransform: "uppercase" }}>Contatos · Lista</div>
            <div style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Seus contatos</div>
          </div>
          <div style={{ flex: 1 }} />
          <span style={{ padding: "6px 12px", background: "var(--brand-tint)", color: "var(--brand-darker)", borderRadius: 999, fontSize: 12, fontWeight: 700 }}>{CONTACTS.length} contatos · sincronizados com WhatsApp</span>
        </div>

        <CoachStrip done={open} text={`👆 ${coach}`} doneText={successLabel} />

        <div style={{ flex: 1, position: "relative", minHeight: 0 }}>
          {/* Lista */}
          <div style={{ position: "absolute", inset: 0, overflow: "auto", padding: "10px 16px 16px" }}>
            {CONTACTS.map((c) => {
              const isMaria = c.id === "maria";
              const stage = PIPELINE_STAGES.find((s) => s.key === c.stage);
              return (
                <div
                  key={c.id}
                  onClick={isMaria ? openMaria : undefined}
                  style={{
                    display: "flex", alignItems: "center", gap: 14, padding: "14px 16px", marginTop: 8,
                    background: "white", borderRadius: 14, position: "relative",
                    border: isMaria ? "2px solid var(--brand)" : "1px solid var(--line)",
                    boxShadow: isMaria ? "0 8px 24px rgba(15,181,225,0.18)" : "var(--shadow-sm)",
                    cursor: isMaria ? "pointer" : "default",
                    animation: isMaria && !open ? "glow-ring 2.2s ease-in-out infinite" : "none",
                    opacity: isMaria ? 1 : 0.78,
                  }}
                >
                  {isMaria && !open && (
                    <div style={{ position: "absolute", top: -12, left: 24, background: "var(--ink)", color: "white", padding: "4px 12px", borderRadius: 999, fontSize: 11, fontWeight: 800, whiteSpace: "nowrap", animation: "float-y 1.8s ease-in-out infinite", zIndex: 2 }}>
                      toca aqui 👇
                    </div>
                  )}
                  <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--brand-gradient)", color: "white", fontSize: 14, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0 }}>{c.initials}</div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 16, fontWeight: 800, color: "var(--ink)" }}>{c.name}</div>
                    <div style={{ fontSize: 13, color: "var(--ink-3)", marginTop: 2 }}>{c.phone}</div>
                  </div>
                  <span style={{ padding: "5px 12px", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 999, fontSize: 12, fontWeight: 700, color: "var(--ink-3)", whiteSpace: "nowrap" }}>{c.tag}</span>
                  {stage && (
                    <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", background: "white", border: "1px solid var(--line)", borderRadius: 999, fontSize: 12, fontWeight: 700, color: "var(--ink-2)", whiteSpace: "nowrap" }}>
                      <span style={{ width: 8, height: 8, borderRadius: 999, background: stage.color }} />
                      {stage.label}
                    </span>
                  )}
                  <span style={{ fontSize: 14, fontWeight: 800, color: "var(--success)", whiteSpace: "nowrap", minWidth: 92, textAlign: "right" }}>{c.value}</span>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" style={{ color: "var(--ink-4)", flexShrink: 0 }}><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
                </div>
              );
            })}
          </div>

          {/* Ficha da Maria — overlay */}
          {open && <MariaFicha onBack={() => setOpen(false)} />}
        </div>
      </div>
    </CrmFrame>
  );
}

function MariaFicha({ onBack }: { onBack: () => void }) {
  const maria = CONTACTS.find((c) => c.id === "maria")!;
  const stage = PIPELINE_STAGES.find((s) => s.key === maria.stage)!;
  return (
    <div style={{ position: "absolute", inset: 0, background: "white", display: "flex", flexDirection: "column", animation: "slide-up 0.35s cubic-bezier(0.22,1,0.36,1)", zIndex: 5 }}>
      {/* Header da ficha */}
      <div style={{ padding: "12px 20px", borderBottom: "1px solid var(--line)", display: "flex", alignItems: "center", gap: 14, flexShrink: 0 }}>
        <button onClick={onBack} style={{ display: "flex", alignItems: "center", gap: 6, background: "white", border: "1px solid var(--line)", borderRadius: 999, padding: "8px 14px", fontWeight: 700, fontSize: 13, color: "var(--ink-2)", cursor: "pointer", fontFamily: "inherit" }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M15 6l-6 6 6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
          Lista
        </button>
        <div style={{ width: 44, height: 44, borderRadius: "50%", background: "var(--brand-gradient)", color: "white", fontSize: 14, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0 }}>{maria.initials}</div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 17, fontWeight: 800, color: "var(--ink)" }}>{maria.name}</div>
          <div style={{ fontSize: 12, color: "var(--ink-3)", display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
            {maria.phone} · <span style={{ width: 7, height: 7, borderRadius: 999, background: "var(--success)", display: "inline-block" }} /> WhatsApp conectado
          </div>
        </div>
        <div style={{ flex: 1 }} />
        <span style={{ padding: "5px 12px", background: "var(--bg)", border: "1px solid var(--line)", borderRadius: 999, fontSize: 12, fontWeight: 700, color: "var(--ink-3)" }}>{maria.tag}</span>
        <span style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 12px", background: "white", border: "1px solid var(--line)", borderRadius: 999, fontSize: 12, fontWeight: 700, color: "var(--ink-2)" }}>
          <span style={{ width: 8, height: 8, borderRadius: 999, background: stage.color }} />
          {stage.label}
        </span>
        <span style={{ fontSize: 15, fontWeight: 800, color: "var(--success)" }}>{maria.value}</span>
      </div>

      {/* Corpo: conversa + painel lateral */}
      <div style={{ flex: 1, display: "grid", gridTemplateColumns: "1.2fr 1fr", minHeight: 0 }}>
        {/* Conversa do WhatsApp */}
        <div className="wa-pattern" style={{ overflow: "auto", padding: "14px 18px", display: "flex", flexDirection: "column", gap: 8, minHeight: 0 }}>
          <div style={{ alignSelf: "center", padding: "5px 12px", background: "rgba(225,245,254,0.92)", borderRadius: 10, fontSize: 11, color: "#5C6B78", fontWeight: 700, marginBottom: 2 }}>
            CONVERSA DO WHATSAPP · DENTRO DO CRM
          </div>
          {MARIA_THREAD.map((m, i) => (
            <div key={i} style={{
              alignSelf: m.from === "rep" ? "flex-end" : "flex-start", maxWidth: "78%",
              background: m.from === "rep" ? "var(--whatsapp-out)" : "white",
              padding: "9px 12px 6px",
              borderRadius: m.from === "rep" ? "12px 12px 4px 12px" : "12px 12px 12px 4px",
              boxShadow: "0 1px 1px rgba(0,0,0,0.08)",
              animation: `slide-up 0.4s ease-out ${Math.min(i * 0.08, 0.5)}s both`,
            }}>
              <div style={{ fontSize: 14, lineHeight: 1.4, color: "var(--ink)" }}>{m.text}</div>
              <div style={{ display: "flex", justifyContent: "flex-end", fontSize: 10, color: "var(--ink-4)", marginTop: 3 }}>{m.time}</div>
            </div>
          ))}
          <div style={{ alignSelf: "center", marginTop: 6, padding: "6px 14px", background: "var(--warn-tint)", border: "1px solid #FFD9BD", borderRadius: 999, fontSize: 12, color: "#8C4A1F", fontWeight: 700, animation: "slide-up 0.4s ease-out 0.6s both" }}>
            ⏳ Sem resposta há 7 dias
          </div>
        </div>

        {/* Painel lateral: follow-up + notas */}
        <div style={{ borderLeft: "1px solid var(--line)", padding: 16, overflow: "auto", display: "flex", flexDirection: "column", gap: 12, background: "#FBFDFE", minHeight: 0 }}>
          <div style={{ background: "linear-gradient(135deg, #FFFAF0 0%, #FFF4E5 100%)", border: "2px solid var(--warn)", borderRadius: 14, padding: 14, animation: "pop-in 0.5s cubic-bezier(0.22,1,0.36,1) 0.3s both" }}>
            <div style={{ fontSize: 10, fontWeight: 800, color: "#8C4A1F", letterSpacing: "0.08em", textTransform: "uppercase", display: "flex", alignItems: "center", gap: 6 }}>
              <span style={{ fontSize: 14 }}>⏰</span> Follow-up · venceu ontem
            </div>
            <div style={{ fontSize: 14, fontWeight: 800, color: "var(--ink)", marginTop: 6 }}>Retomar proposta com a Maria</div>
            <div style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 3 }}>Guarda essa informação — ela volta já já 😉</div>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 800, color: "var(--ink-3)", letterSpacing: "0.08em", textTransform: "uppercase", marginBottom: 8 }}>Notas da ficha</div>
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {MARIA_NOTES.map((n, i) => (
                <div key={i} style={{ background: "white", border: "1px solid var(--line)", borderRadius: 12, padding: "10px 12px", animation: `slide-up 0.4s ease-out ${0.4 + i * 0.12}s both` }}>
                  <div style={{ fontSize: 13, color: "var(--ink-2)", lineHeight: 1.4 }}>{n.text}</div>
                  <div style={{ fontSize: 10, color: "var(--ink-4)", marginTop: 5, display: "flex", alignItems: "center", gap: 5 }}>
                    <span style={{ color: "var(--brand-darker)", fontWeight: 800 }}>✨ via {n.via}</span> · {n.time}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: "auto" }}>
            {["Histórico completo", "Tags e campos", "Documentos"].map((t) => (
              <div key={t} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "9px 12px", background: "white", border: "1px solid var(--line)", borderRadius: 10, fontSize: 12, fontWeight: 700, color: "var(--ink-3)" }}>
                {t}
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none"><path d="M9 6l6 6-6 6" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
