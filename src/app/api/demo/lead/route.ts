import { NextRequest, NextResponse } from "next/server";
import { createServerClient } from "@/lib/supabase/server";
import { normalizePhone } from "@/lib/account-assistant/identity";

/**
 * POST /api/demo/lead — captura do quiosque de demonstração (/demo).
 * Fecha a pendência D5 do commit e969491 (endpoint nunca existiu; leads do
 * estande eram perdidos). Endpoint PÚBLICO (quiosque não tem sessão):
 * validação estrita + caps de tamanho; tabela só acessível via service role.
 * O cliente re-tenta via fila localStorage — 4xx descarta, 5xx mantém na fila.
 */
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "JSON inválido" }, { status: 400 });
  }

  const nome = String(body?.nome ?? "").trim().slice(0, 80);
  const whatsappRaw = String(body?.whatsapp ?? "").trim().slice(0, 25);
  const agencia = String(body?.agencia ?? "").trim().slice(0, 120);

  const digits = whatsappRaw.replace(/\D/g, "");
  if (nome.length < 2 || digits.length < 10 || digits.length > 13 || agencia.length < 2) {
    return NextResponse.json({ error: "Dados inválidos" }, { status: 400 });
  }

  // Convenção é nos EUA (Pedro 2026-06-12) — público BR morando lá, número US.
  // Default +1; quem digitar com +55 explícito é preservado pelo normalizePhone.
  const e164 = normalizePhone(whatsappRaw, "US");

  const queuedAtRaw = typeof body?.queued_at === "string" ? body.queued_at : null;
  const queuedAt = queuedAtRaw && !Number.isNaN(Date.parse(queuedAtRaw)) ? queuedAtRaw : null;

  const supabase = createServerClient();
  const { error } = await supabase.from("demo_leads").insert({
    nome,
    whatsapp_raw: whatsappRaw,
    whatsapp_e164: e164,
    agencia,
    queued_at: queuedAt,
  });

  if (error) {
    console.error("[demo/lead] insert error:", error.message);
    return NextResponse.json({ error: "Erro ao salvar" }, { status: 500 });
  }

  return NextResponse.json({ success: true });
}
