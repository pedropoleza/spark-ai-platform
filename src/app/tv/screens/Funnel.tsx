"use client";

// Tela 3 — O funil se move sozinho. Kanban dark neon.
// Roteiro 10s: 0.3-1.5s colunas em stagger · 4s card João desliza com glow ·
// 5.8s badge "movido" · 6.5-9s contador do funil sobe.
import { FUNNEL } from "../data";
import { TvBrand, TvCorner, CountUp } from "./shared";

const COL_W = 316;
const GAP = 22;

export function FunnelScreen() {
  return (
    <div className="tv-layer">
      <TvBrand />
      <TvCorner>CRM ao vivo</TvCorner>

      <div style={{ position: "absolute", top: 170, left: 96, right: 96 }}>
        <h2 className="tv-display" style={{ margin: 0, animation: "tv-rise 0.7s 0.15s both" }}>
          O funil se move <span className="tv-gradient-text">sozinho.</span>
        </h2>
        <p className="tv-lede" style={{ marginTop: 14, animation: "tv-rise 0.7s 0.5s both" }}>{FUNNEL.sub}</p>
      </div>

      {/* Board */}
      <div className="tv-glass" style={{ position: "absolute", left: 96, right: 96, top: 410, bottom: 170, padding: 26, display: "grid", gridTemplateColumns: `repeat(5, ${COL_W}px)`, gap: GAP, justifyContent: "center" }}>
        {FUNNEL.stages.map((stage, si) => (
          <div key={stage.key} style={{ display: "flex", flexDirection: "column", animation: `tv-rise 0.6s ${0.3 + si * 0.18}s both` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, padding: "0 6px" }}>
              <span style={{ width: 14, height: 14, borderRadius: 999, background: stage.color, boxShadow: `0 0 14px ${stage.color}` }} />
              <span style={{ flex: 1, fontSize: 24, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--tv-ink-2)" }}>{stage.label}</span>
            </div>
            <div style={{ flex: 1, background: "rgba(255,255,255,0.03)", border: "1px dashed var(--tv-line)", borderRadius: 20, padding: 14, display: "flex", flexDirection: "column", gap: 14, position: "relative" }}>
              {/* card que desliza: vive na coluna Contato */}
              {stage.key === "contato" && (
                <div style={{
                  position: "relative", zIndex: 5,
                  background: "#102330", borderRadius: 18, padding: "18px 20px",
                  border: "1px solid rgba(43,212,255,0.5)",
                  animation: "tv-funnel-move 1.7s cubic-bezier(0.22,1,0.36,1) 4s both",
                  ["--tv-move-x" as string]: `${COL_W + GAP}px`,
                }}>
                  <div style={{ position: "absolute", top: -16, right: -10, background: "var(--tv-gradient)", color: "white", padding: "6px 16px", borderRadius: 999, fontSize: 19, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", boxShadow: "0 8px 24px rgba(43,212,255,0.5)", animation: "tv-pop 0.5s 5.9s both" }}>movido</div>
                  <TvCard n={FUNNEL.mover.n} i={FUNNEL.mover.i} v={FUNNEL.mover.v} t={FUNNEL.mover.t} highlight />
                </div>
              )}
              {stage.cards.map((c) => (
                <div key={c.n} style={{ background: "#0E1D29", borderRadius: 18, padding: "18px 20px", border: "1px solid var(--tv-line)" }}>
                  <TvCard n={c.n} i={c.i} v={c.v} t={c.t} />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>

      {/* Total do funil */}
      <div style={{ position: "absolute", bottom: 64, left: 0, right: 0, display: "flex", justifyContent: "center", animation: "tv-rise 0.7s 6.3s both" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 20, padding: "20px 44px", borderRadius: 999, background: "rgba(52,226,122,0.10)", border: "1px solid rgba(52,226,122,0.4)" }}>
          <span style={{ fontSize: 52, fontWeight: 800, color: "var(--tv-success)", fontVariantNumeric: "tabular-nums" }}>
            R$ <CountUp to={FUNNEL.total} delay={6600} duration={2400} />
          </span>
          <span style={{ fontSize: 30, color: "var(--tv-ink-2)", fontWeight: 600 }}>{FUNNEL.totalLabel}</span>
        </div>
      </div>
    </div>
  );
}

function TvCard({ n, i, v, t, highlight = false }: { n: string; i: string; v: string; t: string; highlight?: boolean }) {
  return (
    <>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }}>
        <span style={{ width: 48, height: 48, borderRadius: "50%", background: highlight ? "var(--tv-gradient)" : "rgba(255,255,255,0.12)", color: "white", fontSize: 19, fontWeight: 800, display: "grid", placeItems: "center", flexShrink: 0 }}>{i}</span>
        <span style={{ fontSize: 25, fontWeight: 700, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{n}</span>
      </div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
        <span style={{ fontSize: 20, color: "var(--tv-ink-3)", fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t}</span>
        <span style={{ fontSize: 21, color: "var(--tv-success)", fontWeight: 800, whiteSpace: "nowrap" }}>{v}</span>
      </div>
    </>
  );
}
