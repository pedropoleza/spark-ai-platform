import OpenAI from "openai";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";
import { GHLClient } from "@/lib/ghl/client";
import { trackAndCharge } from "@/lib/billing/charge";

const INACTIVITY_MINUTES = 30;

interface SummaryParams {
  agentId: string;
  locationId: string;
  contactId: string;
  conversationId: string;
  companyId: string;
  triggerReason: string;
  aiModel: string;
}

/**
 * Gera uma nota de resumo no contato do GHL ao fim de um segmento de conversa.
 */
export async function generateSummaryNote(params: SummaryParams): Promise<void> {
  const supabase = createAdminClient();
  const tag = `[SummaryNote:${params.contactId.substring(0, 8)}]`;

  console.log(`${tag} === STARTING === trigger=${params.triggerReason}`);

  // 1. Verificar conversation_state
  const { data: convState } = await supabase
    .from("conversation_state")
    .select("*")
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .maybeSingle();

  if (!convState) {
    console.log(`${tag} SKIP: no conversation_state`);
    return;
  }

  if (convState.summary_note_id && convState.summary_note_id !== "generating") {
    console.log(`${tag} SKIP: note already exists (${convState.summary_note_id})`);
    return;
  }

  // 1b. Atomic lock — só continua se conseguir setar "generating"
  const { data: locked } = await supabase
    .from("conversation_state")
    .update({ summary_note_id: "generating", updated_at: new Date().toISOString() })
    .eq("agent_id", params.agentId)
    .eq("contact_id", params.contactId)
    .is("summary_note_id", null)
    .select("agent_id")
    .maybeSingle();

  if (!locked) {
    console.log(`${tag} SKIP: lock failed (another process grabbed it)`);
    return;
  }

  // 2. Verificar toggle do agente
  const { data: agent } = await supabase
    .from("agents")
    .select("name, type, agent_configs(enable_summary_notes, personality, data_fields, ai_model)")
    .eq("id", params.agentId)
    .maybeSingle();

  const agentConfig = Array.isArray(agent?.agent_configs) ? agent.agent_configs[0] : agent?.agent_configs;

  if (!agentConfig) {
    console.log(`${tag} SKIP: no agent config`);
    return;
  }

  const cfg = agentConfig as Record<string, unknown>;
  if (!cfg.enable_summary_notes) {
    console.log(`${tag} SKIP: toggle OFF (enable_summary_notes=${cfg.enable_summary_notes})`);
    return;
  }

  try {
    const personality = (cfg.personality || {}) as Record<string, string>;
    const agentName = personality.name || agent?.name || "Agente IA";
    const agentType = agent?.type === "recruitment_agent" ? "recrutamento" : "vendas";
    const dataFields = (cfg.data_fields || []) as { key: string; label: string }[];
    const collectedData = (convState.collected_data || {}) as Record<string, string>;

    // 4. Buscar histórico do GHL
    const ghlClient = new GHLClient(params.companyId, params.locationId);
    let history = "";
    let contactName = params.contactId.substring(0, 12);

    try {
      const search = await ghlClient.get<{ conversations: { id: string }[] }>(
        "/conversations/search",
        { locationId: params.locationId, contactId: params.contactId }
      );
      const convId = search.conversations?.[0]?.id;
      if (convId) {
        const msgs = await ghlClient.get<{ messages: { body: string; direction: string; dateAdded: string }[] }>(
          `/conversations/${convId}/messages`, { locationId: params.locationId }
        );
        history = (msgs.messages || [])
          .filter((m) => m.body)
          .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime())
          .slice(-30)
          .map((m) => `${m.direction === "inbound" ? "CONTATO" : "AGENTE"}: ${m.body.substring(0, 400)}`)
          .join("\n");
      }

      const contact = await ghlClient.get<{ contact: { name?: string; firstName?: string } }>(`/contacts/${params.contactId}`);
      contactName = contact.contact?.name || contact.contact?.firstName || contactName;
    } catch (e) {
      console.warn(`${tag} GHL fetch partial fail:`, e instanceof Error ? e.message : e);
    }

    // 5. Montar dados coletados (dinâmico)
    const collectedLines = dataFields
      .filter((f) => collectedData[f.key])
      .map((f) => `• ${f.label}: ${collectedData[f.key]}`);
    for (const [k, v] of Object.entries(collectedData)) {
      if (!dataFields.some((f) => f.key === k) && v && !k.startsWith("contact.")) {
        collectedLines.push(`• ${k}: ${v}`);
      }
    }

    // 6. Trigger label
    const triggers: Record<string, string> = {
      inactivity: "Inatividade (30 min sem interação)",
      booked: "Agendamento realizado",
      qualified: "Lead qualificado",
      disqualified: "Lead desqualificado",
      handed_off: "Transferido para humano",
      manual: "Geração manual",
    };

    // 7. Chamar OpenAI diretamente
    console.log(`${tag} Calling OpenAI for summary...`);
    const model = params.aiModel.startsWith("claude") ? "gpt-4.1-mini" : params.aiModel;
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 25000 });

    const completion = await openai.chat.completions.create({
      model,
      messages: [
        {
          role: "system",
          content: `Gere um resumo profissional de atendimento. Responda APENAS com JSON: { "note_html": "<html>" }
O HTML deve ter 3 seções com h4: Resumo da Conversa, Dados Coletados, Próximos Passos.
Use tags: h4, p, ul, li, strong. Sem CSS. Máximo 250 palavras. Idioma: português.`,
        },
        {
          role: "user",
          content: `Agente: ${agentName} (${agentType})
Contato: ${contactName}
Motivo do encerramento: ${triggers[params.triggerReason] || params.triggerReason}
Status: ${convState.status}

Dados coletados:
${collectedLines.length > 0 ? collectedLines.join("\n") : "(nenhum)"}

Histórico:
${history || "(sem histórico disponível)"}

Gere o resumo agora.`,
        },
      ],
      temperature: 0.4,
      max_tokens: 1200,
      response_format: { type: "json_object" },
    });

    const raw = completion.choices[0]?.message?.content || "";
    console.log(`${tag} OpenAI response: ${raw.length} chars`);

    // C3: cobrar o uso do summary-note-generator. Antes deste fix rodava 100%
    // free. Custo típico ~$0.003/note × 100 notes/dia/location = $9/mês/loc.
    // BYO key check: se location tem própria OPENAI_API_KEY, marca uses_custom_key.
    let summaryUsesCustomKey = false;
    try {
      const { data: ls } = await supabase
        .from("location_settings")
        .select("openai_api_key")
        .eq("location_id", params.locationId)
        .maybeSingle();
      summaryUsesCustomKey = !!ls?.openai_api_key;
    } catch { /* location_settings ausente — sem BYO key */ }

    try {
      await trackAndCharge({
        locationId: params.locationId,
        companyId: params.companyId,
        agentId: params.agentId,
        contactId: params.contactId,
        actionType: "summary_note",
        model,
        promptTokens: completion.usage?.prompt_tokens ?? 0,
        completionTokens: completion.usage?.completion_tokens ?? 0,
        cachedTokens: (completion.usage as { prompt_tokens_details?: { cached_tokens?: number } } | undefined)
          ?.prompt_tokens_details?.cached_tokens ?? 0,
        usesCustomKey: summaryUsesCustomKey,
      });
    } catch (e) {
      console.error(`${tag} Billing failed (non-blocking):`, e instanceof Error ? e.message : e);
    }

    // 8. Extrair HTML
    let noteHtml = "";
    try {
      const parsed = JSON.parse(raw);
      noteHtml = parsed.note_html || parsed.html || parsed.note || "";
    } catch {
      noteHtml = raw.replace(/```html?/g, "").replace(/```/g, "").trim();
    }

    if (!noteHtml || noteHtml.length < 20) {
      console.error(`${tag} Note too short or empty. Raw: ${raw.substring(0, 200)}`);
      throw new Error("Nota gerada vazia");
    }

    // 9. Montar nota final
    const dateStr = new Date().toLocaleString("pt-BR", { timeZone: "America/New_York" });
    const segment = convState.segment_number || 1;

    const fullNote = [
      `<h3>📋 Resumo de Atendimento — Spark AI Hub</h3>`,
      `<p><strong>Agente:</strong> ${agentName} | <strong>Data:</strong> ${dateStr} | <strong>Motivo:</strong> ${triggers[params.triggerReason] || params.triggerReason}</p>`,
      `<hr>`,
      noteHtml,
      `<br><p><em>Gerado por Spark AI Hub • Segmento #${segment}</em></p>`,
    ].join("\n");

    // 10. Postar no GHL
    console.log(`${tag} Posting to GHL Notes API...`);
    let noteId = `local_${Date.now()}`;
    try {
      const result = await ghlClient.post<Record<string, unknown>>(`/contacts/${params.contactId}/notes`, {
        body: fullNote,
      });
      noteId = String((result as Record<string, unknown>).id || (result as Record<string, { id: string }>).note?.id || noteId);
      console.log(`${tag} GHL note created: ${noteId}`);
    } catch (ghlErr) {
      console.error(`${tag} GHL Notes error:`, ghlErr instanceof Error ? ghlErr.message : ghlErr);
      // Tentar plain text
      const plain = fullNote.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      try {
        const r2 = await ghlClient.post<Record<string, unknown>>(`/contacts/${params.contactId}/notes`, { body: plain });
        noteId = String((r2 as Record<string, unknown>).id || noteId);
        console.log(`${tag} GHL note created (plain): ${noteId}`);
      } catch (e2) {
        console.error(`${tag} GHL Notes plain text also failed:`, e2 instanceof Error ? e2.message : e2);
        throw e2;
      }
    }

    // 11. Salvar e logar
    // NB-8 (review 2026-06-10): guarda .eq("summary_note_id","generating") espelha
    // o reset do catch-path (bloco catch abaixo) — só grava o noteId se ESTE
    // processo ainda detém o lock. Se um segment-reset concorrente
    // (action-executor.updateConversationState: summary_note_id→null + novo
    // segmento, dispara só em noteId REAL) já moveu a row, o UPDATE casa 0 linhas:
    // a nota no GHL JÁ foi criada (side-effect preservado), então só logamos e NÃO
    // reescrevemos summary_note_id (evita clobber do reset). Defesa-em-profundidade,
    // não bug vivo: hoje o lock atômico (L47, null→"generating") + o reset só
    // disparar em noteId real já impedem o cenário.
    const { data: savedState } = await supabase
      .from("conversation_state")
      .update({ summary_note_id: noteId, summary_note_created_at: new Date().toISOString() })
      .eq("agent_id", params.agentId)
      .eq("contact_id", params.contactId)
      .eq("summary_note_id", "generating")
      .select("agent_id")
      .maybeSingle();

    const stateWritten = !!savedState;
    if (!stateWritten) {
      console.warn(`${tag} state write skipped: lock já movido (segment reset concorrente?) — nota GHL ${noteId} preservada`);
    }

    await supabase.from("execution_log").insert({
      agent_id: params.agentId,
      location_id: params.locationId,
      contact_id: params.contactId,
      action_type: "summary_note_created",
      action_payload: { trigger: params.triggerReason, segment, note_id: noteId, state_written: stateWritten },
      success: true,
    });

    console.log(`${tag} === DONE === note=${noteId}`);
  } catch (error) {
    console.error(`${tag} === FAILED ===`, error instanceof Error ? error.message : error);

    // Reset lock
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
 * Scanner de inatividade — chamado pelo cron.
 */
export async function processInactivitySummaries(): Promise<{ generated: number; errors: number }> {
  const supabase = createAdminClient();
  let generated = 0;
  let errors = 0;

  const cutoff = new Date(Date.now() - INACTIVITY_MINUTES * 60 * 1000).toISOString();

  // Limpar locks órfãos
  await supabase
    .from("conversation_state")
    .update({ summary_note_id: null })
    .eq("summary_note_id", "generating")
    .lt("updated_at", new Date(Date.now() - 10 * 60 * 1000).toISOString());

  const { data: inactive } = await supabase
    .from("conversation_state")
    .select("agent_id, location_id, contact_id, conversation_id")
    .eq("status", "active")
    .is("summary_note_id", null)
    .lt("last_ai_response_at", cutoff)
    .not("last_ai_response_at", "is", null)
    .limit(10);

  if (!inactive || inactive.length === 0) return { generated: 0, errors: 0 };

  for (const conv of inactive) {
    try {
      const { data: ag } = await supabase
        .from("agents")
        .select("id, agent_configs(ai_model)")
        .eq("id", conv.agent_id)
        .eq("status", "active")
        .maybeSingle();
      if (!ag) continue;

      const { data: loc } = await supabase
        .from("locations")
        .select("company_id")
        .eq("location_id", conv.location_id)
        .single();
      if (!loc) continue;

      const acfg = Array.isArray(ag.agent_configs) ? ag.agent_configs[0] : ag.agent_configs;

      await generateSummaryNote({
        agentId: conv.agent_id,
        locationId: conv.location_id,
        contactId: conv.contact_id,
        conversationId: conv.conversation_id || "",
        companyId: loc.company_id,
        triggerReason: "inactivity",
        aiModel: (acfg as Record<string, string>)?.ai_model || "gpt-4.1-mini",
      });
      generated++;
    } catch (err) {
      errors++;
      // Sweep F49 2026-06-05: nota-resumo de inatividade não gerada (interno).
      reportError({ title: "Summary note generator: geração falhou", feature: "summary-note-runner", severity: "low", error: err });
    }
  }

  return { generated, errors };
}
