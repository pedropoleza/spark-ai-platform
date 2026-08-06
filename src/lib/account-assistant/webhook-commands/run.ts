/**
 * Execução do comando via webhook (H71, Pedro 2026-08-05).
 *
 *   notification → manda o texto CRU pro WhatsApp do corretor.
 *   prompt       → roda o prompt no SparkBot (com tools) e manda a RESPOSTA.
 *
 * Os dois caminhos terminam no MESMO `deliverProactiveMessage` que o lembrete
 * e a regra proativa usam. Isso não é economia de código: é o que garante que
 * o comando externo herda o gate de opt-in do WhatsApp (anti-ban Meta), a
 * resolução de hub e a persistência em `sparkbot_messages` — o corretor vê a
 * mensagem no painel mesmo se o WhatsApp falhar.
 *
 * O que este caminho NÃO herda, de propósito:
 *   - quiet hours: quem escolheu a hora foi a automação da própria conta.
 *   - silence gate: o gate existe pra frear proativo que o BOT decidiu mandar.
 *     Engolir um aviso que a conta pediu explicitamente seria pior (foi assim
 *     que o "inbound MUDO" ficou 4 mil vezes preso sem ninguém ver).
 * No lugar dos dois, a trava é quantitativa e explícita: cap diário por
 * corretor (`SPARKBOT_COMMAND_DAILY_CAP`), que protege contra workflow em
 * loop sem silenciar aviso legítimo.
 */

import { GHLClient } from "@/lib/ghl/client";
import { createAdminClient } from "@/lib/supabase/admin";
import { RUNNING_TTL_MS, fingerprintComando } from "./audit";
import { trackAndCharge } from "@/lib/billing/charge";
import { reportError } from "@/lib/admin-signals/report-error";
import { findActiveSparkbotAgent, findAgentConfig } from "@/lib/repositories/agents.repo";
import { findLastInboundHubLocation } from "@/lib/repositories/sparkbot-messages.repo";
import { resolvePrimaryHub } from "@/lib/account-assistant/hub-resolver";
import { deliverProactiveMessage } from "@/lib/account-assistant/proactive/whatsapp-delivery";
import {
  buildSparkbotSystemPrompt,
  buildSparkbotRuntimeContext,
  buildRepContextBlock,
  loadCarrierTier1,
} from "@/lib/account-assistant/prompt-builder";
import { runSparkbotTurn, buildToolCtx } from "@/lib/account-assistant/core/run-sparkbot-turn";
import { TOOL_REGISTRY } from "@/lib/account-assistant/tools";
import type { LLMMessage } from "@/lib/account-assistant/llm-client";
import type { ParsedCommand } from "./parse";
import type { AuthorizedTarget } from "./authorize";

export interface ExecuteResult {
  status: "sent" | "failed";
  /** Canal real da entrega ('whatsapp' ou 'system' = painel web). */
  via?: "whatsapp" | "system";
  /** Texto efetivamente entregue (no modo prompt, o que o bot escreveu). */
  deliveredText?: string;
  detail?: string;
  durationMs: number;
  model?: string;
  toolsUsed?: string[];
}

/** Cap diário de comandos por corretor. 0 desliga. */
export function dailyCap(): number {
  const raw = process.env.SPARKBOT_COMMAND_DAILY_CAP?.trim();
  if (!raw) return 50;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : 50;
}

/**
 * Verbos de LEITURA. Um comando roda SEM humano no circuito — não existe
 * "Confirma?" pra responder no meio de um turno disparado por automação —
 * então o modo prompt só recebe tool que CONSULTA.
 */
const VERBOS_DE_LEITURA = [
  "get_",
  "list_",
  "search_",
  "count_",
  "describe_",
  "query_",
  "analyze_",
  "recap_",
  "preview_",
  // `present_options` fica FORA: ela existe pra abrir menu numerado e esperar
  // o rep escolher. Num comando disparado por automação não há ninguém pra
  // escolher — o modelo abriria um menu que morre sozinho.
] as const;

/**
 * Tools liberadas pro modo prompt.
 *
 * ⚠️ `risk === "safe"` NÃO quer dizer "só lê" — quer dizer "não precisa de
 * confirmação". Conferido no registry: das 48 tools `safe`, oito ESCREVEM —
 * `schedule_reminder` (que agenda um WhatsApp futuro!), `cancel_reminder`,
 * `set_rep_alias`, `forget_rep_alias`, `set_rep_preferred_name`,
 * `set_scheduling_pref`, `set_verbosity_preference`, `confirm_rep_timezone`
 * — mais `report_missed_capability`, que grava sinal de admin. Filtrar só por
 * `risk` deixaria uma automação mal configurada (ou um texto malicioso no
 * campo `message`, que vira instrução pro LLM) renomear o corretor ou
 * agendar mensagem em nome dele.
 *
 * Por isso o filtro é **fail-closed pelo verbo do nome**, e não uma lista de
 * exceções: tool nova só entra se o nome disser que ela lê. Uma tool de
 * leitura com nome fora do padrão fica de fora até alguém decidir incluí-la
 * — errar pro lado de faltar consulta é barato; errar pro lado de escrever
 * sem ninguém ver, não.
 *
 * Se o Pedro pedir ação de escrita depois, o caminho é um campo explícito no
 * payload (`allow_actions`), NÃO afrouxar este default.
 */
export function safeToolNames(): string[] {
  return Object.values(TOOL_REGISTRY)
    .filter((e) => e.def.risk === "safe")
    .map((e) => e.def.name)
    .filter((nome) => VERBOS_DE_LEITURA.some((v) => nome.startsWith(v)));
}

/**
 * Resolve o agente SparkBot que atende esse corretor — pra config (modelo,
 * tom, instruções) e pro billing. Mesma escada do delivery: hub do último
 * inbound → hub primário do DB.
 */
async function resolveSparkbotAgent(
  repId: string,
): Promise<{ agentId: string; hubLocationId: string } | null> {
  const hubDoRep = await findLastInboundHubLocation(repId);
  if (hubDoRep) {
    const agent = await findActiveSparkbotAgent(hubDoRep);
    if (agent) return { agentId: agent.id, hubLocationId: hubDoRep };
  }
  const primario = await resolvePrimaryHub();
  if (primario) return { agentId: primario.agentId, hubLocationId: primario.locationId };
  return null;
}

/**
 * Quantos comandos já foram entregues (ou estão sendo entregues agora) pra
 * esse corretor nas últimas 24h.
 *
 * `running` conta — um workflow em loop dispara mais rápido do que o prompt
 * termina, e contar só `sent` deixaria a rajada inteira passar pelo cap — mas
 * só o `running` RECENTE. Linha órfã (lambda reciclada no meio) fica em
 * running pra sempre; contá-la por 24h iria comendo o cap do corretor até
 * emudecer os avisos legítimos dele por um erro de infraestrutura.
 */
export async function contarEnviosRecentes(repId: string): Promise<number> {
  const supabase = createAdminClient();
  const dia = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const ttl = new Date(Date.now() - RUNNING_TTL_MS).toISOString();

  const [entregues, emCurso] = await Promise.all([
    supabase
      .from("sparkbot_webhook_commands")
      .select("id", { count: "exact", head: true })
      .eq("rep_id", repId)
      .eq("status", "sent")
      .gte("received_at", dia),
    supabase
      .from("sparkbot_webhook_commands")
      .select("id", { count: "exact", head: true })
      .eq("rep_id", repId)
      .eq("status", "running")
      .gte("received_at", ttl),
  ]);

  // Erro de consulta não pode virar bloqueio: fail-open com log (o cap é
  // proteção contra loop, não gate de segurança — quem barra é o authorize).
  if (entregues.error || emCurso.error) {
    console.warn(
      "[webhook-command] contagem do cap diário falhou (fail-open):",
      entregues.error?.message ?? emCurso.error?.message,
    );
    return 0;
  }
  return (entregues.count ?? 0) + (emCurso.count ?? 0);
}

/**
 * Chave de dedupe do transporte, ÚNICA por comando.
 *
 * O default do `deliverProactiveMessage` é `fonte:rep:minuto` — o que é certo
 * pra lembrete e regra proativa (rodam em tick, e o retry da mesma execução
 * cai no mesmo minuto), mas errado aqui: duas automações diferentes da conta
 * podem avisar o mesmo corretor no mesmo minuto e a segunda sumiria calada.
 * A digital do comando distingue os dois — e mantém a MESMA chave numa
 * reentrega do mesmo comando, que é justo o que o dedupe deve pegar.
 */
function dedupeDoComando(command: ParsedCommand): string {
  return `wcmd:${fingerprintComando(command).slice(0, 24)}`;
}

// ---------------------------------------------------------------------------
// notification
// ---------------------------------------------------------------------------

async function runNotification(
  command: ParsedCommand,
  target: AuthorizedTarget,
  inicio: number,
): Promise<ExecuteResult> {
  const dr = await deliverProactiveMessage(target.rep, command.message, {
    activeLocationId: target.locationId,
    source: "webhook_notification",
    kind: "webhook_command",
    dedupeKey: dedupeDoComando(command),
    extraMetadata: {
      webhook_command: true,
      command_kind: "notification",
      command_location_id: target.locationId,
      ...(command.contactId ? { contact_id: command.contactId } : {}),
      ...(command.contactName ? { contact_name: command.contactName } : {}),
      ...(command.requestId ? { request_id: command.requestId } : {}),
    },
  });

  return {
    status: statusDaEntrega(dr),
    via: dr.via,
    deliveredText: command.message,
    detail: dr.error ?? undefined,
    durationMs: Date.now() - inicio,
  };
}

/**
 * Traduz o resultado do delivery em "entregou ou não".
 *
 * ⚠️ `dr.ok` NÃO responde isso. No caminho normal ele volta `true` sempre —
 * a função persiste em `sparkbot_messages` e considera isso sucesso mesmo
 * quando o envio pro WhatsApp falhou; a verdade está em `via` e `error`.
 * Confiar no `ok` fazia toda falha de envio virar HTTP 200 e linha `sent` na
 * auditoria, que é o pior desfecho possível: o corretor não recebe e ninguém
 * fica sabendo.
 *
 * `blocked_no_optin` é a exceção: aí o WhatsApp foi pulado DE PROPÓSITO (gate
 * anti-ban da Meta) e a mensagem está no painel esperando o corretor. Isso é
 * entrega, não falha.
 */
function statusDaEntrega(dr: { ok: boolean; via: "whatsapp" | "system"; error?: string | null }) {
  if (!dr.ok) return "failed" as const;
  if (dr.via === "whatsapp") return "sent" as const;
  return dr.error === "blocked_no_optin" ? ("sent" as const) : ("failed" as const);
}

// ---------------------------------------------------------------------------
// prompt
// ---------------------------------------------------------------------------

async function runPrompt(
  command: ParsedCommand,
  target: AuthorizedTarget,
  inicio: number,
): Promise<ExecuteResult> {
  const { rep } = target;

  const agente = await resolveSparkbotAgent(rep.id);
  if (!agente) {
    return {
      status: "failed",
      detail: "Não achei um SparkBot ativo pra montar a resposta.",
      durationMs: Date.now() - inicio,
    };
  }

  const agentConfig = await findAgentConfig(agente.agentId);

  // Fuso: rep → location que mandou o webhook → NY (mesma ordem do H68).
  const tz = rep.timezone || target.locationTimezone || "America/New_York";
  const locale: "pt-BR" | "en-US" =
    tz.includes("America/") && !tz.includes("Sao_Paulo") && !tz.includes("Fortaleza")
      ? "en-US"
      : "pt-BR";

  const carrierOverview = await loadCarrierTier1("national_life_group").catch(() => "");

  const systemPrompt = buildSparkbotSystemPrompt({
    rep,
    locationName: target.locationName || target.locationId,
    locationTimezone: tz,
    locale,
    confirmationMode:
      (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") || "high_only",
    carrierOverview,
    customInstructions: agentConfig?.custom_instructions ?? null,
    kbInstructions: agentConfig?.knowledge_base_instructions ?? null,
    kbItems: [],
    tones: {
      creativity: agentConfig?.tone_creativity ?? null,
      formality: agentConfig?.tone_formality ?? null,
      naturalness: agentConfig?.tone_naturalness ?? null,
      aggressiveness: agentConfig?.tone_aggressiveness ?? null,
    },
  });

  // O suffix volátil vai na user message, não no system (F1 do H44: system
  // byte-estável por conversa = cache aproveitado).
  const blocoContato = command.contactId
    ? [
        "",
        "# CONTATO EM CONTEXTO",
        command.contactName
          ? `A automação disparou por causa de ${command.contactName} (pista de id: ${command.contactId}).`
          : `A automação disparou por causa do contato de id ${command.contactId}.`,
        `Trate como PISTA: valide com get_contact(${command.contactId}) antes de afirmar qualquer coisa sobre ele.`,
      ].join("\n")
    : "";

  const runtimeContext = [
    // O bloco por-rep (nome preferido, fuso, locations, memória) mora na user
    // message desde o B3 do H44 — sem ele o bot trata o corretor como
    // desconhecido e chama a pessoa pelo nome errado num aviso que ela recebe
    // sem ter pedido. O proativo já passa; o comando tem que passar também.
    buildSparkbotRuntimeContext({
      locationTimezone: tz,
      locale,
      repContextBlock: buildRepContextBlock({
        rep,
        locationName: target.locationName || target.locationId,
        locationTimezone: tz,
        locale,
      }),
    }),
    "",
    "# COMANDO EXTERNO (automação do Spark Leads)",
    "Uma automação da conta disparou este comando — NÃO foi o corretor que te escreveu agora.",
    "O que você responder vai direto pro WhatsApp dele, sem ninguém revisar antes.",
    "",
    "REGRAS DESTE MODO:",
    "- Escreva a mensagem FINAL pro corretor. Nada de 'ok, vou fazer' nem de perguntar antes.",
    "- Seja curto e direto — é um aviso, não uma conversa.",
    "- Você só tem tools de CONSULTA aqui. Se o comando pedir uma ação de escrita, faça a consulta que der e diga ao corretor o que falta ele confirmar — ele pode te responder nessa mesma conversa.",
    "- Sem dado pra sustentar o que ia dizer: diga isso em uma linha. NUNCA invente número, nome ou compromisso.",
    blocoContato,
    "",
    "## COMANDO",
    command.message,
  ]
    .filter((l) => l !== "")
    .join("\n");

  const ghlClient = new GHLClient(target.companyId, target.locationId);
  const cm =
    (agentConfig?.confirmation_mode as "always" | "medium_and_high" | "high_only") || "high_only";

  const toolCtx = buildToolCtx({
    rep,
    locationId: target.locationId,
    companyId: target.companyId,
    ghlClient,
    confirmationMode: cm,
    enabledKbs: Array.isArray(agentConfig?.enabled_kbs)
      ? (agentConfig.enabled_kbs as string[])
      : ["national_life_group", "agency_brazillionaires"],
  });

  const mensagemInicial: LLMMessage = {
    role: "user",
    content: `${runtimeContext}\n\nEscreva agora a mensagem que o corretor vai receber.`,
  };

  const llm = await runSparkbotTurn({
    systemPrompt,
    messages: [mensagemInicial],
    toolCtx,
    toolSelection: {
      kind: "subset",
      allowedNames: safeToolNames(),
      confirmationMode: cm,
      disabledTools: Array.isArray(agentConfig?.disabled_tools)
        ? (agentConfig.disabled_tools as string[])
        : [],
    },
    model: agentConfig?.ai_model || "claude-haiku-4-5-20251001",
    fallbackModel: agentConfig?.fallback_model ?? null,
  });

  const durationMs = Date.now() - inicio;

  if (!llm.text || llm.stopped_reason === "error") {
    return {
      status: "failed",
      detail: "O SparkBot não conseguiu gerar a resposta pro comando.",
      durationMs,
      model: llm.model_used,
    };
  }

  const dr = await deliverProactiveMessage(rep, llm.text, {
    activeLocationId: target.locationId,
    source: "webhook_prompt",
    kind: "webhook_command",
    dedupeKey: dedupeDoComando(command),
    extraMetadata: {
      webhook_command: true,
      command_kind: "prompt",
      command_location_id: target.locationId,
      command_text: command.message,
      model: llm.model_used,
      tools: llm.tool_calls.map((t) => t.name),
      // Chave padronizada do H45/F8: o próximo inbound do corretor herda esse
      // contato como "em foco" — se ele responder "liga pra ela", o bot sabe
      // de quem se trata sem o corretor repetir o nome.
      ...(command.contactId ? { contact_id: command.contactId } : {}),
      ...(command.contactName ? { contact_name: command.contactName } : {}),
      ...(command.requestId ? { request_id: command.requestId } : {}),
    },
  });

  // Billing: o custo vai pra conta que DISPAROU a automação.
  try {
    await trackAndCharge({
      locationId: target.locationId,
      companyId: target.companyId,
      agentId: agente.agentId,
      contactId: rep.id,
      actionType: "webhook_command:prompt",
      model: llm.model_used,
      promptTokens: llm.prompt_tokens,
      completionTokens: llm.completion_tokens,
      cachedTokens: llm.cached_tokens,
      cacheCreationTokens: llm.cache_creation_tokens ?? 0,
      usesCustomKey: false,
    });
  } catch (err) {
    console.error("[webhook-command] billing falhou (não bloqueia):", err);
    reportError({
      title: "Comando via webhook: billing não cobrado",
      feature: "webhook-commands",
      severity: "medium",
      error: err,
    });
  }

  return {
    status: statusDaEntrega(dr),
    via: dr.via,
    deliveredText: llm.text,
    detail: dr.error ?? undefined,
    durationMs,
    model: llm.model_used,
    toolsUsed: llm.tool_calls.map((t) => t.name),
  };
}

// ---------------------------------------------------------------------------

export async function executeWebhookCommand(
  command: ParsedCommand,
  target: AuthorizedTarget,
): Promise<ExecuteResult> {
  const inicio = Date.now();
  try {
    return command.kind === "notification"
      ? await runNotification(command, target, inicio)
      : await runPrompt(command, target, inicio);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`[webhook-command] execução falhou (${command.kind}):`, detail);
    reportError({
      title: `Comando via webhook falhou (${command.kind})`,
      feature: "webhook-commands",
      severity: "medium",
      error: err,
    });
    return { status: "failed", detail, durationMs: Date.now() - inicio };
  }
}
