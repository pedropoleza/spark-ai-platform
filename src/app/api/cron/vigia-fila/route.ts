/**
 * Cron: vigia da fila + latência (H92, 2026-09-18).
 *
 * Dois modos no mesmo endpoint, escolhidos por `?modo=`:
 *  - `fila` (default, alta frequência): mensagem vencida parada → dreno forçado
 *    + sinal se sobrar. É a rede que impede o lead de esperar horas enquanto a
 *    causa da cauda não está isolada.
 *  - `latencia` (diário): p50/p90/% lentas por conta + sinal nas degradadas.
 *
 * Só ESCREVE em admin_signals e (no modo fila) drena a própria fila.
 */
import { NextResponse } from "next/server";
import { vigiarFilaParada, vigiarLatencia } from "@/lib/monitoring/vigia-fila";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  if (req.headers.get("x-vercel-cron") === "1") return true;
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  return auth === expected && expected !== "Bearer ";
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  const modo = new URL(req.url).searchParams.get("modo") || "fila";
  try {
    if (modo === "latencia") {
      const horas = Number(new URL(req.url).searchParams.get("horas") || 24);
      const r = await vigiarLatencia(true, horas);
      console.log(`[vigia-latencia] contas=${r.verificadas} degradadas=${r.degradadas.length} sinais=${r.sinais_emitidos}`);
      return NextResponse.json({ ok: true, modo, ...r });
    }
    const r = await vigiarFilaParada(true);
    if (r.presas > 0) {
      console.warn(`[vigia-fila] presas=${r.presas} mais_antiga=${r.mais_antiga_min}min drenou=${r.drenou} processadas=${r.processadas_no_dreno}`);
    }
    return NextResponse.json({ ok: true, modo, ...r });
  } catch (error) {
    console.error("[vigia-fila] erro:", error);
    return NextResponse.json(
      { ok: false, error: error instanceof Error ? error.message : "erro" },
      { status: 500 },
    );
  }
}
