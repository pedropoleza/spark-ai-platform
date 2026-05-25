/**
 * POST /api/agent-platform/builder/message — turno da conversa do builder com IA.
 *
 * Body: { messages: {role:"user"|"assistant", content:string}[] }
 * A IA (Claude, com a tool propose_agent) ou responde com uma pergunta (texto)
 * ou, quando entende o suficiente, emite o SPEC. Retorna { assistant, spec }.
 * Stateless: o histórico vem do client. Plataforma Modular — Fase F.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { errorResponse, unauthorized } from "@/lib/utils/api";
import { runWithTools, type LLMMessage } from "@/lib/account-assistant/llm-client";
import { listModules } from "@/lib/repositories/agent-platform.repo";
import { proposeAgentTool, buildBuilderSystemPrompt, AgentSpecSchema } from "@/lib/agent-platform/builder-spec";
import { MODULE_LABEL } from "@/components/hub/module-labels";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const body = await req.json().catch(() => ({}));
  const incoming: unknown[] = Array.isArray(body.messages) ? body.messages : [];
  const messages: LLMMessage[] = incoming
    .filter(
      (m: unknown): m is { role: "user" | "assistant"; content: string } =>
        !!m &&
        typeof (m as { content?: unknown }).content === "string" &&
        ((m as { role?: unknown }).role === "user" || (m as { role?: unknown }).role === "assistant") &&
        (m as { content: string }).content.trim().length > 0,
    )
    .slice(-20)
    .map((m) => ({ role: m.role, content: m.content }));

  if (messages.length === 0 || messages[messages.length - 1].role !== "user") {
    return errorResponse("A última mensagem precisa ser do usuário.", 400, "bad_messages");
  }

  // Catálogo lead-facing (custom é sempre lead).
  const catalog = (await listModules()).filter((m) => m.audience_scope === "both" || m.audience_scope === "lead");
  const moduleKeys = catalog.map((m) => m.key);
  const moduleCatalog = catalog.map((m) => ({ key: m.key, label: MODULE_LABEL[m.key] || m.name }));

  let captured: unknown = null;
  let result;
  try {
    result = await runWithTools({
      systemPrompt: buildBuilderSystemPrompt(moduleCatalog),
      messages,
      tools: [proposeAgentTool(moduleKeys)],
      executor: async (name, input) => {
        if (name === "propose_agent") {
          captured = input;
          return { received: true };
        }
        return { status: "unknown_tool" };
      },
      model: "claude-sonnet-4-6",
    });
  } catch (err) {
    return errorResponse(err instanceof Error ? err.message : "erro no builder", 500, "builder_error");
  }

  let spec = null;
  if (captured) {
    const parsed = AgentSpecSchema.safeParse(captured);
    if (parsed.success) spec = parsed.data;
  }

  const assistant =
    result.text?.trim() ||
    (spec ? "Pronto! Montei uma proposta — confira na ficha ao lado e clique em Criar quando quiser." : "Me conta um pouco mais?");

  return NextResponse.json({ assistant, spec });
}
