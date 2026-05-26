/**
 * POST /api/agent-platform/builder/compose — fecha o agente custom a partir do
 * BRIEF do wizard. O wizard (custom-builder.tsx) coleta as decisões estruturais
 * (intake, canal, objetivo, etc.); aqui a IA escreve o conteúdo "mole":
 *   - name, purpose_summary
 *   - custom_instructions (ricas, PT-BR, incorporando o intake)
 *   - qualification_fields (extraídas do que a pessoa disse)
 *   - tone (4 eixos 0-100)
 *
 * Determinístico onde importa (estrutura vem do wizard); a IA só enriquece.
 * Retorna { name, purpose_summary, custom_instructions, qualification_fields, tone }.
 * Falha graciosa: se a IA cair, o client usa o purpose cru como instruções.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import OpenAI from "openai";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export const dynamic = "force-dynamic";
export const maxDuration = 45;

const INTAKE_LABEL: Record<string, string> = {
  inbound: "o lead manda mensagem primeiro (responde a quem chega)",
  tag: "só atende contatos com tag específica",
  stage: "só atende contatos numa etapa do funil",
  keyword: "campanha: o lead manda uma palavra-chave",
  outreach: "o agente inicia a conversa (prospecção de uma lista)",
};

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const body = (await request.json().catch(() => ({}))) as Record<string, any>;
  const b = (body.brief || {}) as Record<string, unknown>;
  const purpose = String(b.purpose || "").trim();
  if (!purpose) return errorResponse("Brief vazio.", 400, "no_brief");

  const intake = (b.intake || {}) as Record<string, unknown>;
  const intakeMode = String(intake.mode || "inbound");
  const identity = (b.identity || {}) as Record<string, unknown>;
  const objective = String(b.objective || "qualification_and_booking");
  const qualHint = String(b.qualification_hint || "").trim();
  const channels = Array.isArray(b.channels) ? (b.channels as string[]).join(", ") : "";

  const briefText = [
    `PROPÓSITO/CAMPANHA: ${purpose}`,
    `COMO OS LEADS CHEGAM: ${INTAKE_LABEL[intakeMode] || intakeMode}` +
      (intake.keyword ? ` (palavra-chave: "${String(intake.keyword)}")` : "") +
      (Array.isArray(intake.tags) && (intake.tags as string[]).length ? ` (tags: ${(intake.tags as string[]).join(", ")})` : ""),
    `SE APRESENTA COMO: ${identity.mode === "human" ? "uma pessoa do time" : "uma assistente virtual"}` +
      (identity.name ? ` chamada ${String(identity.name)}` : ""),
    `OBJETIVO: ${objective}`,
    channels ? `CANAIS: ${channels}` : "",
    qualHint ? `O QUE DESCOBRIR DO LEAD: ${qualHint}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const system =
    "Você monta a 'mente' de um agente de IA que conversa com LEADS de uma agência de seguros no WhatsApp/Instagram, em português do Brasil. " +
    "A partir do brief, escreva a configuração final. Regras: " +
    "(1) custom_instructions: 1-3 parágrafos ricos e específicos, na 2ª pessoa ('Você é...'), dizendo quem o agente é, o que oferece, como conduzir a conversa e incorporando o contexto de como o lead chegou. " +
    "(2) qualification_fields: extraia do brief o que faz sentido o agente descobrir (3-6 campos). type: text/date/boolean/select. " +
    "(3) tone: 4 eixos 0-100 (creativity, formality, naturalness, assertiveness) coerentes com o propósito. " +
    "(4) name: nome curto do agente (aparece no Spark Leads). purpose_summary: 1 frase. " +
    "NUNCA escreva 'GHL' nem 'GoHighLevel' — o CRM se chama 'Spark Leads'. Não invente fatos que não estão no brief. " +
    'Responda SÓ um JSON: {"name":string,"purpose_summary":string,"custom_instructions":string,"qualification_fields":[{"label":string,"type":string,"required":boolean}],"tone":{"creativity":number,"formality":number,"naturalness":number,"assertiveness":number}}';

  try {
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 40000 });
    const comp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        { role: "system", content: system },
        { role: "user", content: briefText },
      ],
      temperature: 0.5,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    });
    const raw = comp.choices[0]?.message?.content || "{}";
    const parsed = JSON.parse(raw) as Record<string, unknown>;

    const clampN = (v: unknown, d: number) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.max(0, Math.min(100, Math.round(n))) : d;
    };
    const tone = (parsed.tone || {}) as Record<string, unknown>;
    const fields = Array.isArray(parsed.qualification_fields) ? parsed.qualification_fields : [];
    const qualification_fields = fields
      .slice(0, 15)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .map((f: any) => ({
        label: String(f?.label || "").slice(0, 120),
        type: ["text", "date", "boolean", "select"].includes(f?.type) ? f.type : "text",
        required: f?.required === true,
      }))
      .filter((f: { label: string }) => f.label);

    return NextResponse.json({
      name: String(parsed.name || "").slice(0, 120) || "Agente personalizado",
      purpose_summary: String(parsed.purpose_summary || "").slice(0, 600),
      custom_instructions: String(parsed.custom_instructions || purpose).slice(0, 8000),
      qualification_fields,
      tone: {
        creativity: clampN(tone.creativity, 60),
        formality: clampN(tone.formality, 50),
        naturalness: clampN(tone.naturalness, 80),
        assertiveness: clampN(tone.assertiveness, 50),
      },
    });
  } catch (err) {
    console.warn("[builder/compose] fallback:", err instanceof Error ? err.message : err);
    // Falha graciosa: usa o purpose cru como instruções; sem campos sugeridos.
    return NextResponse.json({
      name: "Agente personalizado",
      purpose_summary: purpose.slice(0, 200),
      custom_instructions: purpose,
      qualification_fields: [],
      tone: { creativity: 60, formality: 50, naturalness: 80, assertiveness: 50 },
      degraded: true,
    });
  }
}
