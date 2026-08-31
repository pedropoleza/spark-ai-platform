/**
 * POST /api/alves/followup-preview — { agent_id, session_id }
 *
 * "E se o lead parasse de responder AGORA?" — gera os toques de follow-up que
 * sairiam pra conversa do lab, usando o MESMO caminho de produção:
 * buildFollowUpPrompt + LLM + guard anti-repetição (H88) + guarda de data +
 * sanitizer de termos. Cada toque gerado entra no histórico do próximo, igual
 * na vida real (o toque 2 sabe que o toque 1 saiu).
 *
 * É a vitrine do Alves Lab: o Marcos reclamou (com razão) de follow-up robótico
 * que repetia pergunta — aqui ele VÊ o comportamento novo antes da religa,
 * inclusive quando o sistema decide ficar quieto pra não soar robô.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { lerTokenAlves } from "@/lib/alves-lab/auth";
import { buildFollowUpPrompt } from "@/lib/ai/sales-prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import { sanitizeOutbound, resolveForbiddenTerms } from "@/lib/ai/outbound-sanitizer";
import { condenseFollowUp } from "@/lib/ai/message-splitter";
import { isRepeatedAsk } from "@/lib/queue/followup-repeat-guard";
import { aplicarGuardaDeDataLead } from "@/lib/queue/lead-day-guard";
import type { FollowUpConfig } from "@/types/agent";

export const maxDuration = 60;

function rotuloDelay(min: number): string {
  if (min < 60) return `${min} min depois`;
  if (min < 1440) {
    const h = Math.round(min / 60);
    return h === 1 ? "1 hora depois" : `cerca de ${h} horas depois`;
  }
  const d = Math.round(min / 1440);
  return d === 1 ? "1 dia depois" : `${d} dias depois`;
}

export async function POST(request: NextRequest) {
  const token = await lerTokenAlves(request);
  if (!token) return NextResponse.json({ ok: false, erro: "não autenticado" }, { status: 401 });

  let body: { agent_id?: string; session_id?: string };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, erro: "payload inválido" }, { status: 400 });
  }
  const agentId = String(body.agent_id || "");
  const sessionId = String(body.session_id || "");
  if (!token.agent_ids.includes(agentId)) {
    return NextResponse.json({ ok: false, erro: "agente fora do escopo" }, { status: 403 });
  }
  if (!sessionId) return NextResponse.json({ ok: false, erro: "session_id obrigatório" }, { status: 400 });

  const supabase = createAdminClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("id, type, name, agent_configs(*)")
    .eq("id", agentId)
    .maybeSingle();
  if (!agent) return NextResponse.json({ ok: false, erro: "agente não encontrado" }, { status: 404 });
  const config = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;
  if (!config) return NextResponse.json({ ok: false, erro: "agente sem config" }, { status: 400 });

  // Sessão TEM que ser do lab desta location + deste agente.
  const { data: sess } = await supabase
    .from("agent_test_sessions")
    .select("id")
    .eq("id", sessionId)
    .eq("location_id", token.location_id)
    .eq("agent_id", agentId)
    .maybeSingle();
  if (!sess) return NextResponse.json({ ok: false, erro: "sessão não encontrada" }, { status: 404 });

  const { data: msgs } = await supabase
    .from("agent_test_messages")
    .select("role, content")
    .eq("session_id", sessionId)
    .order("created_at", { ascending: true });
  const turns = (msgs || []).filter((m) => m.content && String(m.content).trim());
  if (turns.length === 0) {
    return NextResponse.json({ ok: false, erro: "conversa vazia — manda uma mensagem primeiro" }, { status: 400 });
  }

  const historiaBase = turns
    .slice(-12)
    .map((m) => `${m.role === "user" ? "LEAD" : "AGENTE"}: ${String(m.content).substring(0, 300)}`)
    .join("\n");

  const fuCfg = (config.follow_up_config || {}) as FollowUpConfig;
  const steps =
    fuCfg.mode === "manual" && Array.isArray(fuCfg.manual_steps) && fuCfg.manual_steps.length > 0
      ? fuCfg.manual_steps.slice(0, 3)
      : [{ delay_minutes: 120 }, { delay_minutes: 1440 }, { delay_minutes: 4320 }];

  const model = (config.ai_model as string) || "claude-sonnet-4-6";
  const forbidden = resolveForbiddenTerms(agentId, config.forbidden_terms as string[] | null | undefined);

  const toques: Array<{ n: number; quando: string; texto?: string; quieto?: boolean; motivo?: string }> = [];
  let historia = historiaBase;
  const priorAiTexts = turns.filter((m) => m.role !== "user").map((m) => String(m.content));

  for (let i = 0; i < steps.length; i++) {
    const attempt = i + 1;
    const quando = rotuloDelay(Number(steps[i]?.delay_minutes) || 120);
    const prompt = buildFollowUpPrompt({
      config,
      agentType: agent.type as "sales_agent" | "recruitment_agent",
      attemptNumber: attempt,
      locationName: "Alves Cury Financial",
      currentDate: new Date().toLocaleDateString("pt-BR"),
      timezone: "America/New_York",
      contactName: undefined,
      collectedData: {},
      recentHistory: historia,
      mensagemSugerida: (steps[i] as { custom_message?: string })?.custom_message || undefined,
    } as Parameters<typeof buildFollowUpPrompt>[0]);

    const gerar = (extra = "") =>
      processWithAI({
        systemPrompt: prompt + extra,
        conversationHistory: "",
        newMessages: `Follow-up #${attempt} para o lead. Gere uma unica mensagem de follow-up.`,
        model,
      });

    let r = await gerar();
    let texto = "";
    const extrair = (res: Awaited<ReturnType<typeof processWithAI>>): string => {
      const m = res.success ? res.response?.message : null;
      return Array.isArray(m) ? m.filter((s) => typeof s === "string").join("\n\n") : m ? String(m) : "";
    };
    texto = extrair(r);

    if (!texto.trim() || /\[\[\s*NAO_ENVIAR\s*\]\]/i.test(texto)) {
      toques.push({ n: attempt, quando, quieto: true, motivo: "a IA decidiu que não vale um toque aqui — melhor quieto que sem noção" });
      continue;
    }

    // Guard anti-repetição (H88) — igual ao runner de produção.
    const veredito = isRepeatedAsk(texto, priorAiTexts);
    if (veredito.repeated) {
      const constraint =
        `\n\n## PERGUNTA JÁ FEITA (PROIBIDO REPETIR — regra dura)\n` +
        `Você já pediu isso e o lead NÃO respondeu: "${(veredito.matched || "").slice(0, 200)}".\n` +
        `PROIBIDO pedir esse dado ou reoferecer a mesma escolha, em qualquer formulação. Outro ângulo ou "[[NAO_ENVIAR]]".`;
      r = await gerar(constraint);
      const texto2 = extrair(r);
      if (!texto2.trim() || /\[\[\s*NAO_ENVIAR\s*\]\]/i.test(texto2) || isRepeatedAsk(texto2, priorAiTexts).repeated) {
        toques.push({
          n: attempt,
          quando,
          quieto: true,
          motivo: "o sistema descartou este toque: ele repetiria uma pergunta que o lead já ignorou",
        });
        continue;
      }
      texto = texto2;
    }

    const san = sanitizeOutbound([texto.trim()], forbidden);
    texto = condenseFollowUp(san.messages.join("\n\n"));
    const dg = aplicarGuardaDeDataLead([texto], "America/New_York");
    texto = dg.messages[0] || texto;

    toques.push({ n: attempt, quando, texto });
    historia += `\nAGENTE: ${texto.substring(0, 300)}`;
    priorAiTexts.push(texto);
  }

  return NextResponse.json({
    ok: true,
    toques,
    nota:
      "Na vida real: os toques respeitam a janela de envio 08h–21h (fuso da conta), " +
      "PARAM na hora que o lead responder, e nunca saem se a conversa já agendou ou o time assumiu.",
  });
}
