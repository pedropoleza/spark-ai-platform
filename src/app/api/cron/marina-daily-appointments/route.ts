/**
 * Cron: resumo matinal dos agendamentos do dia da Marina (encontro em grupo).
 * Pedido do Pedro 2026-07-01. Toda manhã (ver vercel.json) monta a lista
 * condensada e entrega por WhatsApp (Stevo) pro número em `MARINA_DAILY_PHONE`.
 *
 * No-op seguro se `MARINA_DAILY_PHONE` não estiver setado (não manda pra lugar
 * nenhum) ou se não houver agendamentos no dia (não gera ruído em dia sem encontro).
 * Ativação (👤): setar MARINA_DAILY_PHONE (+ STEVO_SEND_ENABLED=1) na Vercel.
 *
 * Segurança: header `Authorization: Bearer <CRON_SECRET>` ou `x-vercel-cron: 1`.
 */
import { NextResponse } from "next/server";
import { runMarinaDailyDigest } from "@/lib/account-assistant/marina-daily";

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
    const result = await runMarinaDailyDigest();
    console.log("[marina-daily] result:", JSON.stringify(result));
    return NextResponse.json(result);
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error("[marina-daily] erro:", error);
    return NextResponse.json({ ok: false, error }, { status: 500 });
  }
}
