"use client";

// Tela 4 — Agenda cheia. Sem digitar. Eventos pingam um a um; o NOVO entra
// com glow + pill de convite enviado.
// Roteiro 10s: 0.3s grid · 2.5-6.7s eventos (stagger 0.7s) · 7.6s NOVO · 8.6s pill.
import { AGENDA } from "../data";
import { TvBrand, TvCorner } from "./shared";

const ROWS = ["9:00", "10:00", "11:00", "15:00", "16:00"];

export function AgendaScreen() {
  return (
    <div className="tv-layer">
      <TvBrand />
      <TvCorner>CRM ao vivo</TvCorner>

      <div style={{ position: "absolute", top: 170, left: 96, right: 96 }}>
        <h2 className="tv-display" style={{ margin: 0, animation: "tv-rise 0.7s 0.15s both" }}>
          Agenda cheia. <span className="tv-gradient-text">Sem digitar.</span>
        </h2>
        <p className="tv-lede" style={{ marginTop: 14, animation: "tv-rise 0.7s 0.5s both" }}>{AGENDA.sub}</p>
      </div>

      {/* Grid semanal */}
      <div className="tv-glass" style={{ position: "absolute", left: 96, right: 96, top: 410, bottom: 110, padding: "26px 30px", display: "flex", flexDirection: "column", animation: "tv-rise 0.6s 0.3s both" }}>
        {/* header dias */}
        <div style={{ display: "grid", gridTemplateColumns: "120px repeat(5, 1fr)", gap: 14, marginBottom: 14 }}>
          <span />
          {AGENDA.days.map((d, i) => (
            <div key={d} style={{ textAlign: "center", fontSize: 26, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: i === 1 ? "var(--tv-brand-bright)" : "var(--tv-ink-3)" }}>
              {d}
              {i === 1 && <span style={{ display: "block", width: 44, height: 4, borderRadius: 4, background: "var(--tv-gradient)", margin: "8px auto 0" }} />}
            </div>
          ))}
        </div>
        {/* slots */}
        <div style={{ flex: 1, display: "grid", gridTemplateColumns: "120px repeat(5, 1fr)", gridTemplateRows: `repeat(${ROWS.length}, 1fr)`, gap: 14 }}>
          {ROWS.map((hour, r) => (
            <RowCells key={hour} hour={hour} r={r} />
          ))}
        </div>
      </div>

      {/* pill convite */}
      <div style={{ position: "absolute", bottom: 38, left: 0, right: 0, display: "flex", justifyContent: "center", animation: "tv-pop 0.6s 8.6s both" }}>
        <span style={{ padding: "16px 36px", borderRadius: 999, background: "rgba(52,226,122,0.12)", border: "1px solid rgba(52,226,122,0.45)", fontSize: 30, fontWeight: 800, color: "var(--tv-success)" }}>
          {AGENDA.pill}
        </span>
      </div>
    </div>
  );
}

function RowCells({ hour, r }: { hour: string; r: number }) {
  return (
    <>
      <div style={{ fontSize: 24, fontWeight: 700, color: "var(--tv-ink-3)", display: "flex", alignItems: "center", justifyContent: "flex-end", paddingRight: 16, fontVariantNumeric: "tabular-nums" }}>{hour}</div>
      {[0, 1, 2, 3, 4].map((day) => {
        const ev = AGENDA.events.findIndex((e) => e.day === day && e.row === r);
        const isNew = AGENDA.newEvent.day === day && AGENDA.newEvent.row === r;
        return (
          <div key={day} style={{ position: "relative", borderRadius: 14, background: "rgba(255,255,255,0.025)", border: "1px solid rgba(255,255,255,0.05)" }}>
            {ev >= 0 && (
              <div style={{
                position: "absolute", inset: 5, borderRadius: 12, padding: "10px 16px",
                background: `${AGENDA.events[ev].color}1F`,
                borderLeft: `6px solid ${AGENDA.events[ev].color}`,
                fontSize: 22, fontWeight: 700, display: "flex", alignItems: "center",
                overflow: "hidden", whiteSpace: "nowrap", textOverflow: "ellipsis",
                animation: `tv-pop 0.55s ${2.5 + ev * 0.7}s both`,
              }}>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{AGENDA.events[ev].title}</span>
              </div>
            )}
            {isNew && (
              <div style={{
                position: "absolute", inset: 5, borderRadius: 12, padding: "8px 16px",
                background: "var(--tv-gradient)", color: "white",
                fontSize: 22, fontWeight: 800, display: "flex", flexDirection: "column", justifyContent: "center",
                overflow: "hidden", whiteSpace: "nowrap",
                animation: "tv-pop 0.7s 7.6s both, tv-glow 2s ease-in-out 8.3s 2",
              }}>
                <span style={{ fontSize: 16, letterSpacing: "0.1em", textTransform: "uppercase", opacity: 0.9 }}>✨ novo · {AGENDA.newEvent.time}</span>
                <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>{AGENDA.newEvent.title}</span>
              </div>
            )}
          </div>
        );
      })}
    </>
  );
}
