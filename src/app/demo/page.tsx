"use client";

/**
 * SparkBot — Demo de convenção. Refactor 2026-06-11 (handoff original: Claude Design).
 * Quiosque iPad landscape, on-rails + toques guiados. Palco fixo 1366×1024 auto-escalado.
 * Rotas: attract → nome → demo (3 atos) → cadastro → sucesso → attract
 * (hash + reset por inatividade). Nome capturado cedo personaliza a jornada.
 * Lead: POST /api/demo/lead com fila offline em localStorage (wifi de estande é loteria).
 */
import { useEffect, useRef, useState } from "react";
import { ScreenAttract } from "./ScreenAttract";
import { ScreenNome } from "./ScreenNome";
import { ScreenDemo } from "./ScreenDemo";
import { ScreenCadastro, type LeadForm } from "./ScreenCadastro";
import { ScreenSucesso } from "./ScreenSucesso";

type Route = "attract" | "nome" | "demo" | "cadastro" | "sucesso";
const ROUTES: Route[] = ["attract", "nome", "demo", "cadastro", "sucesso"];
// Idle reset POR ROTA (Pedro 2026-06-12: 90s fixo cortava a pessoa no meio do
// cadastro e do scan do QR de checkout). Teclado virtual do iPad nem sempre
// emite pointer/keydown — o bump em "input" (abaixo) cobre a digitação.
const IDLE_RESET_MS: Record<Route, number> = {
  attract: Number.POSITIVE_INFINITY, // já é a tela de descanso
  nome: 120_000,
  demo: 120_000,
  cadastro: 300_000, // 5min — digitando com calma
  sucesso: 240_000,  // 4min — tempo de pegar o celular e escanear o QR
};
const LEAD_QUEUE_KEY = "spark_demo_lead_queue";

// ============ Fila offline de leads (best-effort, sem bloquear a UX) ============
function enqueueLead(lead: LeadForm) {
  try {
    const q: unknown[] = JSON.parse(localStorage.getItem(LEAD_QUEUE_KEY) || "[]");
    q.push({ ...lead, queued_at: new Date().toISOString() });
    localStorage.setItem(LEAD_QUEUE_KEY, JSON.stringify(q.slice(-50)));
  } catch { /* storage indisponível — a tela de sucesso aparece mesmo assim */ }
}

let flushing = false;
async function flushLeadQueue() {
  if (flushing) return;
  flushing = true;
  try {
    let q: Record<string, unknown>[] = [];
    try { q = JSON.parse(localStorage.getItem(LEAD_QUEUE_KEY) || "[]"); } catch { return; }
    if (!q.length) return;
    const remaining: Record<string, unknown>[] = [];
    for (const lead of q) {
      try {
        const res = await fetch("/api/demo/lead", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(lead),
          keepalive: true,
        });
        // 2xx = gravado; 4xx = payload inválido (não adianta re-tentar). 5xx/rede = mantém na fila.
        if (!res.ok && res.status >= 500) remaining.push(lead);
      } catch {
        remaining.push(lead);
      }
    }
    try { localStorage.setItem(LEAD_QUEUE_KEY, JSON.stringify(remaining)); } catch { /* noop */ }
  } finally {
    flushing = false;
  }
}

function App() {
  const [route, setRoute] = useState<Route>(() => {
    if (typeof window === "undefined") return "attract";
    const h = (location.hash || "").replace("#", "");
    return (ROUTES as string[]).includes(h) ? (h as Route) : "attract";
  });
  const [visitorName, setVisitorName] = useState<string | null>(null);
  const [form, setForm] = useState<LeadForm | null>(null);

  // hash → route
  useEffect(() => {
    const onHash = () => {
      const h = (location.hash || "").replace("#", "");
      if ((ROUTES as string[]).includes(h)) setRoute(h as Route);
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // route → hash
  useEffect(() => {
    if (location.hash !== `#${route}`) history.replaceState(null, "", `#${route}`);
  }, [route]);

  // Fila de leads: tenta drenar ao montar e quando a rede volta
  useEffect(() => {
    flushLeadQueue();
    const onOnline = () => flushLeadQueue();
    window.addEventListener("online", onOnline);
    return () => window.removeEventListener("online", onOnline);
  }, []);

  // Idle reset — kiosk behavior (timeout por rota; ver IDLE_RESET_MS)
  const lastActivityRef = useRef<number>(Date.now());
  useEffect(() => {
    const bump = () => { lastActivityRef.current = Date.now(); };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("touchstart", bump);
    window.addEventListener("keydown", bump);
    // teclado virtual do iPad: "input"/"focusin" disparam mesmo quando
    // pointer/keydown não chegam na página
    window.addEventListener("input", bump, true);
    window.addEventListener("focusin", bump, true);
    const id = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (route !== "attract" && idleMs > (IDLE_RESET_MS[route] ?? 120_000)) {
        setRoute("attract");
        setForm(null);
        setVisitorName(null);
        lastActivityRef.current = Date.now();
      }
    }, 5_000);
    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("touchstart", bump);
      window.removeEventListener("keydown", bump);
      window.removeEventListener("input", bump, true);
      window.removeEventListener("focusin", bump, true);
      clearInterval(id);
    };
  }, [route]);

  // Keyboard nav (teste/quiosque)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "1") setRoute("attract");
      if (e.key === "2") setRoute("nome");
      if (e.key === "3") setRoute("demo");
      if (e.key === "4") setRoute("cadastro");
      if (e.key === "5") setRoute("sucesso");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Captura: guarda local + persiste via fila com retry (offline-safe).
  const handleSubmit = (f: LeadForm) => {
    setForm(f);
    enqueueLead(f);
    flushLeadQueue();
  };

  const handleName = (name: string | null) => {
    setVisitorName(name);
    setRoute("demo");
  };

  return (
    <>
      {route === "attract" && <ScreenAttract onCTA={(r) => setRoute(r)} />}
      {route === "nome" && <ScreenNome onSubmit={handleName} onBack={() => setRoute("attract")} />}
      {route === "demo" && <ScreenDemo onCTA={(r) => setRoute(r)} userName={visitorName} />}
      {route === "cadastro" && <ScreenCadastro onCTA={setRoute} onSubmit={handleSubmit} initialName={visitorName} />}
      {route === "sucesso" && <ScreenSucesso form={form} onCTA={setRoute} />}
    </>
  );
}

// ============ Stage scaler: fit 1366×1024 to viewport ============
export default function DemoPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  // Quiosque é uma SPA on-rails — não precisa de SSR. Renderizar só no cliente
  // (após mount) elimina mismatch de hidratação (floats dos chips orbitando,
  // Math.random do confete, rota inicial via hash). Server e 1º render do
  // cliente batem (palco vazio) → zero warning.
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    const fit = () => {
      const el = stageRef.current;
      if (!el) return;
      const scale = Math.min(window.innerWidth / 1366, window.innerHeight / 1024);
      el.style.transform = `scale(${scale})`;
    };
    fit();
    window.addEventListener("resize", fit);

    // Guard anti-scroll: elementos com overflow:hidden ainda aceitam scrollTop
    // programático (focus de input / teclado do iPad tentando revelar o campo).
    // Sem isso o palco inteiro desloca ~160px e o chrome do quiosque some.
    const unscroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.classList?.contains("kiosk-stage") || t.classList?.contains("kiosk-host"))) {
        t.scrollTop = 0;
        t.scrollLeft = 0;
      }
    };
    document.addEventListener("scroll", unscroll, true);

    return () => {
      window.removeEventListener("resize", fit);
      document.removeEventListener("scroll", unscroll, true);
    };
  }, []);

  return (
    <div className="kiosk-host">
      <div className="kiosk-stage" ref={stageRef}>
        {mounted && <App />}
      </div>
    </div>
  );
}
