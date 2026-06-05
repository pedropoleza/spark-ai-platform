/**
 * POST /api/agent-platform/builder/compose — fecha o agente custom a partir do
 * BRIEF do wizard. O wizard (agent-wizard.tsx) coleta as decisões estruturais
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
import { reportError } from "@/lib/admin-signals/report-error";

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

  const template = ["sales", "recruitment", "custom"].includes(String(b.template)) ? String(b.template) : "custom";
  const isRec = template === "recruitment";
  const audienceNoun = isRec ? "CANDIDATOS a corretor/agente" : "LEADS";
  const intake = (b.intake || {}) as Record<string, unknown>;
  const intakeMode = String(intake.mode || "inbound");
  const identity = (b.identity || {}) as Record<string, unknown>;
  const objective = String(b.objective || "qualification_and_booking");
  const qualHint = String(b.qualification_hint || "").trim();
  const channels = Array.isArray(b.channels) ? (b.channels as string[]).join(", ") : "";

  // F36 (Pedro 2026-05-28): contexto adicional do canal pra adaptar style.
  const channelHint = channels.toLowerCase().includes("instagram")
    ? "Como inclui Instagram, prefira mensagens curtas (≤280 chars), emojis com moderação, tom casual."
    : channels.toLowerCase().includes("whatsapp")
      ? "WhatsApp aceita blocos maiores, mas evite markdown (não renderiza)."
      : "";

  const briefText = [
    `PROPÓSITO/CAMPANHA: ${purpose}`,
    `COMO OS LEADS CHEGAM: ${INTAKE_LABEL[intakeMode] || intakeMode}` +
      (intake.keyword ? ` (palavra-chave: "${String(intake.keyword)}")` : "") +
      (Array.isArray(intake.tags) && (intake.tags as string[]).length ? ` (tags: ${(intake.tags as string[]).join(", ")})` : ""),
    `SE APRESENTA COMO: ${identity.mode === "human" ? "uma pessoa do time" : "uma assistente virtual"}` +
      (identity.name ? ` chamada ${String(identity.name)}` : ""),
    `OBJETIVO: ${objective}`,
    channels ? `CANAIS: ${channels}${channelHint ? " — " + channelHint : ""}` : "",
    qualHint ? `O QUE DESCOBRIR DO LEAD: ${qualHint} (INCORPORE nas instruções com 'por que' cada um importa pra qualificação)` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // F36 (Pedro 2026-05-28): system prompt reforçado pra obrigar discernimento.
  // Antes o LLM caía em saída genérica/cópia do purpose. Agora:
  //  - exemplos explícitos do que é "bom" vs "ruim" (incorporar contexto)
  //  - guia de tone por tipo de propósito (urgente/consultivo/criativo)
  //  - intake mode tem que reverberar nas instruções (não só ser citado)
  //  - identity_name obrigatório se brief tem nome
  //  - language hint pra adaptar style do canal
  const system =
    `Você monta a 'mente' de um agente de IA que conversa com ${audienceNoun} de uma agência de seguros no WhatsApp/Instagram, em português do Brasil. ` +
    (isRec ? "É um agente de RECRUTAMENTO: tria e atrai candidatos pra virarem corretores, agenda entrevistas. " : "") +
    "A partir do brief, escreva a configuração final. Regras: \n" +
    "(1) custom_instructions: 2-4 parágrafos ricos e ESPECÍFICOS, na 2ª pessoa ('Você é...'), incorporando:\n" +
    "    a) COMO O LEAD CHEGA (intake mode + tags/keyword/stage) — reconheça esse padrão na conversa, não só cite.\n" +
    "    b) O QUE VOCÊ OFERECE (propósito) — elabore, não copie literalmente o brief.\n" +
    "    c) O QUE DESCOBRIR — explique POR QUE cada info importa pra qualificação.\n" +
    "    Exemplo RUIM: 'Você qualifica contatos. Descubra idade, cidade.'\n" +
    "    Exemplo BOM: 'Você atende contatos vindos do feirão 2026 — eles já demonstraram interesse em seguro de vida. Comece reconhecendo isso, sem vender frio. Qualifique idade (define faixa de risco), cidade (cobertura local) e se já tem outro seguro (entender concorrência).' \n" +
    "(2) qualification_fields: 3-6 campos. type: text/date/boolean/select. \n" +
    "(3) tone: 4 eixos 0-100 (creativity, formality, naturalness, assertiveness) ESPECÍFICOS ao propósito. \n" +
    "    - Cobrança/urgência → assertiveness ≥70.\n" +
    "    - Consultivo/explicativo → naturalness ≥85, formality 40-60.\n" +
    "    - Criativo/viral → creativity ≥75.\n" +
    "    - Default morno (50-60 em tudo) só se realmente não há sinal — EVITE. \n" +
    "(4) name: nome curto do agente (aparece no Spark Leads). purpose_summary: 1 frase. \n" +
    "(5) identity_name: APENAS o primeiro nome que o agente usa pra se apresentar, extraído do brief. " +
    "Se a pessoa escreveu algo como 'eu mesmo, Pedro' ou 'me chama de Bia', extraia só 'Pedro'/'Bia'. Se não houver nome, deixe vazio. \n" +
    "(6) persona_description: 1-2 frases sobre personalidade ESPECÍFICA ao propósito (ex: 'Consultora experiente, paciente mas direta'). NUNCA genérico tipo 'agente prestativo'. \n" +
    "(7) greeting_style: 1 frase descrevendo como cumprimenta (ex: 'Puxa o nome do contato e mostra entusiasmo pela demanda específica que ele tem'). \n" +
    "(8) farewell_style: 1 frase descrevendo como se despede (ex: 'Reforça o próximo passo combinado e deixa link/contato'). \n" +
    "(9) conversation_examples: 2 trocas curtas no estilo do agente, formato 'Lead: ...\\nAgente: ...' separadas por linha em branco. Use placeholders {first_name} se fizer sentido. \n" +
    "NUNCA escreva 'GHL' nem 'GoHighLevel' — o CRM se chama 'Spark Leads'. NÃO invente fatos que não estão no brief. NÃO devolva campos vazios. NÃO copie o purpose como custom_instructions — ELABORE. " +
    'Responda SÓ um JSON: {"name":string,"identity_name":string,"purpose_summary":string,"custom_instructions":string,"qualification_fields":[{"label":string,"type":string,"required":boolean}],"tone":{"creativity":number,"formality":number,"naturalness":number,"assertiveness":number},"persona_description":string,"greeting_style":string,"farewell_style":string,"conversation_examples":string}';

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

    // F36 (Pedro 2026-05-28): validação anti-cópia. Se LLM devolveu instruções
    // ≤ purpose ou cópia literal, enriquece com contexto do brief. Antes
    // saída xerox passava direto e agent nascia sem personalidade.
    const rawInstructions = String(parsed.custom_instructions || "").trim();
    const isXeroxOfPurpose =
      !rawInstructions ||
      rawInstructions === purpose ||
      rawInstructions.length < Math.max(80, purpose.length);
    const enrichedInstructions = isXeroxOfPurpose
      ? `Você é ${identity.mode === "human" ? "uma pessoa do time" : "uma assistente virtual"}${identity.name ? ` chamada ${identity.name}` : ""} dedicada a ${purpose}. ` +
        `${INTAKE_LABEL[intakeMode] ? `${INTAKE_LABEL[intakeMode].charAt(0).toUpperCase()}${INTAKE_LABEL[intakeMode].slice(1)}. ` : ""}` +
        `${qualHint ? `Pra qualificar bem, descubra: ${qualHint}. Explique pro lead por que cada info importa antes de pedir. ` : ""}` +
        `Seja natural, consultivo, e revele valor antes de pedir dados. NUNCA mencione 'Spark Leads' nem GHL pro lead.`
      : rawInstructions;

    // F36: fallback smart pra os 4 campos de personality quando LLM omite.
    const safeName = identity.name ? `chamada ${String(identity.name)}` : "";
    const persona = String(parsed.persona_description || "").trim() ||
      `Agente ${isRec ? "de recrutamento" : "consultivo"} ${safeName}, ${purpose.length > 100 ? purpose.slice(0, 100) + "…" : purpose}.`;
    const greeting = String(parsed.greeting_style || "").trim() ||
      `Cumprimenta com entusiasmo e puxa o nome do contato quando disponível.`;
    const farewell = String(parsed.farewell_style || "").trim() ||
      `Despede confirmando o próximo passo combinado.`;

    return NextResponse.json({
      name: String(parsed.name || "").slice(0, 120) || "Agente personalizado",
      identity_name: String(parsed.identity_name || identity.name || "").slice(0, 80),
      purpose_summary: String(parsed.purpose_summary || "").slice(0, 600) || purpose.slice(0, 200),
      custom_instructions: enrichedInstructions.slice(0, 8000),
      qualification_fields,
      tone: {
        creativity: clampN(tone.creativity, 60),
        formality: clampN(tone.formality, 50),
        naturalness: clampN(tone.naturalness, 80),
        assertiveness: clampN(tone.assertiveness, 50),
      },
      persona_description: persona.slice(0, 2000),
      greeting_style: greeting.slice(0, 2000),
      farewell_style: farewell.slice(0, 2000),
      conversation_examples: String(parsed.conversation_examples || "").slice(0, 8000),
      degraded_anti_xerox: isXeroxOfPurpose, // sinal pra debug — composer "morno"
    });
  } catch (err) {
    console.warn("[builder/compose] fallback:", err instanceof Error ? err.message : err);
    // Sweep F49 2026-06-05: builder de agente custom (pago) degradou — usuário
    // recebe agente cru (purpose vira instrução). Editável no detail-view, mas
    // queremos saber a frequência pra não vender experiência morna.
    reportError({ title: "Builder compose: IA falhou (fallback degradado)", feature: "agent-platform-compose", severity: "medium", error: err });
    // Falha graciosa: usa o purpose cru como instruções; sem campos sugeridos.
    return NextResponse.json({
      name: "Agente personalizado",
      identity_name: "",
      purpose_summary: purpose.slice(0, 200),
      custom_instructions: purpose,
      qualification_fields: [],
      tone: { creativity: 60, formality: 50, naturalness: 80, assertiveness: 50 },
      // Defaults pra os 4 novos (Pedro 2026-05-28); detail-view permite editar.
      persona_description: "",
      greeting_style: "",
      farewell_style: "",
      conversation_examples: "",
      degraded: true,
    });
  }
}
