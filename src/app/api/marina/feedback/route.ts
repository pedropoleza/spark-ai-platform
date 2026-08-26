/**
 * POST /api/marina/feedback — recado, sugestão e 👍/👎 da Marina.
 *
 * Roteamento deliberado (ver `_planning/marina-lab/PLANO.md`):
 * - 👍/👎 sobre uma RESPOSTA do agente → `agent_feedback`, que o prompt JÁ lê
 *   (buildFeedbackSection: 3 positivos como "estilo aprovado", 5 negativos como
 *   "evitar", e a sugestão dela vira `→ melhor: "..."`). Ou seja: entra no
 *   comportamento do agente no próximo turno, sem deploy.
 * - Recado livre / cenário / avaliação de sugestão de print → `marina_lab_feedback`.
 *
 * Body: { tipo: 'sugestao'|'cenario'|'nota'|'resposta', texto?, mensagem_ia?,
 *         rating?: 'positive'|'negative', sugestao_dela?, registro_id?, session_id? }
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerTokenMarina } from "@/lib/marina-lab/auth";

export const maxDuration = 20;

export async function POST(request: NextRequest) {
  const token = await lerTokenMarina(request);
  if (!token) return NextResponse.json({ ok: false, erro: "não autenticada" }, { status: 401 });

  let b: {
    tipo?: string; texto?: string; mensagem_ia?: string; rating?: string;
    sugestao_dela?: string; registro_id?: string; session_id?: string;
  };
  try {
    b = (await request.json()) as typeof b;
  } catch {
    return NextResponse.json({ ok: false, erro: "payload inválido" }, { status: 400 });
  }

  const tipo = String(b.tipo || "nota");
  const texto = String(b.texto || "").slice(0, 4000);
  const mensagemIa = String(b.mensagem_ia || "").slice(0, 4000);
  const sugestaoDela = String(b.sugestao_dela || "").slice(0, 4000);
  const rating = b.rating === "positive" || b.rating === "negative" ? b.rating : null;

  if (!texto && !mensagemIa && !rating) {
    return NextResponse.json({ ok: false, erro: "manda alguma coisa" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 1) Avaliação de uma resposta do agente → alimenta o prompt.
  if (rating && mensagemIa) {
    const { error } = await supabase.from("agent_feedback").insert({
      agent_id: token.agent_id,
      location_id: token.location_id,
      rating,
      ai_message: mensagemIa,
      suggestion: sugestaoDela || null,
      context: "marina-lab",
    });
    if (error) {
      console.error("[marina/feedback] agent_feedback:", error.message);
      return NextResponse.json({ ok: false, erro: "não consegui salvar" }, { status: 500 });
    }
  }

  // 2) Registro no diário do lab (sempre — é o material bruto).
  const tipoLab = ["sugestao", "print", "cenario", "nota"].includes(tipo)
    ? tipo
    : rating
      ? "nota"
      : "sugestao";

  // Avaliação de uma sugestão de print: completa a linha que já existe.
  if (b.registro_id && rating) {
    await supabase
      .from("marina_lab_feedback")
      .update({ rating, sugestao_dela: sugestaoDela || null })
      .eq("id", b.registro_id)
      .eq("agent_id", token.agent_id);
    return NextResponse.json({ ok: true });
  }

  const { error } = await supabase.from("marina_lab_feedback").insert({
    agent_id: token.agent_id,
    location_id: token.location_id,
    tipo: tipoLab,
    texto: texto || null,
    resposta_sugerida: mensagemIa || null,
    rating,
    sugestao_dela: sugestaoDela || null,
    session_id: b.session_id || null,
  });
  if (error) {
    console.error("[marina/feedback] marina_lab_feedback:", error.message);
    return NextResponse.json({ ok: false, erro: "não consegui salvar" }, { status: 500 });
  }

  return NextResponse.json({ ok: true });
}
