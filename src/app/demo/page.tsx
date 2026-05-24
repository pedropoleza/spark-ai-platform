"use client";

/**
 * SparkBot — Demo de convenção (Fase 1). Implementação do handoff do Claude Design.
 * Quiosque iPad landscape, on-rails, silencioso. Palco fixo 1366×1024 auto-escalado.
 * Rotas: attract → demo → cadastro → sucesso → attract (hash + reset por inatividade).
 */
import { useEffect, useRef, useState } from "react";
import { ScreenAttract } from "./ScreenAttract";
import { ScreenDemo } from "./ScreenDemo";
import { ScreenCadastro, type LeadForm } from "./ScreenCadastro";
import { ScreenSucesso } from "./ScreenSucesso";

type Route = "attract" | "demo" | "cadastro" | "sucesso";
const ROUTES: Route[] = ["attract", "demo", "cadastro", "sucesso"];
const IDLE_RESET_MS = 90_000;

function App() {
  const [route, setRoute] = useState<Route>(() => {
    if (typeof window === "undefined") return "attract";
    const h = (location.hash || "").replace("#", "");
    return (ROUTES as string[]).includes(h) ? (h as Route) : "attract";
  });
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

  // Idle reset — kiosk behavior
  const lastActivityRef = useRef<number>(Date.now());
  useEffect(() => {
    const bump = () => { lastActivityRef.current = Date.now(); };
    window.addEventListener("pointerdown", bump);
    window.addEventListener("touchstart", bump);
    window.addEventListener("keydown", bump);
    const id = setInterval(() => {
      const idleMs = Date.now() - lastActivityRef.current;
      if (route !== "attract" && idleMs > IDLE_RESET_MS) {
        setRoute("attract");
        setForm(null);
        lastActivityRef.current = Date.now();
      }
    }, 5_000);
    return () => {
      window.removeEventListener("pointerdown", bump);
      window.removeEventListener("touchstart", bump);
      window.removeEventListener("keydown", bump);
      clearInterval(id);
    };
  }, [route]);

  // Keyboard nav (teste/quiosque)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "1") setRoute("attract");
      if (e.key === "2") setRoute("demo");
      if (e.key === "3") setRoute("cadastro");
      if (e.key === "4") setRoute("sucesso");
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Captura: guarda local + dispara persistência best-effort (não bloqueia a UX).
  const handleSubmit = (f: LeadForm) => {
    setForm(f);
    try {
      fetch("/api/demo/lead", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(f),
        keepalive: true,
      }).catch(() => {});
    } catch { /* offline-safe: a tela de sucesso aparece de qualquer forma */ }
  };

  return (
    <>
      {route === "attract" && <ScreenAttract onCTA={(r) => setRoute(r)} />}
      {route === "demo" && <ScreenDemo onCTA={(r) => setRoute(r)} />}
      {route === "cadastro" && <ScreenCadastro onCTA={setRoute} onSubmit={handleSubmit} />}
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
    return () => window.removeEventListener("resize", fit);
  }, []);

  return (
    <div className="kiosk-host">
      <div className="kiosk-stage" ref={stageRef}>
        {mounted && <App />}
      </div>
    </div>
  );
}
