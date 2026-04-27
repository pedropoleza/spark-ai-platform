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
import { runWithTools, type LLMMessage } from "../llm-client";
import { getToolDefinitions, executeTool, type ToolContext } from "../tools";
import { buildSparkbotSystemPrompt, buildSparkbotRuntimeContext } from "../prompt-builder";
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
  const { rule, rep, targetId = null, contextData, mode, testSessionId, forceFire } = input;

  // 1. Enabled
  if (!rule.enabled && !forceFire) {
    await recordSkip(rule, rep.id, targetId, "skipped_disabled");
    return { status: "skipped_disabled", message: "Regra desabilitada" };
  }

  const supabase = createAdminClient();

  // 2. Resolve agent + config (pra quiet_hours + ai_model fallback)
  const { data: agent } = await supabase
    .from("agents")
    .select("id, location_id, agent_configs(quiet_hours, ai_model, confirmation_mode)")
    .eq("id", rule.agent_id)
    .maybeSingle();
  if (!agent) return { status: "failed", message: "Agent não encontrado" };
  const agentConfig = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;

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

  // 5. Resolve location ativa do rep + GHL client
  const activeLocationId = rep.active_location_id || rep.ghl_users[0]?.location_id;
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
  const tz = location.timezone || "America/New_York";
  const locale: "pt-BR" | "en-US" =
    tz.includes("America/") && !tz.includes("Sao_Paulo") && !tz.includes("Fortaleza")
      ? "en-US"
      : "pt-BR";

  const systemPrompt = [
    buildSparkbotSystemPrompt({
      rep,
      locationName: location.location_name || activeLocationId,
      locationTimezone: tz,
      locale,
      confirmationMode:
        (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") ||
        "medium_and_high",
    }),
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
  ].join("\n");

  const runtimeContext = [
    buildSparkbotRuntimeContext({ locationTimezone: tz, locale }),
    "",
    "## Contexto deste disparo",
    JSON.stringify(contextData, null, 2),
  ].join("\n");

  // 7. LLM call com tool-calling
  const ghlClient = new GHLClient(location.company_id, activeLocationId);
  const toolCtx: ToolContext = {
    rep,
    locationId: activeLocationId,
    companyId: location.company_id,
    ghlClient,
    testSessionId: testSessionId || null,
  };

  const toolDefs = getToolDefinitions(rule.tools_allowed);

  const initialUserMessage: LLMMessage = {
    role: "user",
    content: `${runtimeContext}\n\nGere a mensagem proativa apropriada agora.`,
  };

  const startTs = Date.now();
  const llmResult = await runWithTools({
    systemPrompt,
    messages: [initialUserMessage],
    tools: toolDefs,
    executor: (name, args) => executeTool(name, args, toolCtx),
    model: rule.ai_model || agentConfig?.ai_model || "claude-haiku-4-5-20251001",
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
    // mode === 'real' — V3+ envia via GHL Hub WhatsApp ao contato do rep no Hub
    // Por ora, não implementado em V2 (vai junto com migração WhatsApp).
    console.warn("[dispatcher] mode='real' ainda não implementado — V3 plug");
  }

  // 9. Billing
  let costUsd: number | undefined;
  try {
    const { calculateCost } = await import("@/lib/billing/pricing");
    const cost = calculateCost(
      llmResult.model_used,
      llmResult.prompt_tokens,
      llmResult.completion_tokens,
      llmResult.cached_tokens,
    );
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
      usesCustomKey: false,
    });
  } catch (err) {
    console.error("[dispatcher] billing failed (non-blocking):", err instanceof Error ? err.message : err);
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
