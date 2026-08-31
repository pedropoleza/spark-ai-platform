/**
 * POST /api/alves/auth   { pin } → cookie de sessão (14d)
 * DELETE /api/alves/auth → sai
 * GET /api/alves/auth    → { autenticado: bool }
 *
 * Alves Lab (temporário — teste dos agentes reformados antes da religa).
 */
import { NextRequest, NextResponse } from "next/server";
import {
  ALVES_COOKIE,
  assinarTokenAlves,
  lerTokenAlves,
  alvesLabLigado,
  validarPin,
} from "@/lib/alves-lab/auth";

export const maxDuration = 15;

// Rate limit em memória (por lambda) — PIN de 4 dígitos precisa pelo menos
// disso contra brute force trivial. Janela dura + poucas tentativas.
const tentativas = new Map<string, { n: number; ate: number }>();
const JANELA_MS = 15 * 60 * 1000;
const MAX_TENTATIVAS = 8;

export async function GET(request: NextRequest) {
  if (!alvesLabLigado()) return NextResponse.json({ ok: false, off: true }, { status: 503 });
  const token = await lerTokenAlves(request);
  return NextResponse.json({ ok: true, autenticado: !!token });
}

export async function POST(request: NextRequest) {
  if (!alvesLabLigado()) return NextResponse.json({ ok: false, off: true }, { status: 503 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "sem-ip";
  const agora = Date.now();
  const t = tentativas.get(ip);
  if (t && t.ate > agora && t.n >= MAX_TENTATIVAS) {
    return NextResponse.json({ ok: false, erro: "muitas tentativas, espera uns minutos" }, { status: 429 });
  }

  let pin = "";
  try {
    const body = (await request.json()) as { pin?: string };
    pin = String(body.pin || "");
  } catch {
    return NextResponse.json({ ok: false, erro: "payload inválido" }, { status: 400 });
  }

  if (!validarPin(pin)) {
    const novo = t && t.ate > agora ? { n: t.n + 1, ate: t.ate } : { n: 1, ate: agora + JANELA_MS };
    tentativas.set(ip, novo);
    return NextResponse.json({ ok: false, erro: "PIN incorreto" }, { status: 401 });
  }

  tentativas.delete(ip);
  const token = await assinarTokenAlves();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ALVES_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 14 * 24 * 3600,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(ALVES_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
