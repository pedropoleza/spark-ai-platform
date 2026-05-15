/**
 * Pipeline principal do Sparkbot. Dado um rep + input do rep, decide se:
 * - Precisa enviar termos de uso (primeira vez)
 * - Precisa perguntar qual location (multi-location sem active setada)
 * - Chama LLM com tools pra resolver o pedido
 *
 * Retorna texto pra o webhook enviar via GHL.
 */

import { GHLClient } from "@/lib/ghl/client";
import { trackAndCharge } from "@/lib/billing/charge";
import { createAdminClient } from "@/lib/supabase/admin";
import type { RepIdentity, RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import {
  TERMS_OF_USE_TEXT,
  TERMS_REJECTED_TEXT,
  TERMS_REMINDER_TEXT,
  parseTermsResponse,
} from "./terms";
import { buildOnboardingForWhatsApp } from "./onboarding";
import { acceptTerms, rejectTerms, setActiveLocation, syncRepInternalFlag } from "./identity";
import { buildSparkbotSystemPrompt, buildSparkbotRuntimeContext, loadCarrierTier1 } from "./prompt-builder";
import { runWithTools, type LLMMessage } from "./llm-client";
import { getAllToolDefinitions, executeTool, type ToolContext } from "./tools";
import { recordSignalAsync } from "@/lib/admin-signals/recorder";
// H29/H30/H31 (Pedro 2026-05-15): Conversational UX layer
import {
  detectRepStyle,
  styleHintForRep,
  computeSmartDefaults,
  renderSmartDefaultsForPrompt,
  createTurnContext,
  renderTurnContextForPrompt,
  autoRegisterFromToolResult,
  type TurnContextState,
} from "./conversational";

/**
 * Detector GENERALIZADO de hallucination POST-HOC.
 *
 * Pedro 2026-05-14, caso Gustavo: bot afirmou "Nota salva!" 8x seguidas
 * sem chamar create_note. Fix v1 cobria 4 famílias específicas. Pedro:
 * "talvez não é melhor criar uma regra geral?" → expandido pra 2 camadas:
 *
 *   1. ESPECÍFICO (8 famílias) — alta precisão, cita tool exata que
 *      satisfaz a claim. Pega o caso típico onde bot disse "X criado"
 *      mas chamou tool de família ERRADA (ex: "tag aplicada" mas chamou
 *      create_note).
 *
 *   2. GENÉRICO catch-all — qualquer verbo write em pretérito 1ª pessoa
 *      OU particípio passado + ZERO tools write chamadas no turn =
 *      hallucination. Pega famílias futuras (novas tools) sem update
 *      manual. Falso positivo aceitável (raro) — signal é só pra Pedro
 *      reviewar, não bloqueia resposta.
 *
 * Não bloqueia a resposta — só registra signal HIGH em admin_signals
 * pra Pedro reviewar no painel.
 */

/**
 * Tools de WRITE (qualquer mutação no Spark Leads ou state do bot).
 * Identificadas por prefix de nome. Mantido em sync com tools/index.ts
 * — quando adicionar tool nova com mutação, garante que prefixo bate.
 *
 * Tools de READ (search_*, list_*, get_*, query_*, preview_*) NÃO
 * satisfazem claim de "feito" — não contam como write.
 */
const WRITE_TOOL_NAME_PATTERNS = [
  /^create_/,
  /^update_/,
  /^delete_/,
  /^add_/,
  /^remove_/,
  /^complete_/,
  /^send_/,
  /^schedule_/,
  /^import_/,
  /^block_/,
  /^cancel_/,
  /^pause_/,
  /^resume_/,
  /^switch_/,
  /^confirm_/,
  /^set_/,
  /^forget_/,
  /^accept_/,
  /^reject_/,
  /^reply_/,
  /^assign_/,
  /^move_/,
  /^report_missed_capability/, // exceção: registra estado no painel
];

function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_NAME_PATTERNS.some((re) => re.test(toolName));
}

/**
 * Famílias específicas de claim → tools que satisfazem. Cada família tem
 * regex preciso (evita matches casuais). Se regex bate mas NENHUMA tool
 * da satisfying_tools foi chamada → hallucination específica.
 */
const HALLUCINATION_PATTERNS: Array<{
  family: string;
  regex: RegExp;
  satisfying_tools: string[];
}> = [
  {
    family: "note",
    regex:
      /\b(nota\s+(salva|criada|adicionada)|notas?\s+(salvas?|criadas?|adicionadas?)|anotei|anota[çc][oõ]es?\s+salvas?|coloquei\s+nas?\s+notas?|salvei\s+a\s+nota|anotado\s+(nos?\s+)?notes?)\b/i,
    satisfying_tools: ["create_note", "update_note"],
  },
  {
    family: "task",
    regex:
      /\b(task\s+(criada|adicionada|salva|completada|conclu[ií]da)|tarefa\s+(criada|adicionada|salva|completada|conclu[ií]da)|marquei\s+(a\s+)?task)\b/i,
    satisfying_tools: ["create_task", "update_task", "complete_task"],
  },
  {
    family: "tag",
    regex:
      /\btags?\s+(adicionada|aplicada|colocada|removida|tirada|posta)s?\b/i,
    satisfying_tools: ["add_tag", "remove_tag"],
  },
  {
    family: "reminder",
    regex:
      /\blembrete\s+(agendado|marcado|criado|salvo|cancelado|removido)s?\b/i,
    satisfying_tools: [
      "schedule_reminder",
      "schedule_recurring_reminder",
      "cancel_reminder",
    ],
  },
  {
    family: "appointment",
    regex:
      /\b(appointment|reuni[aã]o|agenda\s+do\s+cliente)\s+(marcad[ao]|agendad[ao]|criad[ao]|reagendad[ao]|cancelad[ao]|movid[ao])s?\b|\b(marquei|agendei|reagendei|cancelei)\s+(a\s+)?(reuni[aã]o|appointment|encontro)/i,
    satisfying_tools: [
      "create_appointment",
      "update_appointment",
      "delete_appointment",
      "block_calendar_slot",
    ],
  },
  {
    family: "message",
    regex:
      /\b(mensagem|msg|whatsapp|sms|email|mensagens|msgs)\s+(enviad[ao]|mandad[ao]|dispar[aá]d[ao]|agendad[ao]|cancelad[ao])s?\b|\b(mandei|enviei|disparei|despachei)\s+(a\s+|o\s+)?(mensagem|msg|whatsapp|sms|email|texto)\b/i,
    satisfying_tools: [
      "send_message_to_contact",
      "schedule_message_to_contact",
      "schedule_bulk_message",
      "cancel_scheduled_message",
      "pause_bulk_message",
      "resume_bulk_message",
      "cancel_bulk_message",
    ],
  },
  {
    family: "contact",
    regex:
      /\b(contato|lead|cliente)\s+(criad[ao]|adicionad[ao]|atualizad[ao]|alterad[ao]|deletad[ao]|apagad[ao]|removid[ao]|mergead[ao]|cadastrad[ao])s?\b|\b(criei|adicionei|atualizei|alterei|deletei|apaguei)\s+(o\s+)?(contato|lead|cliente)\b/i,
    satisfying_tools: ["create_contact", "update_contact", "delete_contact"],
  },
  {
    family: "opportunity",
    regex:
      /\b(oportunidade|opp|opportunity|deal|neg[oó]cio|pipeline)\s+(criad[ao]|adicionad[ao]|atualizad[ao]|movid[ao]|deletad[ao]|fechad[ao]|trocad[ao]|atribu[ií]d[ao])s?\b|\b(criei|movi|fechei|atualizei|atribu[ií])\s+(a\s+|o\s+)?(oportunidade|opp|deal|neg[oó]cio|pipeline)\b|\b(mov[ií])\s+pra\s+(M[0-9]|stage)/i,
    satisfying_tools: [
      "create_opportunity",
      "update_opportunity",
      "update_opportunity_status",
      "delete_opportunity",
    ],
  },
];

/**
 * Detector GENÉRICO catch-all: verbos write em pretérito 1ª pessoa OU
 * particípio + 0 tools write chamadas = afirmação sem ação.
 *
 * Pega famílias futuras automaticamente (alias, briefing, switch_location,
 * confirm_timezone, etc) sem update manual de regex específico.
 *
 * Falsos positivos possíveis (raros): "Acabei de listar" sem write tool
 * = OK porque "listar" não bate nos verbos write. Mas "Acabei de mostrar"
 * também não bate. Verbos selecionados são DEFINITIVAMENTE write.
 */
const GENERIC_WRITE_VERB_REGEX =
  /\b(criei|criamos|agendei|agendamos|marquei|marcamos|salvei|salvamos|anotei|anotamos|registrei|registramos|removi|removemos|adicionei|adicionamos|mandei|mandamos|enviei|enviamos|disparei|disparamos|atualizei|atualizamos|atribu[ií]|atribu[ií]mos|deletei|deletamos|apaguei|apagamos|completei|completamos|fechei|fechamos|movi|movemos|troquei|trocamos|bloqueei|bloqueamos|cancelei|cancelamos|pausei|pausamos|configurei|configuramos|confirmei|confirmamos|inseri|inserimos|despachei|despachamos|cadastrei|cadastramos|importei|importamos|sincronizei|sincronizamos|reagendei|reagendamos|reatribu[ií]|reatribu[ií]mos)\b/i;

function detectHallucination(
  responseText: string,
  toolsCalled: string[],
): Array<{ family: string; matched_text: string; detector: "specific" | "generic" }> {
  const found: Array<{
    family: string;
    matched_text: string;
    detector: "specific" | "generic";
  }> = [];

  // Camada 1: detectores específicos (precisos por família)
  const matchedFamilies = new Set<string>();
  for (const pattern of HALLUCINATION_PATTERNS) {
    const match = responseText.match(pattern.regex);
    if (!match) continue;
    matchedFamilies.add(pattern.family);
    const hasMatchingTool = pattern.satisfying_tools.some((t) =>
      toolsCalled.includes(t),
    );
    if (!hasMatchingTool) {
      found.push({
        family: pattern.family,
        matched_text: match[0],
        detector: "specific",
      });
    }
  }

  // Camada 2: detector genérico catch-all (pega famílias não-cobertas).
  // Só dispara se NENHUM detector específico bateu OU se bateu mas
  // NENHUMA tool write foi chamada (cobre caso onde bot disse "feito"
  // sem qualquer write tool).
  const genericMatch = responseText.match(GENERIC_WRITE_VERB_REGEX);
  if (genericMatch) {
    const writeToolsCalled = toolsCalled.filter(isWriteTool);
    if (writeToolsCalled.length === 0) {
      // Não tem nenhuma write tool no turn — afirmação totalmente sem suporte
      const alreadyReported = found.some((f) => f.matched_text === genericMatch[0]);
      if (!alreadyReported) {
        found.push({
          family: "generic_write",
          matched_text: genericMatch[0],
          detector: "generic",
        });
      }
    }
  }

  return found;
}

export interface ProcessInput {
  rep: RepIdentity;
  input: RepInput;
  agentId: string; // agent_id do Sparkbot na Hub location (pra billing/logs)
  /** Turns anteriores da conversa (da sessão de teste ou histórico real do GHL). */
  conversationHistory?: ConversationTurn[];
  /** Quando preenchido, rep está em modo teste — tools de scheduling marcam
   *  o reminder pra disparar nessa session. */
  testSessionId?: string | null;
  /**
   * Canal pelo qual o rep enviou a mensagem. Default 'whatsapp'.
   * - 'whatsapp': fluxo padrão; reminders agendados vão automático no WhatsApp
   * - 'web_ui': painel flutuante no GHL; bot deve perguntar canal antes de
   *   agendar lembrete (computador/celular/ambos)
   */
  channel?: "whatsapp" | "web_ui";
  config: {
    confirmation_mode?: "always" | "medium_and_high" | "high_only";
    ai_model?: string;
    // Configs adicionadas em 2026-05-03 (Sprint 1 — Pedro pediu pra expor)
    fallback_model?: string | null;
    custom_instructions?: string | null;
    knowledge_base_instructions?: string | null;
    disabled_tools?: string[];
    enabled_kbs?: string[];
    tone_creativity?: number | null;
    tone_formality?: number | null;
    tone_naturalness?: number | null;
    tone_aggressiveness?: number | null;
    enable_audio_transcription?: boolean;
    enable_image_analysis?: boolean;
    enable_pdf_reading?: boolean;
  };
}

export interface ProcessOutput {
  text: string;
  should_send: boolean;
  tokens?: { prompt: number; completion: number; cached: number };
  model_used?: string;
  tools_executed?: string[];
  /** Tool calls completos (input + result) pra debug. Só populado em teste. */
  tool_calls?: Array<{
    name: string;
    input: Record<string, unknown>;
    result: unknown;
  }>;
  /** True se runWithTools retornou stopped_reason='error' ou 'max_iterations'.
   *  Test endpoint deve persistir em metadata pra próximo turno detectar
   *  loop e responder com fallback explícito. */
  llm_failed?: boolean;
  /** Erro do model primário (Claude) se houve fallback. Logging diagnóstico. */
  primary_error?: string;
  /** Erro do model secundário (Claude Haiku) se também falhou. */
  secondary_error?: string;
}

export async function processIncoming(input: ProcessInput): Promise<ProcessOutput> {
  const { rep } = input;
  const userText = extractUserText(input.input);

  // Fix Track 8 (review 2026-05-05): processor responde direto se webhook
  // handler detectou erro de arquivo user-facing (HEIC, PDF vazio, file too
  // large). Antes: bot recebia o erro como caption text e respondia genérico
  // sem mencionar a real causa. Agora rep recebe a mensagem clara.
  if (userText.startsWith("__FILE_ERROR__:")) {
    return {
      text: userText.replace(/^__FILE_ERROR__:/, ""),
      should_send: true,
    };
  }

  // Fix CRITICAL Track 1 C1 (review 2026-05-05): se rep já rejeitou termos,
  // bot silencia. Antes, qualquer msg posterior caía no `!rep.terms_accepted_at`
  // de novo e re-mandava os termos → loop eterno. Pra desbloquear: admin
  // limpa `terms_rejected_at` no DB.
  if (!rep.terms_accepted_at && rep.terms_rejected_at) {
    return { text: "", should_send: false };
  }

  // 1. Termos de uso: se nunca aceitou, manda termos
  if (!rep.terms_accepted_at) {
    const parsed = parseTermsResponse(userText);
    if (parsed === "accept") {
      await acceptTerms(rep.id);
      // Onboarding 2026-05-04: ao aceitar termos, AUTO-confirma fuso lendo
      // location.timezone do GHL (sem perguntar pro rep). Mostra guia
      // rápido na mesma mensagem. Reduz fricção pra ~zero.
      const onboardingText = await buildOnboardingForWhatsApp(rep);
      return { text: onboardingText, should_send: true };
    }
    if (parsed === "reject") {
      // Fix Track 1 C1: persistir rejeição pra silenciar bot daqui em diante.
      await rejectTerms(rep.id);
      return { text: TERMS_REJECTED_TEXT, should_send: true };
    }
    // Primeira msg ou resposta unclear
    // Se nunca respondeu (assume que é primeira msg absoluta), manda termos
    // Se já viu os termos e respondeu unclear, manda reminder
    // Proxy: se display_name e ghl_users já estão populados mas terms null,
    // é primeira msg após identify. Mandamos os termos.
    // Se a msg parece tentar responder (>= 3 chars) e é unclear, manda reminder.
    if (userText.trim().length >= 3) {
      return { text: TERMS_REMINDER_TEXT, should_send: true };
    }
    return { text: TERMS_OF_USE_TEXT, should_send: true };
  }

  // 2. Resolver active_location_id
  if (rep.ghl_users.length === 0) {
    return {
      text: "Não achei seu cadastro em nenhuma location. Fale com o admin da sua agência pra ser autorizado.",
      should_send: true,
    };
  }

  let activeLocationId = rep.active_location_id;
  if (!activeLocationId && rep.ghl_users.length === 1) {
    activeLocationId = rep.ghl_users[0].location_id;
    await setActiveLocation(rep.id, activeLocationId);
  } else if (!activeLocationId && rep.ghl_users.length > 1) {
    // Tenta interpretar a mensagem como escolha de location
    const chosen = rep.ghl_users.find(
      (u) =>
        u.location_name &&
        userText.toLowerCase().includes(u.location_name.toLowerCase()),
    );
    if (chosen) {
      await setActiveLocation(rep.id, chosen.location_id);
      activeLocationId = chosen.location_id;
    } else {
      // Pergunta
      const list = rep.ghl_users
        .map((u, i) => `${i + 1}. ${u.location_name || u.location_id}`)
        .join("\n");
      return {
        text: `Você tá cadastrado em mais de uma location. Em qual quer operar agora?\n${list}\n\nMe manda o número ou o nome.`,
        should_send: true,
      };
    }
  }

  if (!activeLocationId) {
    return { text: "Tive problema identificando sua location.", should_send: true };
  }

  const activeLink = rep.ghl_users.find((u) => u.location_id === activeLocationId)!;

  // 3. Buscar info da location pra timezone + company_id
  const supabase = createAdminClient();
  const { data: location } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name, timezone")
    .eq("location_id", activeLocationId)
    .maybeSingle();

  if (!location) {
    return {
      text: "Não tenho dados dessa location ainda. Pede pro admin fazer login no dashboard primeiro.",
      should_send: true,
    };
  }

  // Fix bug observado em prod 2026-05-03: rep BR levou lembrete em horário NY
  // porque timezone vinha da location (definida pelo admin da agência), não
  // do REP. Resolution chain: rep.timezone (GHL user) → location.timezone →
  // 'America/New_York'. Lazy backfill: se rep ainda não tem timezone (legacy
  // rows pré-00045), busca do GHL agora e persiste — uma única vez por rep.
  let repTimezone = rep.timezone || null;
  if (!repTimezone) {
    try {
      const ghlClientForBackfill = new GHLClient(location.company_id, activeLocationId);
      const res = await ghlClientForBackfill.get<{
        users?: Array<{ id: string; timezone?: string }>;
      }>("/users/", { locationId: activeLocationId });
      const ghlUserId = activeLink.ghl_user_id;
      const u = (res.users || []).find((x) => x.id === ghlUserId);
      const tz = (u?.timezone || "").trim();
      if (tz) {
        repTimezone = tz;
        // Persiste pra próximas turns nem precisarem dessa chamada extra
        await supabase
          .from("rep_identities")
          .update({ timezone: tz, updated_at: new Date().toISOString() })
          .eq("id", rep.id);
      }
    } catch (err) {
      console.warn(
        `[processor] timezone backfill falhou (não-fatal) pra rep=${rep.id}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  const timezone = repTimezone || location.timezone || "America/New_York";
  // Locale baseado em timezone (pt-BR pro Brasil, en-US pros EUA)
  const locale = timezone.startsWith("America/") && !timezone.includes("Sao_Paulo") && !timezone.includes("Fortaleza") && !timezone.includes("Recife") && !timezone.includes("Manaus") && !timezone.includes("Belem") && !timezone.includes("Bahia")
    ? "en-US"
    : "pt-BR";

  // 4. Build prompt + messages.
  // Carrier Tier 1 carregado em paralelo — chunks priority='always' (~5KB).
  // Se KB vazia ou fail, fica string vazia e seção é omitida.
  // Carrier KB Tier 1 + Knowledge Base genérica (admin uploads) em paralelo.
  // KB items filtrados por agent_id — RLS deny anon protege. Falha = lista vazia.
  const loadKbItems = async (): Promise<Array<{
    title: string; type: "text" | "file" | "url"; content: string;
    file_name: string | null; file_url: string | null;
    description: string | null; usage_instructions: string | null;
  }>> => {
    try {
      const r = await supabase
        .from("knowledge_base")
        .select("title,type,content,file_name,file_url,description,usage_instructions")
        .eq("agent_id", input.agentId)
        .order("created_at", { ascending: false })
        .limit(50);
      return (r.data || []) as Array<{
        title: string; type: "text" | "file" | "url"; content: string;
        file_name: string | null; file_url: string | null;
        description: string | null; usage_instructions: string | null;
      }>;
    } catch (err) {
      console.warn(
        "[processor] knowledge_base load falhou (não-fatal):",
        err instanceof Error ? err.message : err,
      );
      return [];
    }
  };
  const [carrierOverview, kbItems] = await Promise.all([
    loadCarrierTier1("national_life_group").catch((err) => {
      console.warn("[processor] loadCarrierTier1 falhou (não-fatal):", err);
      return "";
    }),
    loadKbItems(),
  ]);

  const channel = input.channel || "whatsapp";

  // H29/H30/H31 — Conversational layer (Pedro 2026-05-15)
  // Detecta tom do rep das últimas mensagens dele no histórico.
  const recentUserMessages = (input.conversationHistory || [])
    .filter((t) => t.role === "user")
    .map((t) => t.content)
    .slice(-5);
  const repStyle = detectRepStyle(recentUserMessages);
  const ghlClientForCtx = new GHLClient(location.company_id, activeLocationId);
  const tempToolCtx: ToolContext = {
    rep,
    locationId: activeLocationId,
    companyId: location.company_id,
    ghlClient: ghlClientForCtx,
    confirmationMode: input.config.confirmation_mode || "high_only",
    testSessionId: input.testSessionId || null,
  };
  const smartDefaults = computeSmartDefaults(tempToolCtx);
  // Popula turn-context com tool_results dos últimos 2-3 turns. Permite
  // bot ver "entidades já resolvidas" e evitar re-buscar (caso Gustavo:
  // bot perguntando "qual contato?" depois de já ter achado).
  const turnContextState: TurnContextState = createTurnContext();
  try {
    const recentTurns = (input.conversationHistory || []).slice(-6);
    for (const turn of recentTurns) {
      // Parse tool_calls embebidos no content (formato OpenAI compatível)
      // Não-fatal: se falhar parse, ignora.
      if (turn.role !== "assistant") continue;
      // Histórico nosso guarda tool_calls como metadata? Vou tentar via
      // regex simples no content (pode ser melhorado V2)
      const calls = (turn as { tool_calls?: Array<{ name?: string; result?: unknown }> }).tool_calls;
      if (Array.isArray(calls)) {
        for (const tc of calls) {
          if (tc.name && tc.result) {
            const resultData = (tc.result as { data?: unknown }).data || tc.result;
            autoRegisterFromToolResult(turnContextState, tc.name, resultData);
          }
        }
      }
    }
  } catch (err) {
    console.warn("[processor] turn-context populate failed (non-fatal):", err);
  }
  const verbosityPref = (rep.profile?.preferences as { verbosity?: "brief" | "normal" | "detailed" } | undefined)?.verbosity;

  const systemPrompt = buildSparkbotSystemPrompt({
    rep,
    locationName: activeLink.location_name || location.location_name || activeLocationId,
    locationTimezone: timezone,
    locale,
    confirmationMode: input.config.confirmation_mode || "high_only",
    carrierOverview,
    channel,
    customInstructions: input.config.custom_instructions ?? null,
    kbInstructions: input.config.knowledge_base_instructions ?? null,
    kbItems,
    tones: {
      creativity: input.config.tone_creativity ?? null,
      formality: input.config.tone_formality ?? null,
      naturalness: input.config.tone_naturalness ?? null,
      aggressiveness: input.config.tone_aggressiveness ?? null,
    },
    conversationalLayer: {
      repStyleHint: styleHintForRep(repStyle),
      smartDefaultsBlock: renderSmartDefaultsForPrompt(smartDefaults),
      // turnContextBlock vazio no início — preenchido conforme tools rodam
      turnContextBlock: renderTurnContextForPrompt(turnContextState),
      verbosityPref,
    },
  });

  const runtimeContext = buildSparkbotRuntimeContext({
    locationTimezone: timezone,
    locale,
    channel,
  });

  // Constrói user message (pode ter imagem anexada)
  const userMessage: LLMMessage = buildUserMessage(input.input, runtimeContext);

  // 5. LLM call com tools — prepend histórico da sessão (turns anteriores como
  // user/assistant messages). Alto benefício pra cache hit: turns anteriores
  // são byte-exact estáveis, só o último muda.
  const history: LLMMessage[] = (input.conversationHistory || []).map((t) => ({
    role: t.role,
    content: t.content,
  }));

  const ghlClient = ghlClientForCtx;
  const toolCtx: ToolContext = {
    rep,
    locationId: activeLocationId,
    companyId: location.company_id,
    ghlClient,
    testSessionId: input.testSessionId || null,
    confirmationMode: input.config.confirmation_mode || "high_only",
    // Tools (ex: import_contacts_from_data) acessam rows via ctx.attachment
    // pra economizar tokens vs LLM copiando rows no args.
    attachment: input.input.kind === "tabular" || input.input.kind === "image" || input.input.kind === "document"
      ? input.input
      : null,
    enabledKbs: input.config.enabled_kbs,
  };

  const result = await runWithTools({
    systemPrompt,
    messages: [...history, userMessage],
    // Passa o confirmationMode pra getAllToolDefinitions injetar
    // `confirmed_by_rep` no schema das tools que o gate exige — sem isso
    // o LLM não tem como saber que precisa enviar o flag e fica em loop
    // "Confirma? → sim → bloqueado de novo" (visto em prod 2026-04-30).
    tools: getAllToolDefinitions(
      input.config.confirmation_mode || "high_only",
      input.config.disabled_tools,
    ),
    executor: (name, args) => executeTool(name, args, toolCtx),
    model: input.config.ai_model,
    fallbackModel: input.config.fallback_model,
  });

  // 5b. Detectar falhas consecutivas de LLM (parse error / max iterations).
  // Igual o sales tem em ai_paused_reason. Pra Sparkbot, conta turns
  // recentes em assistant_test_messages via testSessionId; se 2 falhas
  // seguidas, sinaliza degradado e oferece fallback ao rep em vez de loop.
  const llmFailed =
    result.stopped_reason === "error" || result.stopped_reason === "max_iterations";
  if (llmFailed && input.testSessionId) {
    const supabase2 = createAdminClient();
    const { data: lastAgentMsgs } = await supabase2
      .from("agent_test_messages")
      .select("metadata")
      .eq("session_id", input.testSessionId)
      .eq("role", "agent")
      .order("created_at", { ascending: false })
      .limit(1);
    const lastMeta = (lastAgentMsgs?.[0]?.metadata || {}) as { llm_failed?: boolean };
    if (lastMeta.llm_failed === true) {
      // Segunda falha consecutiva — pausa e devolve mensagem de retry explícita
      console.error(
        `[Sparkbot] 2 LLM failures consecutivas pra rep=${rep.id} session=${input.testSessionId} reason=${result.stopped_reason}`,
      );
      return {
        text:
          "Tô com problema técnico aqui há dois turnos seguidos. Pode tentar de novo daqui a pouco? " +
          "Se persistir, fala com o admin pra checar o sistema.",
        should_send: true,
        model_used: result.model_used,
        tokens: {
          prompt: result.prompt_tokens,
          completion: result.completion_tokens,
          cached: result.cached_tokens,
        },
        tool_calls: result.tool_calls,
        tools_executed: result.tool_calls.map((tc) => tc.name),
      };
    }
  }

  // 6. Billing — internal team (agency owner/admins) NÃO é cobrado.
  // syncRepInternalFlag detecta via env phones / role agency / heurística
  // de muitas locations. Idempotente, atualiza DB só se valor mudou.
  if (result.prompt_tokens > 0) {
    const isInternal = await syncRepInternalFlag(rep).catch(() => rep.is_internal === true);
    try {
      await trackAndCharge({
        locationId: activeLocationId,
        companyId: location.company_id,
        agentId: input.agentId,
        contactId: rep.id,
        actionType: "account_assistant_turn",
        model: result.model_used,
        promptTokens: result.prompt_tokens,
        completionTokens: result.completion_tokens,
        cachedTokens: result.cached_tokens,
        // Internal team usa "custom key" semantics: tracked em usage_records
        // mas NÃO cobrado do wallet. Audit trail mantido pra Pedro ver custo
        // mesmo internal em Supabase queries.
        usesCustomKey: isInternal,
      });
    } catch (err) {
      console.error("[Sparkbot] Billing failed (non-blocking):", err instanceof Error ? err.message : err);
    }
  }

  // Detector post-hoc de hallucination (Pedro 2026-05-14, caso Gustavo).
  // 2 camadas: específico (8 famílias) + genérico (qualquer verbo write
  // pretérito sem write tool no turn). Resposta do bot inclui afirmação
  // de write SEM tool_call correspondente → signal HIGH no painel.
  // Não bloqueia a resposta — UX preservada. Pedro reviewa no painel.
  if (result.text) {
    const toolsCalled = result.tool_calls.map((tc) => tc.name);
    const hallucinations = detectHallucination(result.text, toolsCalled);
    for (const h of hallucinations) {
      recordSignalAsync({
        type: "failure",
        title: `Hallucination ${h.family} sem tool_call (${h.detector})`,
        description:
          `Bot afirmou "${h.matched_text}" mas ${
            h.detector === "specific"
              ? `nenhuma tool da família ${h.family} foi chamada no turn`
              : `NENHUMA tool de write foi chamada no turn`
          }. Caso Gustavo 2026-05-14 (8 hits create_note) deve servir de referência. Fingerprint dedupa repetições.`,
        severity: "high",
        source: "bot_auto",
        metadata: {
          rep_id: rep.id,
          rep_phone: rep.phone,
          location_id: activeLocationId,
          agent_id: input.agentId,
          family: h.family,
          detector: h.detector,
          matched_text: h.matched_text,
          response_preview: result.text.slice(0, 300),
          tools_called: toolsCalled,
          model_used: result.model_used,
        },
      });
      console.warn(
        `[Sparkbot] HALLUCINATION DETECTED rep=${rep.id} family=${h.family} detector=${h.detector} matched="${h.matched_text}" tools=[${toolsCalled.join(",")}]`,
      );
    }
  }

  return {
    text: result.text || "Não consegui gerar resposta. Tenta de novo?",
    should_send: true,
    tokens: {
      prompt: result.prompt_tokens,
      completion: result.completion_tokens,
      cached: result.cached_tokens,
    },
    model_used: result.model_used,
    tools_executed: result.tool_calls.map((tc) => tc.name),
    tool_calls: result.tool_calls,
    llm_failed: llmFailed,
    primary_error: result.primary_error,
    secondary_error: result.secondary_error,
  };
}

/** Extrai texto de qualquer forma de RepInput (pra parsing de termos etc). */
function extractUserText(input: RepInput): string {
  switch (input.kind) {
    case "text":
      return input.text;
    case "audio":
      return input.transcribed_text;
    case "image":
      return input.caption || "";
    case "document":
      return input.extracted_text.substring(0, 500);
    case "tabular":
      return input.caption || "";
  }
}

/** Constrói user message no formato do LLM (suporta imagem multimodal). */
function buildUserMessage(input: RepInput, runtimeContext: string): LLMMessage {
  const header = `${runtimeContext}\n\n`;

  if (input.kind === "text") {
    return { role: "user", content: `${header}${input.text}` };
  }
  if (input.kind === "audio") {
    return {
      role: "user",
      content: `${header}[Rep enviou áudio — transcrição abaixo]\n"${input.transcribed_text}"`,
    };
  }
  if (input.kind === "document") {
    const preview = input.extracted_text.substring(0, 3000);
    return {
      role: "user",
      content: `${header}[Rep enviou documento "${input.filename}" — conteúdo extraído]\n${preview}`,
    };
  }
  if (input.kind === "tabular") {
    const t = input.tabular;
    // 10 linhas: o suficiente pra LLM detectar variedade de formato
    // (telefones com/sem DDI, nomes vazios, etc.) sem inflar o prompt.
    const sampleRows = t.rows.slice(0, 10);
    const lines: string[] = [];
    lines.push(`[Rep anexou planilha "${t.filename}" — ${t.total_rows} linhas, ${t.columns.length} colunas]`);
    if (t.sheets && t.sheets.length > 1) {
      lines.push(`Sheets: ${t.sheets.map((s) => s.name).join(", ")}. Ativa: "${t.active_sheet}"`);
    }
    lines.push(`Colunas: ${t.columns.join(" | ")}`);
    lines.push(`Amostra de ${sampleRows.length} linhas (de ${t.total_rows} totais):`);
    sampleRows.forEach((row, i) => {
      const compact = t.columns.map((c) => `${c}=${row[c] ?? ""}`).join(" | ");
      lines.push(`  ${i + 1}. ${compact}`);
    });
    if (t.total_rows > sampleRows.length) {
      lines.push(`  […+${t.total_rows - sampleRows.length} linhas não mostradas no prompt — mas as tools veem TODAS]`);
    }
    if (input.caption) {
      lines.push("");
      lines.push(`Mensagem do rep: ${input.caption}`);
    }
    lines.push("");
    lines.push(
      "REGRAS CRÍTICAS sobre planilhas anexadas:",
    );
    lines.push(
      `1. As ${t.total_rows} linhas COMPLETAS já estão acessíveis às tools via ` +
      "ctx.attachment — você NÃO precisa pedir 'reanexa o CSV' pra processar mais. " +
      "A amostra acima é só pro seu entendimento do formato.",
    );
    lines.push(
      "2. Pra IMPORTAR contatos: use `import_contacts_from_data`. Ela processa " +
      "TODAS as linhas, cria notes (se mapping.notes setado), aplica tags, idempotente.",
    );
    lines.push(
      "3. NÃO tente iterar manualmente: NÃO chame search_contacts + create_note " +
      "linha a linha. import_contacts_from_data já faz isso em batch.",
    );
    lines.push(
      "4. Se o rep esqueceu de mapear notes na primeira tentativa, basta " +
      "RECHAMAR import_contacts_from_data com o mapping correto — é idempotente " +
      "(Spark Leads faz dedup por phone/email), só cria as notas que faltaram.",
    );
    return { role: "user", content: lines.join("\n") };
  }
  // image — multimodal content
  const match = input.base64_data_uri.match(/^data:(image\/\w+);base64,(.+)$/);
  if (!match) {
    return {
      role: "user",
      content: `${header}[Rep enviou imagem mas não consegui processar]${input.caption ? `\nCaption: ${input.caption}` : ""}`,
    };
  }
  return {
    role: "user",
    content: [
      { type: "text", text: `${header}${input.caption || "[Rep enviou imagem]"}` },
      {
        type: "image",
        source: { type: "base64", media_type: match[1], data: match[2] },
      },
    ],
  };
}
