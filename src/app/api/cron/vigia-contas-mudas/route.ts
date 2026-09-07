/**
 * Cron: vigia de contas mudas (H89 — pedido do Pedro depois do caso Jussara,
 * que ficou 12 dias sem responder lead e só foi descoberto pela reclamação dela).
 *
 * Roda 1×/dia (ver vercel.json) e emite admin_signal por location que parou.
 * Read-only sobre os dados de operação: só ESCREVE em admin_signals.
 *
 * Segurança: `Authorization: Bearer <CRON_SECRET>` ou `x-vercel-cron: 1`.
 */
import { NextResponse } from "next/server";
import { varrerContasMudas } from "@/lib/monitoring/vigia-contas-mudas";

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
  try {
    const r = await varrerContasMudas(true);
    console.log(
      `[vigia-contas-mudas] verificadas=${r.verificadas} achados=${r.achados.length} sinais=${r.sinais_emitidos}` +
        (r.achados.length ? ` | ${r.achados.map((a) => `${a.location_id}:${a.classe}:${a.dias_parada}d`).join(", ")}` : "")
    );
    return NextResponse.json(r);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[vigia-contas-mudas] erro:", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
