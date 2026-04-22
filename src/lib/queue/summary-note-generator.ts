import OpenAI from "openai";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";

const INACTIVITY_MINUTES = 30;
const MIN_MESSAGES_FOR_NOTE = 3;

interface SummaryParams {
  agentId: string;
  locationId: string;
  contactId: string;
  conversationId: string;
  companyId: string;
  triggerReason: string;
  aiModel: string;
}

export async function generateSummaryNote(params: SummaryParams): Promise<void> {
  const supabase = createAdminClient();

  console.log(`[SummaryNote] Starting for contact=${params.contactId} trigger=${params.triggerReason}`);

  // 1. Buscar estado atual da conversa
  const { data: currentState } = await supabase
    .from("conversation_state")
    .select("message_count, collected_data, segment_number, status, summary_note_id")
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .maybeSingle();

  console.log(`[SummaryNote] State: msgs=${currentState?.message_count} status=${currentState?.status} note_id=${currentState?.summary_note_id}`);

  // Dedup: já tem nota ou está gerando
  if (currentState?.summary_note_id) {
    console.log(`[SummaryNote] Skipped: note already exists (${currentState.summary_note_id})`);
    return;
  }

  // Sem conversation_state = nada a resumir
  if (!currentState) {
    console.log(`[SummaryNote] Skipped: no conversation_state for ${params.contactId}`);
    return;
  }

  // Marcar como generating (lock)
  await supabase
    .from("conversation_state")
    .update({ summary_note_id: "generating", updated_at: new Date().toISOString() })
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId);

  const lockResult = currentState;

  try {
    // 2. Buscar agent config para nome, tipo e toggle
    const { data: agent } = await supabase
      .from("agents")
      .select("name, type, agent_configs(personality, data_fields, enable_summary_notes)")
      .eq("id", params.agentId)
      .maybeSingle();

    const config = Array.isArray(agent?.agent_configs)
      ? agent.agent_configs[0]
      : agent?.agent_configs;

    // Verificar toggle — se desabilitado, liberar lock e sair
    const toggleValue = (config as Record<string, unknown>)?.enable_summary_notes;
    console.log(`[SummaryNote] Toggle check: enable_summary_notes=${toggleValue} agent=${params.agentId}`);
    if (!toggleValue) {
      console.log(`[SummaryNote] Skipped: toggle OFF for agent ${params.agentId}`);
      await supabase.from("conversation_state").update({ summary_note_id: null }).eq("agent_id", params.agentId).eq("contact_id", params.contactId);
      return;
    }

    const agentName = (config?.personality as Record<string, string>)?.name || agent?.name || "Agente IA";
    const agentType = agent?.type === "recruitment_agent" ? "recrutamento" : "vendas";

    // 3. Buscar histórico de conversa do GHL
    const ghlClient = new GHLClient(params.companyId, params.locationId);
    let conversationHistory = "";
    let contactName = params.contactId.substring(0, 12);

    try {
      const searchResult = await ghlClient.get<{ conversations: { id: string }[] }>(
        "/conversations/search",
        { locationId: params.locationId, contactId: params.contactId }
      );

      if (searchResult.conversations?.[0]?.id) {
        const convId = searchResult.conversations[0].id;
        const messagesResult = await ghlClient.get<{ messages: { messages: { body: string; direction: string; dateAdded: string }[] } }>(
          `/conversations/${convId}/messages`,
          { locationId: params.locationId }
        );

        const messages = messagesResult.messages?.messages || [];
        conversationHistory = messages
          .filter((m) => m.body)
          .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime())
          .slice(-40)
          .map((m) => `${m.direction === "inbound" ? "CONTATO" : "AGENTE"}: ${m.body.substring(0, 500)}`)
          .join("\n");
      }

      // Buscar nome do contato
      const contactResult = await ghlClient.get<{ contact: { name?: string; firstName?: string } }>(`/contacts/${params.contactId}`);
      contactName = contactResult.contact?.name || contactResult.contact?.firstName || contactName;
    } catch (err) {
      console.error("[SummaryNote] Error fetching GHL data:", err instanceof Error ? err.message : err);
    }

    const collectedData = (lockResult.collected_data || {}) as Record<string, string>;

    // 4. Montar dados coletados dinâmicos a partir do config
    const dataFields = (config?.data_fields || []) as { key: string; label: string }[];
    const collectedDisplay = dataFields
      .filter((f) => collectedData[f.key])
      .map((f) => `- ${f.label}: ${collectedData[f.key]}`);

    // Adicionar campos que não estão no config mas foram coletados
    for (const [k, v] of Object.entries(collectedData)) {
      if (!dataFields.some((f) => f.key === k) && v && !k.startsWith("contact.")) {
        collectedDisplay.push(`- ${k}: ${v}`);
      }
    }

    // 5. Mapear razão do trigger
    const triggerLabels: Record<string, string> = {
      inactivity: "Inatividade (30 minutos sem interação)",
      booked: "Agendamento realizado com sucesso",
      qualified: "Lead qualificado (todos os dados coletados)",
      disqualified: "Lead desqualificado",
      handed_off: "Conversa transferida para humano",
      "auto_pause:human_message": "Humano assumiu o atendimento",
      opt_out: "Contato solicitou parar de receber mensagens",
    };
    const triggerDisplay = triggerLabels[params.triggerReason] || params.triggerReason;

    // 6. Gerar resumo via IA
    const summaryPrompt = `Você é um escritor profissional de notas de CRM. Gere um resumo estruturado da conversa abaixo entre o agente de ${agentType} "${agentName}" e o contato "${contactName}".

A conversa foi encerrada por: ${triggerDisplay}

HISTÓRICO DA CONVERSA:
${conversationHistory || "(sem histórico disponível)"}

DADOS COLETADOS:
${collectedDisplay.length > 0 ? collectedDisplay.join("\n") : "(nenhum dado coletado)"}

STATUS FINAL: ${lockResult.status || "active"}

Gere um JSON com o campo "note_html" contendo HTML formatado com estas 4 seções:
1. 💬 Resumo da Conversa — 2-3 frases sobre o que foi discutido
2. 📊 Dados Coletados — lista com os dados obtidos (use os que foram fornecidos acima)
3. 🏁 Conclusão — como e por que a conversa encerrou
4. 👉 Próximos Passos — 1-2 recomendações acionáveis para a equipe humana

Regras:
- Escreva de forma profissional e concisa
- Use HTML: h4, p, ul, li, strong (sem CSS/style)
- Máximo 400 palavras
- Escreva no idioma da conversa (português se pt-BR)
- Retorne APENAS JSON válido: { "note_html": "<conteúdo>" }`;

    // 6b. Chamar OpenAI diretamente (não usa processWithAI porque o parser
    //     desse módulo extrai "message" e descarta "note_html")
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 30000 });
    console.log(`[SummaryNote] Calling AI for summary (model: ${params.aiModel})`);

    const completion = await openai.chat.completions.create({
      model: params.aiModel.startsWith("claude") ? "gpt-4.1-mini" : params.aiModel,
      messages: [
        { role: "system", content: summaryPrompt },
        { role: "user", content: "Gere o resumo agora." },
      ],
      temperature: 0.5,
      max_tokens: 1500,
      response_format: { type: "json_object" },
    });

    const rawResponse = completion.choices[0]?.message?.content || "";
    console.log(`[SummaryNote] AI response (${rawResponse.length} chars): "${rawResponse.substring(0, 100)}..."`);

    // 7. Extrair HTML da resposta
    let noteHtml = "";
    try {
      const parsed = JSON.parse(rawResponse);
      noteHtml = parsed.note_html || parsed.html || parsed.note || parsed.content || "";
    } catch {
      // Se não parseou JSON, tentar extrair HTML direto
      const htmlMatch = rawResponse.match(/<(?:div|h[1-6]|p|ul)[\s\S]*<\/(?:div|h[1-6]|p|ul)>/i);
      noteHtml = htmlMatch ? htmlMatch[0] : rawResponse.replace(/```html?/g, "").replace(/```/g, "").trim();
    }

    if (!noteHtml) {
      console.error(`[SummaryNote] Empty note from AI. Raw: "${rawResponse.substring(0, 300)}"`);
      throw new Error("IA retornou nota vazia");
    }

    console.log(`[SummaryNote] Note HTML extracted (${noteHtml.length} chars)`);

    // 8. Montar nota completa com header de metadata
    const now = new Date();
    const dateStr = now.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
    const segmentNum = lockResult.segment_number || 1;

    const fullNote = `<div>
<h3>📋 Resumo de Atendimento por IA</h3>
<p><strong>Agente:</strong> ${agentName} | <strong>Data:</strong> ${dateStr} | <strong>Mensagens:</strong> ${lockResult.message_count || 0} | <strong>Motivo:</strong> ${triggerDisplay}</p>
<hr>
${noteHtml}
<br>
<p><em>Gerado automaticamente por Spark AI • Segmento #${segmentNum}</em></p>
</div>`;

    // 9. Criar nota no GHL
    console.log(`[SummaryNote] Posting note to GHL: /contacts/${params.contactId}/notes (${fullNote.length} chars)`);
    let noteId = `note_${Date.now()}`;
    try {
      const noteResult = await ghlClient.post<{ note?: { id: string }; id?: string }>(`/contacts/${params.contactId}/notes`, {
        body: fullNote,
        userId: undefined,
      });
      noteId = noteResult.note?.id || noteResult.id || noteId;
      console.log(`[SummaryNote] GHL note created: ${noteId}`);
    } catch (ghlErr) {
      console.error(`[SummaryNote] GHL Notes API error:`, ghlErr instanceof Error ? ghlErr.message : ghlErr);
      // Tentar sem HTML (plain text fallback)
      try {
        const plainNote = fullNote.replace(/<[^>]+>/g, "").replace(/&[a-z]+;/g, "").trim();
        console.log(`[SummaryNote] Retrying with plain text (${plainNote.length} chars)`);
        const retryResult = await ghlClient.post<{ note?: { id: string }; id?: string }>(`/contacts/${params.contactId}/notes`, {
          body: plainNote,
        });
        noteId = retryResult.note?.id || retryResult.id || noteId;
        console.log(`[SummaryNote] GHL note created (plain text): ${noteId}`);
      } catch (retryErr) {
        console.error(`[SummaryNote] GHL Notes API retry failed:`, retryErr instanceof Error ? retryErr.message : retryErr);
        throw retryErr;
      }
    }

    // 10. Atualizar conversation_state com o ID da nota
    await supabase
      .from("conversation_state")
      .update({
        summary_note_id: noteId,
        summary_note_created_at: now.toISOString(),
        updated_at: now.toISOString(),
      })
      .eq("agent_id", params.agentId)
      .eq("contact_id", params.contactId);

    // 11. Log
    await supabase.from("execution_log").insert({
      agent_id: params.agentId,
      location_id: params.locationId,
      contact_id: params.contactId,
      conversation_id: params.conversationId,
      action_type: "summary_note_created",
      action_payload: {
        trigger: params.triggerReason,
        segment: segmentNum,
        note_id: noteId,
        tokens: (completion.usage?.prompt_tokens || 0) + (completion.usage?.completion_tokens || 0),
      },
      success: true,
    });

    console.log(`[SummaryNote] Created for ${params.contactId} (trigger: ${params.triggerReason}, segment: ${segmentNum})`);
  } catch (error) {
    console.error("[SummaryNote] Error:", error instanceof Error ? error.message : error);

    // Reset lock para permitir retry
    await supabase
      .from("conversation_state")
      .update({ summary_note_id: null })
      .eq("agent_id", params.agentId)
      .eq("contact_id", params.contactId)
      .eq("summary_note_id", "generating");

    await supabase.from("execution_log").insert({
      agent_id: params.agentId,
      location_id: params.locationId,
      contact_id: params.contactId,
      action_type: "summary_note_created",
      action_payload: { trigger: params.triggerReason, error: error instanceof Error ? error.message : String(error) },
      success: false,
      error_message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Scanner de inatividade — chamado pelo cron a cada 5 minutos.
 * Busca conversas ativas sem nota que estão paradas há 30+ minutos.
 */
export async function processInactivitySummaries(): Promise<{ generated: number; errors: number }> {
  const supabase = createAdminClient();
  let generated = 0;
  let errors = 0;

  const cutoff = new Date(Date.now() - INACTIVITY_MINUTES * 60 * 1000).toISOString();

  // Buscar conversas inativas
  const { data: inactive } = await supabase
    .from("conversation_state")
    .select("agent_id, location_id, contact_id, conversation_id")
    .eq("status", "active")
    .is("summary_note_id", null)
    .lt("last_ai_response_at", cutoff)
    .not("last_ai_response_at", "is", null)
    .gte("message_count", MIN_MESSAGES_FOR_NOTE)
    .limit(10);

  if (!inactive || inactive.length === 0) return { generated: 0, errors: 0 };

  // Limpar locks órfãos (generating há mais de 10 min)
  const lockCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  await supabase
    .from("conversation_state")
    .update({ summary_note_id: null })
    .eq("summary_note_id", "generating")
    .lt("updated_at", lockCutoff);

  for (const conv of inactive) {
    try {
      // Buscar agent para model config
      const { data: agent } = await supabase
        .from("agents")
        .select("id, agent_configs(ai_model)")
        .eq("id", conv.agent_id)
        .eq("status", "active")
        .maybeSingle();

      if (!agent) continue;

      const agentConfig = Array.isArray(agent.agent_configs)
        ? agent.agent_configs[0]
        : agent.agent_configs;

      // Buscar location para company_id
      const { data: location } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", conv.location_id)
        .single();

      if (!location) continue;

      await generateSummaryNote({
        agentId: conv.agent_id,
        locationId: conv.location_id,
        contactId: conv.contact_id,
        conversationId: conv.conversation_id || "",
        companyId: location.company_id,
        triggerReason: "inactivity",
        aiModel: (agentConfig as Record<string, string>)?.ai_model || "gpt-4.1-mini",
      });

      generated++;
    } catch (err) {
      console.error(`[SummaryNote:cron] Error for ${conv.contact_id}:`, err instanceof Error ? err.message : err);
      errors++;
    }
  }

  if (generated > 0 || errors > 0) {
    console.log(`[SummaryNote:cron] Generated: ${generated}, Errors: ${errors}`);
  }

  return { generated, errors };
}
