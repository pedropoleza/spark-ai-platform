/**
 * POST /api/marina/auth   { senha } → cookie de sessão (7d)
 * DELETE /api/marina/auth → sai
 * GET /api/marina/auth    → { autenticada: bool }
 *
 * Marina Lab (temporário). Ver `_planning/marina-lab/PLANO.md`.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  MARINA_COOKIE,
  assinarTokenMarina,
  lerTokenMarina,
  marinaLabLigado,
  validarSenha,
} from "@/lib/marina-lab/auth";

export const maxDuration = 15;

// Rate limit bobo em memória (por lambda) — só pra não deixar a senha aberta a
// brute force trivial. Não é defesa séria; a defesa séria é a senha ser longa.
const tentativas = new Map<string, { n: number; ate: number }>();
const JANELA_MS = 10 * 60 * 1000;
const MAX_TENTATIVAS = 12;

export async function GET(request: NextRequest) {
  if (!marinaLabLigado()) return NextResponse.json({ ok: false, off: true }, { status: 503 });
  const token = await lerTokenMarina(request);
  return NextResponse.json({ ok: true, autenticada: !!token });
}

export async function POST(request: NextRequest) {
  if (!marinaLabLigado()) return NextResponse.json({ ok: false, off: true }, { status: 503 });

  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "sem-ip";
  const agora = Date.now();
  const t = tentativas.get(ip);
  if (t && t.ate > agora && t.n >= MAX_TENTATIVAS) {
    return NextResponse.json({ ok: false, erro: "muitas tentativas, espera uns minutos" }, { status: 429 });
  }

  let senha = "";
  try {
    const body = (await request.json()) as { senha?: string };
    senha = String(body.senha || "");
  } catch {
    return NextResponse.json({ ok: false, erro: "payload inválido" }, { status: 400 });
  }

  if (!validarSenha(senha)) {
    const novo = t && t.ate > agora ? { n: t.n + 1, ate: t.ate } : { n: 1, ate: agora + JANELA_MS };
    tentativas.set(ip, novo);
    return NextResponse.json({ ok: false, erro: "senha incorreta" }, { status: 401 });
  }

  tentativas.delete(ip);
  const token = await assinarTokenMarina();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MARINA_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 7 * 24 * 3600,
  });
  return res;
}

export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MARINA_COOKIE, "", { httpOnly: true, path: "/", maxAge: 0 });
  return res;
}
