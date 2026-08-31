/**
 * POST /api/alves/feedback — 👍/👎 e recados do time da Alves Cury no lab.
 *
 * Mesmo roteamento do Marina Lab:
 * - 👍/👎 sobre uma resposta → `agent_feedback`, que o prompt JÁ lê
 *   (buildFeedbackSection) — o feedback do Marcos entra no comportamento do
 *   agente no turno seguinte, sem deploy. Foi assim que os 👎 dele de 26-28/08
 *   viraram a v4; aqui ele vê o ciclo fechar.
 * - Recado livre → `marina_lab_feedback` (tabela genérica do lab apesar do
 *   nome; tem agent_id/location_id — filtra por location YuR0... pra ler).
 *
 * Body: { agent_id, tipo?: 'nota'|'sugestao', texto?, mensagem_ia?,
 *         rating?: 'positive'|'negative', sugestao?, session_id? }
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerTokenAlves } from "@/lib/alves-lab/auth";

export const maxDuration = 20;

export async function POST(request: NextRequest) {
  const token = await lerTokenAlves(request);
  if (!token) return NextResponse.json({ ok: false, erro: "não autenticado" }, { status: 401 });

  let b: {
    agent_id?: string; tipo?: string; texto?: string; mensagem_ia?: string;
    rating?: string; sugestao?: string; session_id?: string;
  };
  try {
    b = (await request.json()) as typeof b;
  } catch {
    return NextResponse.json({ ok: false, erro: "payload inválido" }, { status: 400 });
  }

  const agentId = String(b.agent_id || "");
  if (!token.agent_ids.includes(agentId)) {
    return NextResponse.json({ ok: false, erro: "agente fora do escopo" }, { status: 403 });
  }

  const texto = String(b.texto || "").slice(0, 4000);
  const mensagemIa = String(b.mensagem_ia || "").slice(0, 4000);
  const sugestao = String(b.sugestao || "").slice(0, 4000);
  const rating = b.rating === "positive" || b.rating === "negative" ? b.rating : null;

  if (!texto && !mensagemIa && !rating) {
    return NextResponse.json({ ok: false, erro: "manda alguma coisa" }, { status: 400 });
  }

  const supabase = createAdminClient();

  // 1) Avaliação de uma resposta → alimenta o prompt do agente.
  if (rating && mensagemIa) {
    const { error } = await supabase.from("agent_feedback").insert({
      agent_id: agentId,
      location_id: token.location_id,
      rating,
      ai_message: mensagemIa,
      suggestion: sugestao || null,
      context: "alves-lab",
    });
    if (error) {
      console.error("[alves/feedback] agent_feedback:", error.message);
      return NextResponse.json({ ok: false, erro: "não consegui salvar" }, { status: 500 });
    }
  }

  // 2) Diário do lab (recado livre ou nota com contexto).
  if (texto || sugestao) {
    const { error } = await supabase.from("marina_lab_feedback").insert({
      agent_id: agentId,
      location_id: token.location_id,
      tipo: texto ? "sugestao" : "nota",
      texto: texto || null,
      resposta_sugerida: mensagemIa || null,
      rating,
      sugestao_dela: sugestao || null,
      session_id: b.session_id || null,
    });
    if (error) console.error("[alves/feedback] lab:", error.message);
  }

  return NextResponse.json({ ok: true });
}
