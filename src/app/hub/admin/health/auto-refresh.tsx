"use client";

/**
 * Auto-refresh helper pro /hub/admin/health (hypercare 48h).
 *
 * Recarrega a página (router.refresh) a cada N segundos. Default 30s — Pedro
 * deixa aberto numa aba e vê o sistema vivo sem precisar F5. Pausa quando aba
 * não está visível (saves resources).
 *
 * Renderiza só um indicador discreto no footer.
 */
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

const REFRESH_INTERVAL_MS = 30_000;

export function HealthAutoRefresh() {
  const router = useRouter();
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    let intervalId: NodeJS.Timeout | null = null;

    function startInterval() {
      if (intervalId) return;
      intervalId = setInterval(() => {
        if (document.visibilityState !== "visible") return;
        router.refresh();
        setLastRefresh(new Date());
      }, REFRESH_INTERVAL_MS);
    }

    function stopInterval() {
      if (intervalId) {
        clearInterval(intervalId);
        intervalId = null;
      }
    }

    function onVis() {
      if (document.visibilityState === "visible") {
        setPaused(false);
        startInterval();
      } else {
        setPaused(true);
        stopInterval();
      }
    }

    document.addEventListener("visibilitychange", onVis);
    startInterval();

    return () => {
      document.removeEventListener("visibilitychange", onVis);
      stopInterval();
    };
  }, [router]);

  function fmtTime(d: Date) {
    return d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }

  return (
    <div
      className="muted"
      style={{
        fontSize: 11,
        textAlign: "center",
        padding: "12px 0 4px",
        opacity: paused ? 0.5 : 1,
      }}
    >
      Auto-refresh a cada 30s · último: {fmtTime(lastRefresh)}
      {paused && " · pausado (aba em background)"}
    </div>
  );
}
