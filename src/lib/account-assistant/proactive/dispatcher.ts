/**
 * Dispatcher de regras de proatividade do Sparkbot.
 *
 * Recebe { rule, rep, contextData } e:
 *   1. Verifica enabled, quiet_hours, cooldown
 *   2. Monta prompt: persona Sparkbot + rule.prompt_instruction + contextData
 *   3. Filtra tools_allowed
 *   4. Roda LLM com tool-calling (igual processor de pedido normal)
 *   5. Resultado:
 *        - mode='simulated': insere agent_test_messages com badge especial
 *        - mode='real':      manda via GHL conversations/messages (V3+)
 *   6. Atualiza assistant_alert_state (cooldown + métricas)
 *
 * Mesma lógica é compartilhada por:
 *   - Reactive triggers (webhook ou cron polling detecta evento)
 *   - Scheduled triggers (cron)
 *   - Botão "Simular agora" no UI
 */

import { GHLClient } from "@/lib/ghl/client";
import { trackAndCharge } from "@/lib/billing/charge";
import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";
import { recordSignalAsync } from "@/lib/admin-signals/recorder";
import { loadSilenceDecision, recordProactiveSent } from "./silence-gate";
import type { LLMMessage } from "../llm-client";
import { type ToolContext } from "../tools";
import { runSparkbotTurn, buildToolCtx } from "../core/run-sparkbot-turn";
import { buildSparkbotSystemPrompt, buildSparkbotRuntimeContext, loadCarrierTier1 } from "../prompt-builder";
import type {
  ProactiveRule,
  RepIdentity,
  AlertDispatchStatus,
  AccountAssistantConfigExtras,
} from "@/types/account-assistant";

export interface DispatchInput {
  rule: ProactiveRule;
  rep: RepIdentity;
  /** ID da entidade GHL relevante (appointment_id, opp_id, task_id) — pra cooldown granular. */
  targetId?: string | null;
  /** Contexto que o trigger forneceu pra IA usar no prompt (descrição livre + dados). */
  contextData: Record<string, unknown>;
  /** 'simulated' = insere no chat de teste; 'real' = envia via WhatsApp (V3+). */
  mode: "simulated" | "real";
  /** Pra modo simulated: session_id da aba de teste onde a msg deve aparecer. */
  testSessionId?: string;
  /** Bypass cooldown/quiet-hours (usado pelo botão "Simular agora"). */
  forceFire?: boolean;
  /**
   * Override da location ativa do rep pra esse dispatch. Usado por triggers
   * que detectam evento numa location ESPECÍFICA (ex: post_meeting num
   * appointment de location não-ativa). Quando setado, tools rodam contra
   * essa location (get_contact busca lá), billing também vai pra ela.
   * Se omitido, usa rep.active_location_id como antes.
   */
  overrideLocationId?: string;
}

export interface DispatchResult {
  status: AlertDispatchStatus;
  message?: string;
  text_generated?: string;
  tools_used?: string[];
  tokens?: { prompt: number; completion: number; cached: number };
  duration_ms?: number;
}

/**
 * Verifica se está em quiet_hours. Lógica:
 *   - Se enabled=false → não tá em quiet hours (always ok)
 *   - Compara hora atual no timezone do quiet_hours.timezone com janela start-end
 *   - Verifica se dia da semana está incluso em days[]
 */
/**
 * Verifica se um timezone IANA é válido (existe na lib do JS). Se inválido
 * (ex: typo "America/New_Yok"), DateTimeFormat construtor lança RangeError.
 */
function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function isInQuietHours(
  config: AccountAssistantConfigExtras["quiet_hours"] | undefined,
): boolean {
  if (!config || !("enabled" in config) || !config.enabled) return false;
  let tz = config.timezone || "America/New_York";
  if (!isValidTimezone(tz)) {
    console.error(
      `[dispatcher] timezone inválido em quiet_hours: "${tz}". Fallback America/New_York.`,
    );
    tz = "America/New_York";
  }
  const start = config.start || "22:00";
  const end = config.end || "07:00";
  const days = config.days || [0, 1, 2, 3, 4, 5, 6];

  const now = new Date();
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
  const parts = fmt.formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const weekdayMap: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  const weekday = weekdayMap[get("weekday")] ?? 0;
  if (!days.includes(weekday)) return false;

  const hour = parseInt(get("hour")) || 0;
  const minute = parseInt(get("minute")) || 0;
  const nowMin = hour * 60 + minute;
  const [sH, sM] = start.split(":").map(Number);
  const [eH, eM] = end.split(":").map(Number);
  const startMin = sH * 60 + sM;
  const endMin = eH * 60 + eM;

  // Janela cruza meia-noite (ex: 22:00 - 07:00) → invertida.
  // Inclusive nos boundaries: se start=22:00 e end=07:00, "ainda quiet"
  // até 07:00 inclusive — usa <= (era < e desligava 1min cedo).
  if (startMin > endMin) return nowMin >= startMin || nowMin <= endMin;
  return nowMin >= startMin && nowMin <= endMin;
}

/**
 * Atomic claim do slot de dispatch via função SQL (migration 00033).
 *
 * INSERT ON CONFLICT DO UPDATE WHERE last_fired_at < cutoff:
 *   - Se cooldown expirou OU primeira vez → atualiza last_fired_at, retorna id
 *   - Se cooldown ativo → WHERE bloqueia UPDATE, RETURNING vazio, retorna null
 *
 * Atomic = se 2 crons rodam simultaneamente, só 1 ganha o claim. O outro
 * fica com null.
 *
 * forceFire bypass o claim (botão Simular Agora). Sempre cria/atualiza,
 * permitindo dispatch mesmo em cooldown.
 */
async function tryClaimDispatchSlot(
  rule: ProactiveRule,
  repId: string,
  targetId: string | null,
  forceFire: boolean,
): Promise<string | null> {
  const supabase = createAdminClient();
  if (forceFire) {
    // Direto via upsert sem cooldown check
    const { data } = await supabase
      .from("assistant_alert_state")
      .upsert(
        {
          rep_id: repId,
          rule_id: rule.id,
          target_id: targetId,
          last_fired_at: new Date().toISOString(),
          status: "running",
        },
        { onConflict: "rep_id,rule_id,target_id" },
      )
      .select("id")
      .single();
    return data?.id || null;
  }
  const { data, error } = await supabase.rpc("try_claim_dispatch_slot", {
    p_rep_id: repId,
    p_rule_id: rule.id,
    p_target_id: targetId,
    p_cooldown_minutes: rule.cooldown_minutes,
  });
  if (error) {
    console.error("[dispatcher] try_claim_dispatch_slot RPC failed:", error.message);
    return null;
  }
  return (data as string | null) || null;
}

/**
 * Marca status final do dispatch (sent/failed). Cooldown já foi reservado
 * pelo claim — esse update só atualiza status + métricas.
 */
async function finalizeDispatch(
  alertStateId: string,
  status: AlertDispatchStatus,
  tokens?: number,
  costUsd?: number,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase.rpc("finalize_dispatch", {
    p_alert_state_id: alertStateId,
    p_status: status,
    p_tokens_used: tokens || null,
    p_cost_usd: costUsd || null,
  });
}

/**
 * Pra status que não chegaram a fazer claim (skipped_disabled,
 * skipped_quiet_hours), grava direto no alert_state via upsert. Esses
 * casos não precisam ser atomic porque não há LLM call concorrente.
 */
async function recordSkip(
  rule: ProactiveRule,
  repId: string,
  targetId: string | null,
  status: AlertDispatchStatus,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("assistant_alert_state")
    .upsert(
      {
        rep_id: repId,
        rule_id: rule.id,
        target_id: targetId,
        last_fired_at: new Date().toISOString(),
        status,
      },
      { onConflict: "rep_id,rule_id,target_id" },
    );
}

export async function dispatchRule(input: DispatchInput): Promise<DispatchResult> {
  const { rule, rep, targetId = null, contextData, mode, testSessionId, forceFire, overrideLocationId } = input;

  // 1. Enabled
  if (!rule.enabled && !forceFire) {
    await recordSkip(rule, rep.id, targetId, "skipped_disabled");
    return { status: "skipped_disabled", message: "Regra desabilitada" };
  }

  const supabase = createAdminClient();

  // 2. Resolve agent + config (pra quiet_hours + ai_model fallback)
  // Fetch separadas — supabase-js type inference quebra com selects longos
  // de relação aninhada.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, location_id")
    .eq("id", rule.agent_id)
    .maybeSingle();
  if (!agent) return { status: "failed", message: "Agent não encontrado" };
  const { data: agentConfig } = await supabase
    .from("agent_configs")
    .select("*")
    .eq("agent_id", agent.id)
    .maybeSingle();

  // 3. Quiet hours
  if (!forceFire && isInQuietHours(agentConfig?.quiet_hours)) {
    await recordSkip(rule, rep.id, targetId, "skipped_quiet_hours");
    return { status: "skipped_quiet_hours", message: "Dentro de quiet hours" };
  }

  // 4. Atomic claim do slot (substitui cooldown check + upsert separados)
  // Se 2 crons paralelos chegam aqui, só 1 ganha; o outro recebe null.
  const alertStateId = await tryClaimDispatchSlot(rule, rep.id, targetId, forceFire === true);
  if (!alertStateId) {
    return { status: "skipped_cooldown", message: "Em cooldown (claim negado)" };
  }

  // Silence gate (fix audit Phase 3): rep parou de responder? Skip pra não
  // queimar mensagens em sequência (risco banimento WhatsApp). Aplica APENAS
  // em mode='real' — em testes (simulated) seguimos sem gate pra Pedro
  // poder validar regras.
  // O gate roda APÓS o claim do slot pra não afogar o cron com chamadas
  // canceladas, e ANTES do LLM (pra não desperdiçar tokens).
  const silenceDecision = mode === "real"
    ? await loadSilenceDecision(supabase, rep.id)
    : null;
  if (silenceDecision && !silenceDecision.canSend) {
    console.log(
      `[dispatcher] rep ${rep.id} silenciado (reason=${silenceDecision.reason}) ` +
      `— pulando rule ${rule.name}${silenceDecision.shouldSetPaused ? ' + pausando' : ''}`,
    );
    await recordProactiveSent(supabase, rep.id, silenceDecision);
    // "Dar sinal" no momento EXATO da pausa (Pedro 2026-05-21: "se para de enviar,
    // explicar o motivo e dar sinal"). O rep já recebeu 2 avisos (soft no 2º, hard
    // no 3º — o hard diz "vou pausar até você falar comigo"), então a pausa em si
    // segue silenciosa (4ª msg = spam/ban risk). O que faltava era VISIBILIDADE pro
    // admin: emite o signal SÓ na transição (shouldSetPaused), nunca a cada tick de
    // rep já-pausado (already_paused → shouldSetPaused=false). recordSignalAsync
    // dedupa por (type,title), então re-pausa do mesmo rep atualiza, não duplica.
    if (silenceDecision.shouldSetPaused) {
      const repLabel = rep.display_name || rep.phone || rep.id;
      recordSignalAsync({
        type: "failure",
        severity: "medium",
        source: "bot_auto",
        title: `Rep ${repLabel} pausado por silêncio (proativos sem resposta)`,
        description:
          `O rep ${repLabel} (${rep.phone}) recebeu vários proativos seguidos sem ` +
          `responder. O bot avisou 2× (o último dizendo que pausaria) e agora PAUSOU ` +
          `os automáticos pra evitar bloqueio do WhatsApp. Reativa sozinho no primeiro ` +
          `inbound do rep — se quiser retomar antes, vale um toque manual. ` +
          `Última regra que tentou disparar: ${rule.name}.`,
        metadata: {
          rep_id: rep.id,
          phone: rep.phone,
          rule: rule.name,
          rule_id: rule.id,
          paused_at: new Date().toISOString(),
        },
      });
    }
    await finalizeDispatch(alertStateId, "skipped_silence");
    return { status: "skipped_silence", message: "Rep silenciado (sem resposta recente)" };
  }

  // Daily proactive limit (admin-configurável 2026-05-03):
  // Conta quantos proativos foram disparados pra este rep nas últimas 24h.
  // Se atingiu o limite, skip. 0 = desativado. Reminders criados pelo
  // próprio rep (schedule_reminder) NÃO contam — só proativos por regras.
  // Conta via assistant_alert_state (status=sent) que tem 1 row por
  // (rep, rule, target) com last_fired_at — perfect pra count janela 24h.
  const dailyLimit =
    typeof agentConfig?.daily_proactive_limit === "number" && agentConfig.daily_proactive_limit > 0
      ? agentConfig.daily_proactive_limit
      : 0;
  if (dailyLimit > 0 && mode === "real" && !forceFire) {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count } = await supabase
      .from("assistant_alert_state")
      .select("id", { count: "exact", head: true })
      .eq("rep_id", rep.id)
      .eq("status", "sent")
      .gte("last_fired_at", since);
    const sentCount = count ?? 0;
    if (sentCount >= dailyLimit) {
      console.log(
        `[dispatcher] rep ${rep.id} atingiu daily_proactive_limit=${dailyLimit} ` +
        `(${sentCount} envios em 24h) — pulando rule ${rule.name}`,
      );
      await finalizeDispatch(alertStateId, "skipped_silence"); // reusa enum existente
      return { status: "skipped_silence", message: `Limite diário atingido (${sentCount}/${dailyLimit})` };
    }
  }

  // 5. Resolve location ativa do rep + GHL client.
  // Se overrideLocationId foi passado (ex: post_meeting numa location
  // não-ativa do rep), usa ele — assim tools (get_contact, etc) rodam
  // na location certa onde o evento aconteceu.
  const activeLocationId =
    overrideLocationId ||
    rep.active_location_id ||
    rep.ghl_users[0]?.location_id;
  if (!activeLocationId) {
    await finalizeDispatch(alertStateId, "failed");
    return { status: "failed", message: "Rep sem active_location_id" };
  }

  const { data: location } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name, timezone")
    .eq("location_id", activeLocationId)
    .maybeSingle();
  if (!location) {
    await finalizeDispatch(alertStateId, "failed");
    return { status: "failed", message: "Location não encontrada" };
  }

  // 6. Monta prompt: persona + instruction + context
  // Fix bug observado em prod 2026-05-03: timezone do REP, não da location.
  // Mesma resolution chain do processor: rep.timezone → location.timezone →
  // 'America/New_York'. Em proativos não fazemos lazy backfill (vem do
  // identify; se faltar, processor backfila no próximo inbound).
  const tz = rep.timezone || location.timezone || "America/New_York";
  const locale: "pt-BR" | "en-US" =
    tz.includes("America/") && !tz.includes("Sao_Paulo") && !tz.includes("Fortaleza")
      ? "en-US"
      : "pt-BR";

  // Tier 1 + KB items carregados em paralelo — graceful fallback se falhar.
  const loadKbItems = async (): Promise<Array<{
    title: string; type: "text" | "file" | "url"; content: string;
    file_name: string | null; file_url: string | null;
    description: string | null; usage_instructions: string | null;
  }>> => {
    try {
      const r = await supabase
        .from("knowledge_base")
        .select("title,type,content,file_name,file_url,description,usage_instructions")
        .eq("agent_id", rule.agent_id)
        .order("created_at", { ascending: false })
        .limit(50);
      return (r.data || []) as Array<{
        title: string; type: "text" | "file" | "url"; content: string;
        file_name: string | null; file_url: string | null;
        description: string | null; usage_instructions: string | null;
      }>;
    } catch {
      return [];
    }
  };
  const [carrierOverview, kbItems] = await Promise.all([
    loadCarrierTier1("national_life_group").catch((err) => {
      console.warn("[dispatcher] loadCarrierTier1 falhou (não-fatal):", err);
      // Sweep F49 2026-06-05: proativo segue SEM contexto de carrier (degradado).
      reportError({ title: "Dispatcher: contexto de carrier indisponível", feature: "proactive-dispatcher", severity: "low", error: err });
      return "";
    }),
    loadKbItems(),
  ]);

  // F2 (cost-reduction 2026-06): o system do proativo deixa de ser POLUÍDO pelo suffix volátil.
  // Antes "# MODO PROATIVO" + rule.prompt_instruction (que no briefing embute o JSON do dia) era
  // concatenado AQUI no system → prefixo ÚNICO por regra/dia = cache=0 (medido: Resumo matinal
  // read 0%, tudo write nunca relido). Agora o system vira o prefixo ESTÁVEL do SparkBot (o
  // suffix+JSON vão pra user message). GANHO GARANTIDO: para de escrever ~36K de prefixo
  // descartável por disparo. Compartilhar cache-read COM o inbound do mesmo rep é ganho EXTRA e
  // CONDICIONAL (mesmo modelo + mesmo set de tools + mesmo locationName/channel) — hoje o set de
  // tools ainda diverge (proativo=subset, inbound=all): esse share só fecha com F8 (Fase 2).
  // Proativo NÃO seta cacheTtl → fica 5m (disparo one-shot; 1h seria write 2x de custo puro).
  const systemPrompt = buildSparkbotSystemPrompt({
    rep,
    locationName: location.location_name || activeLocationId,
    locationTimezone: tz,
    locale,
    confirmationMode:
      (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") ||
      "high_only",
    carrierOverview,
    customInstructions: agentConfig?.custom_instructions ?? null,
    kbInstructions: agentConfig?.knowledge_base_instructions ?? null,
    kbItems,
    tones: {
      creativity: agentConfig?.tone_creativity ?? null,
      formality: agentConfig?.tone_formality ?? null,
      naturalness: agentConfig?.tone_naturalness ?? null,
      aggressiveness: agentConfig?.tone_aggressiveness ?? null,
    },
  });

  // O suffix volátil do modo proativo + a instrução da regra + o JSON do disparo vão na
  // user message (não-cacheada) — mesmas strings verbatim de antes (parity de comportamento).
  const runtimeContext = [
    buildSparkbotRuntimeContext({ locationTimezone: tz, locale }),
    "",
    "# MODO PROATIVO ATIVADO",
    `Você está iniciando uma conversa proativamente (não foi o rep que pediu — você está agindo por conta própria pra ajudar).`,
    `Tipo de proatividade: ${rule.name}`,
    "",
    "INSTRUÇÃO ESPECÍFICA DESTA REGRA:",
    rule.prompt_instruction,
    "",
    "REGRAS DE PROATIVIDADE (importante):",
    "- Comece direto, sem 'Oi!' ou apresentação. Você está apenas mandando uma msg de update útil.",
    "- Seja extremamente conciso — resposta curta, sem floreio.",
    "- Use as tools necessárias pra coletar contexto antes de escrever a msg final.",
    "- Se não houver dado relevante (ex: rep não tem appointments hoje), diga isso de forma curta em vez de inventar.",
    "",
    "## Contexto deste disparo",
    JSON.stringify(contextData, null, 2),
  ].join("\n");

  // 7. LLM call com tool-calling (P2 2026-05-20: usa runSparkbotTurn compartilhado)
  const ghlClient = new GHLClient(location.company_id, activeLocationId);
  const cm = (agentConfig?.confirmation_mode as
    | "always"
    | "medium_and_high"
    | "high_only") || "high_only";
  const disabledTools = Array.isArray(agentConfig?.disabled_tools)
    ? agentConfig.disabled_tools as string[]
    : [];
  const enabledKbs = Array.isArray(agentConfig?.enabled_kbs)
    ? agentConfig.enabled_kbs as string[]
    : ["national_life_group", "agency_brazillionaires"];

  // Passa confirmation_mode pra injetar `confirmed_by_rep` nos schemas das
  // tools com gate ativo — senão o LLM cai em loop quando precisa confirmar.
  // Disabled tools removidas do schema completamente (LLM nem vê).
  const toolCtx: ToolContext = buildToolCtx({
    rep,
    locationId: activeLocationId,
    companyId: location.company_id,
    ghlClient,
    testSessionId: testSessionId,
    confirmationMode: cm,
    enabledKbs,
  });

  const initialUserMessage: LLMMessage = {
    role: "user",
    content: `${runtimeContext}\n\nGere a mensagem proativa apropriada agora.`,
  };

  const startTs = Date.now();
  const llmResult = await runSparkbotTurn({
    systemPrompt,
    messages: [initialUserMessage],
    toolCtx,
    toolSelection: {
      kind: "subset",
      allowedNames: rule.tools_allowed,
      confirmationMode: cm,
      disabledTools,
    },
    model: rule.ai_model || agentConfig?.ai_model || "claude-haiku-4-5-20251001",
    fallbackModel: agentConfig?.fallback_model ?? null,
  });
  const durationMs = Date.now() - startTs;

  if (!llmResult.text || llmResult.stopped_reason === "error") {
    await finalizeDispatch(alertStateId, "failed", llmResult.prompt_tokens);
    return { status: "failed", message: "LLM falhou", duration_ms: durationMs };
  }

  // 8. Output: simulated → insert no chat de teste; real → envia via GHL
  if (mode === "simulated") {
    if (!testSessionId) {
      // Sem session — pode estar testando via cron e não ter UI aberta. Skip.
      console.warn(`[dispatcher] simulated mode sem testSessionId pra rule ${rule.name}`);
    } else {
      await supabase.from("agent_test_messages").insert({
        session_id: testSessionId,
        role: "agent",
        content: llmResult.text,
        metadata: {
          model: llmResult.model_used,
          tools: llmResult.tool_calls.map((t) => t.name),
          tool_calls: llmResult.tool_calls,
          prompt_tokens: llmResult.prompt_tokens,
          completion_tokens: llmResult.completion_tokens,
          cached_tokens: llmResult.cached_tokens,
          duration_ms: durationMs,
          // Marcadores especiais que a UI usa pra renderizar como alerta proativo
          alert_type: rule.name,
          rule_id: rule.id,
          is_proactive: true,
        },
      });
      await supabase
        .from("agent_test_sessions")
        .update({ updated_at: new Date().toISOString() })
        .eq("id", testSessionId);
    }
  } else {
    // mode === 'real' — envia via WhatsApp/SMS no Hub do rep usando o
    // mesmo helper que o reminder-runner. Implementado 2026-05-04 quando
    // ativamos `post_meeting` reactive rule pra disparar imediato.
    //
    // O helper persiste em sparkbot_messages (com fallback pro painel web
    // se WHATSAPP_DELIVERY_ENABLED=0 ou send falhar). O alert_state é
    // finalizado abaixo independente do canal de entrega — billing roda
    // mesmo se entrega caiu pro web (ainda houve LLM call).
    const { deliverProactiveMessage } = await import("./whatsapp-delivery");
    // Fix antispam 2026-05-21: prepend o aviso da silence-gate (warn 2→/3→) e,
    // após entregar via WhatsApp, INCREMENTA o counter (recordProactiveSent).
    // Antes o dispatcher só registrava no branch de skip → counter ficava 0
    // eterno → nunca avisava nem pausava (bug: Wagner, 11 proativos sem reação).
    let warnPrefix = "";
    if (silenceDecision && silenceDecision.canSend) {
      warnPrefix = silenceDecision.warningPrefix ?? "";
    }
    const dr = await deliverProactiveMessage(rep, warnPrefix + llmResult.text, {
      activeLocationId,
      source: "proactive_rule",
      kind: rule.name,
      extraMetadata: {
        rule_id: rule.id,
        alert_type: rule.name,
        target_id: targetId,
        model: llmResult.model_used,
        tools: llmResult.tool_calls.map((t) => t.name),
        // F8 (contact-resolution 2026-06): chave PADRONIZADA contact_id/contact_name pro
        // "contato em foco" (F3) herdar. Só de campo EXPLÍCITO de contato no contextData
        // (triggers de task/appointment/followup) — NÃO usa target_id cru (ambíguo, pode
        // não ser contato) nem o rep.id (esse é o próprio rep, não o contato discutido).
        ...(() => {
          const cid = contextData.contact_id ?? contextData.contactId;
          const cname = contextData.contact_name ?? contextData.contactName;
          return {
            ...(typeof cid === "string" && cid && cid !== rep.id ? { contact_id: cid } : {}),
            ...(typeof cname === "string" && cname ? { contact_name: cname } : {}),
          };
        })(),
      },
    });
    // Conta o silêncio só se o proativo chegou no WhatsApp (fallback web não
    // "nag" o rep, não deve inflar o counter nem pausar quem só usa o painel).
    if (silenceDecision && silenceDecision.canSend && dr?.via === "whatsapp") {
      await recordProactiveSent(supabase, rep.id, silenceDecision);
    }
  }

  // 9. Billing
  let costUsd: number | undefined;
  try {
    const { calculateCost } = await import("@/lib/billing/pricing");
    const cost = calculateCost({
      model: llmResult.model_used,
      promptTokens: llmResult.prompt_tokens,
      completionTokens: llmResult.completion_tokens,
      cachedTokens: llmResult.cached_tokens,
      cacheCreationTokens: llmResult.cache_creation_tokens ?? 0,
    });
    costUsd = cost.totalChargeUsd;
    await trackAndCharge({
      locationId: activeLocationId,
      companyId: location.company_id,
      agentId: rule.agent_id,
      contactId: rep.id,
      actionType: `proactive:${rule.name}`,
      model: llmResult.model_used,
      promptTokens: llmResult.prompt_tokens,
      completionTokens: llmResult.completion_tokens,
      cachedTokens: llmResult.cached_tokens,
      cacheCreationTokens: llmResult.cache_creation_tokens ?? 0,
      usesCustomKey: false,
    });
  } catch (err) {
    console.error("[dispatcher] billing failed (non-blocking):", err instanceof Error ? err.message : err);
    // Sweep F49 2026-06-05: billing do proativo não cobrado (receita perdida).
    reportError({ title: "Dispatcher: billing do proativo falhou", feature: "proactive-dispatcher", severity: "medium", error: err });
  }

  // 10. Finaliza dispatch (atualiza status sent + métricas no slot já reservado)
  await finalizeDispatch(
    alertStateId,
    "sent",
    llmResult.prompt_tokens + llmResult.completion_tokens,
    costUsd,
  );

  return {
    status: "sent",
    text_generated: llmResult.text,
    tools_used: llmResult.tool_calls.map((t) => t.name),
    tokens: {
      prompt: llmResult.prompt_tokens,
      completion: llmResult.completion_tokens,
      cached: llmResult.cached_tokens,
    },
    duration_ms: durationMs,
  };
}
