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
// F3/F10 (contact-resolution 2026-06): "contato em foco" + buffer de contatos recentes.
import {
  getActiveContactContext,
  renderContactInFocusBlock,
  readRecentContacts,
  recordRecentContact,
} from "./contact-resolver";
import type { RepIdentity, RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import {
  TERMS_OF_USE_TEXT,
  buildTermsInteractive,
  TERMS_REJECTED_TEXT,
  parseTermsResponse,
  buildGroupCampaignTermsInteractive,
  GROUP_CAMPAIGN_TERMS_ACCEPTED_TEXT,
  GROUP_CAMPAIGN_TERMS_REJECTED_TEXT,
} from "./terms";
import { buildOnboardingForWhatsApp } from "./onboarding";
import {
  acceptTerms,
  rejectTerms,
  acceptGroupCampaignTerms,
  rejectGroupCampaignTerms,
  clearGroupCampaignTermsPendingState,
  setActiveLocation,
  syncRepInternalFlag,
} from "./identity";
import { buildSparkbotSystemPrompt, buildSparkbotRuntimeContext, buildRepContextBlock, loadCarrierTier1, type BuildPromptArgs } from "./prompt-builder";
import { assembleSystemPrompt, isUnifiedMotorEnabled } from "@/lib/agent-platform/assembler";
import { runWithTools, type LLMMessage } from "./llm-client";
import { getAllToolDefinitions, executeTool, type ToolContext } from "./tools";
import { runSparkbotTurn, buildToolCtx } from "./core/run-sparkbot-turn";
import {
  extractInteractiveFromToolCalls,
  detectNumberedOptionsFallback,
  interactiveFallbackText,
  type InteractivePayload,
} from "./core/interactive";
import { recordSignalAsync } from "@/lib/admin-signals/recorder";
import { reportError } from "@/lib/admin-signals/report-error";
// H29/H30/H31 (Pedro 2026-05-15): Conversational UX layer
// + 4.3 (Pedro 2026-05-16): silence recovery
import {
  detectRepStyle,
  styleHintForRep,
  computeSmartDefaults,
  renderSmartDefaultsForPrompt,
  createTurnContext,
  renderTurnContextForPrompt,
  detectSilenceGap,
  renderSilenceRecoveryForPrompt,
  type TurnContextState,
} from "./conversational";
import {
  analyzeCoherence,
  HONEST_FALLBACK_FINGERPRINT,
  type ToolCallRecord,
} from "./core/coherence-gate";
import {
  findBotEcho,
  isNearDuplicate,
  REPEAT_BREAK_DIRECTIVE,
  REPEAT_HARD_FALLBACK,
} from "./core/repeat-guard";

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
  /** B0 (Onda B 2026-07-21): usage por chamada LLM (anatomia real do turno).
   *  Persiste em sparkbot_messages.metadata.call_usage. */
  call_usage?: Array<{ fresh: number; read: number; write: number; out: number }>;
  /** True se runWithTools retornou stopped_reason='error' ou 'max_iterations'.
   *  Test endpoint deve persistir em metadata pra próximo turno detectar
   *  loop e responder com fallback explícito. */
  llm_failed?: boolean;
  /** Erro do model primário (Claude) se houve fallback. Logging diagnóstico. */
  primary_error?: string;
  /** Erro do model secundário (Claude Haiku) se também falhou. */
  secondary_error?: string;
  /** Payload interativo (botões/listas) quando o LLM chamou present_options.
   *  O canal de envio decide renderizar (WhatsApp) ou cair pro `text` (web/GHL).
   *  `text` SEMPRE traz o fallback (corpo + opções numeradas). */
  interactive?: InteractivePayload;
  /** Origem do interativo: "present_options" (LLM chamou) ou "backstop" (LLM
   *  escreveu lista numerada e o sistema converteu). Métrica de adesão. */
  interactive_via?: "present_options" | "backstop";
  /** H47-F0 (telemetria 2026-07-10): resumo compacto das resoluções de contato do
   *  turno (1 entrada por search_contacts). Persiste na metadata da msg do agent →
   *  vira o funil re-rodável (confidence × desfecho) do plano das 3 frentes. */
  contact_resolution?: Array<{
    q: string;
    method?: string;
    confidence?: string;
    score?: number;
    alts?: number;
  }>;
}

/** H47-F0: extrai o resumo de resolução de contato dos tool_calls do turno. */
function summarizeContactResolution(
  toolCalls: Array<{ name: string; input: Record<string, unknown>; result: unknown }>,
): ProcessOutput["contact_resolution"] {
  const out: NonNullable<ProcessOutput["contact_resolution"]> = [];
  for (const tc of toolCalls) {
    if (tc.name !== "search_contacts") continue;
    const r = tc.result as { status?: string; data?: Record<string, unknown> } | undefined;
    const d = r?.data || {};
    const bm = d.best_match as { score?: number } | undefined;
    out.push({
      q: String((tc.input as Record<string, unknown>)?.query ?? "").slice(0, 60),
      method: typeof d.method === "string" ? d.method : undefined,
      confidence: typeof d.confidence === "string" ? d.confidence : r?.status === "not_found" ? "not_found" : undefined,
      score: typeof bm?.score === "number" ? bm.score : undefined,
      alts: Array.isArray(d.contacts) ? (d.contacts as unknown[]).length : undefined,
    });
  }
  return out.length > 0 ? out.slice(0, 10) : undefined;
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
    // unclear (incl. comando substantivo) → SEMPRE manda os TERMOS com botão.
    // Fix bug 2026-05-20 (rep silenciado): antes, msg >=3 chars caía num reminder
    // terso (rep nunca via os termos) e — pior — uma negação enterrada num
    // comando virava REJECT/silêncio. Agora o rep SEMPRE vê o botão Aceito/Não e
    // nunca é silenciado por engano. No WhatsApp vira botão; em canal sem
    // interativo o text-fallback traz termos + opções numeradas. Aceite por tap
    // OU "aceito" digitado.
    // Humanização (estudo 2026-06-24, fix 1.9): se o rep mandou um PEDIDO real
    // (não só "oi"/"tudo bem"), reconhece a intenção antes do paredão de termos
    // pra não soar que ignorou ele (caso Matheus: tentou marcar Zoom 4× e levou
    // o bloco 4× sem reconhecimento, desistiu).
    const normReq = userText.trim().toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
    const GREETINGS = ["oi", "ola", "opa", "eai", "e ai", "bom dia", "boa tarde", "boa noite", "tudo bem", "tudo bom", "teste", "test", "hi", "hello", "ok", "blz", "beleza"];
    const looksLikeRequest = normReq.length > 6 && !GREETINGS.includes(normReq);
    const ackPrefix = looksLikeRequest
      ? "Opa, já vi que você quer começar a usar! 🙌 Eu já te ajudo com isso — só preciso que aceite os termos rapidinho aqui embaixo 👇"
      : undefined;
    const termsInteractive = buildTermsInteractive(ackPrefix);
    // Ultra-review 2026-07-17 (caso Willian): rep preso no gate de termos 3+
    // vezes em 24h = provável formato de aceite que o parser não entende →
    // sinal pro admin destravar na mão em vez de churn silencioso. Fire-and-
    // forget: nunca atrasa nem derruba o reenvio.
    void (async () => {
      try {
        const sb = createAdminClient();
        const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { count } = await sb
          .from("sparkbot_messages")
          .select("id", { count: "exact", head: true })
          .eq("rep_id", rep.id)
          .eq("role", "user")
          .gte("created_at", dayAgo);
        if (typeof count === "number" && count >= 3) {
          reportError({
            title: `📝 Rep preso no gate de termos (${rep.display_name || rep.id})`,
            feature: "sparkbot-terms",
            severity: "medium",
            description:
              `Rep mandou ${count} msgs em 24h e segue sem aceite registrado — o parser pode não estar ` +
              `entendendo o formato da resposta dele. Última msg: "${userText.slice(0, 120)}". ` +
              `Destravar: UPDATE rep_identities SET terms_accepted_at=now() WHERE id='${rep.id}'.`,
            metadata: { rep_id: rep.id, phone: rep.phone, msgs_24h: count },
          });
        }
      } catch { /* observabilidade best-effort */ }
    })();
    return {
      text: interactiveFallbackText(termsInteractive),
      interactive: termsInteractive,
      should_send: true,
    };
  }

  // 1b. Termos PARTE 2 (campanha de grupo, 2026-06-18). Só ativa quando o rep
  // ENTROU no fluxo de aceite (group_campaign_terms_pending_at setado pela tool
  // `group_campaign` schedule) e ainda não aceitou. Determinístico — reusa
  // parseTermsResponse. DIFERENÇA da Parte 1: reject NÃO silencia o SparkBot (só
  // bloqueia campanha de grupo); e na resposta ambígua a gente LIMPA o pending e
  // segue o fluxo normal (anti-trap: não prende o rep que mudou de assunto).
  // Fix P1 review 2026-06-18: NÃO exigir !rejected_at. Reject de grupo é
  // REVERSÍVEL (a copy promete "se mudar de ideia, é só falar") — se o rep
  // recusou antes e agora re-tenta agendar, a tool re-marca pending e este gate
  // PRECISA capturar o "aceito" mesmo com rejected_at setado, senão loop eterno.
  // accept/reject limpam o pending → o gate não re-dispara após resolver.
  if (rep.group_campaign_terms_pending_at && !rep.group_campaign_terms_accepted_at) {
    const parsedGroup = parseTermsResponse(userText);
    if (parsedGroup === "accept") {
      await acceptGroupCampaignTerms(rep.id);
      return { text: GROUP_CAMPAIGN_TERMS_ACCEPTED_TEXT, should_send: true };
    }
    if (parsedGroup === "reject") {
      await rejectGroupCampaignTerms(rep.id);
      return { text: GROUP_CAMPAIGN_TERMS_REJECTED_TEXT, should_send: true };
    }
    // Ambíguo: se o texto PARECE resposta aos termos (curto), reapresenta o
    // botão; senão (rep mudou de assunto), limpa o pending e deixa fluir normal.
    const looksLikeTermsReply = userText.trim().split(/\s+/).filter(Boolean).length <= 4;
    if (looksLikeTermsReply) {
      const groupTerms = buildGroupCampaignTermsInteractive();
      return {
        text: interactiveFallbackText(groupTerms),
        interactive: groupTerms,
        should_send: true,
      };
    }
    await clearGroupCampaignTermsPendingState(rep.id);
    // fall through — processa a mensagem normalmente
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
      // Multi-location → present_options (lista/botão tocável). Fix review
      // 2026-05-20: antes era lista numerada em texto, fora do interativo.
      const locOptions = rep.ghl_users.map((u) => ({
        id: `loc_${u.location_id}`,
        label: u.location_name || u.location_id,
      }));
      const locNeedsList =
        locOptions.length > 3 || locOptions.some((o) => o.label.length > 20);
      const locPayload: InteractivePayload = {
        kind: locNeedsList ? "list" : "buttons",
        body: "Você tá em mais de uma location. Em qual quer operar agora?",
        options: locOptions,
      };
      return {
        text: interactiveFallbackText(locPayload),
        interactive: locPayload,
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

  // 2b. Wallet sem saldo (Pedro 2026-07-17, ultra-review P0-2): location sem
  // crédito → NÃO gasta LLM; resposta determinística ensina a recarregar na
  // wallet do Spark Leads. is_internal bypassa (não gera cobrança por design).
  // Desbloqueio é automático quando uma cobrança volta a passar (charge.ts).
  if (rep.is_internal !== true) {
    const { isWalletBlocked, WALLET_BLOCKED_REP_MESSAGE } = await import(
      "@/lib/billing/wallet-block"
    );
    if (await isWalletBlocked(activeLocationId)) {
      return { text: WALLET_BLOCKED_REP_MESSAGE, should_send: true };
    }
  }

  // 2c. Loop bot-a-bot (ultra-review 2026-07-17, P0 caso Fabiana): telefone de
  // canal lead-facing identificado como rep → ping-pong IA×IA que o silence-gate
  // não pega (todo inbound reseta o counter). Detecção determinística sobre as
  // últimas msgs; ao acusar: silencia ESTE turno + pausa proativos + signal.
  // H52 review adversarial: (a) SÓ roda no WhatsApp — o loop existe apenas via
  // telefone identificado como rep; no web_ui (painel autenticado, síncrono) um
  // power-user digitando rápido tripava o guard e era engolido em silêncio;
  // (b) a pausa leva `proactive_pause_source='loop_guard'` — o silence-reset de
  // inbound NÃO limpa essa origem (senão o rep-fantasma re-acendia o loop todo
  // dia); (c) rep já flagrado re-silencia com 2 trocas (não 6) — re-ignição por
  // follow-up do outro bot queima 1 turno, não 6.
  if (!input.testSessionId && (input.channel || "whatsapp") === "whatsapp") {
    try {
      const { data: recentMsgs } = await supabase
        .from("sparkbot_messages")
        .select("role, created_at, content, metadata")
        .eq("rep_id", rep.id)
        .eq("channel", "whatsapp")
        .order("created_at", { ascending: false })
        .limit(16);
      const { detectPingPongLoop, isHumanProofMsg } = await import(
        "@/lib/account-assistant/loop-guard"
      );
      const msgsAsc = (recentMsgs || [])
        .reverse()
        .map((m) => {
          const mm = m as { role?: string; created_at?: string; content?: string; metadata?: Record<string, unknown> };
          return {
            role: String(mm.role || ""),
            created_at: String(mm.created_at || ""),
            content_len: String(mm.content || "").length,
            // Ultra-review 2026-07-22 (caso Melissa): tap de menu/áudio = prova de
            // humano → quebra o padrão de loop no loop-guard (o fluxo interativo do
            // Agendamento V2 é rápido por ser 1 toque, não porque é bot-a-bot).
            is_human_proof: isHumanProofMsg(mm.content, mm.metadata),
          };
        });
      // H52 R2: a flag decai — threshold reduzido (2) só vale se o flagra é
      // RECENTE (<48h). Flag velha volta ao threshold padrão (6): um rep REAL
      // flagrado por engano não fica em modo degradado pra sempre (a pausa em
      // si expira em 7d via resetSilenceTracking).
      const repFlag = rep as {
        proactive_pause_source?: string | null;
        proactive_paused_at?: string | null;
      };
      const flaggedAtMs = repFlag.proactive_paused_at
        ? new Date(repFlag.proactive_paused_at).getTime()
        : 0;
      const alreadyFlagged =
        repFlag.proactive_pause_source === "loop_guard" &&
        Date.now() - flaggedAtMs < 48 * 60 * 60 * 1000;
      const loop = detectPingPongLoop(msgsAsc, alreadyFlagged ? 2 : undefined);
      if (loop.looping) {
        const nowIso = new Date().toISOString();
        // SEMPRE re-seta (sem checar rep.proactive_paused_at: o objeto é um
        // snapshot de ANTES do silence-reset do webhook — estaria stale).
        await supabase
          .from("rep_identities")
          .update({
            proactive_paused_at: nowIso,
            proactive_pause_source: "loop_guard",
            updated_at: nowIso,
          })
          .eq("id", rep.id);
        reportError({
          title: `🤖🔁 Possível loop bot-a-bot — SparkBot silenciado (${rep.display_name || rep.id})`,
          feature: "sparkbot-loop-guard",
          severity: "high",
          description:
            `${loop.exchanges} trocas consecutivas com resposta <90s e texto longo — padrão de ` +
            `auto-reply IA×IA (caso Fabiana 2026-07-17). Turno silenciado + proativos pausados ` +
            `(origem loop_guard: inbound NÃO despausa; limpar via admin: UPDATE rep_identities ` +
            `SET proactive_paused_at=NULL, proactive_pause_source=NULL WHERE id='${rep.id}'). ` +
            `Conferir se o telefone deste "rep" é na verdade um canal de agente lead-facing.`,
          metadata: {
            rep_id: rep.id,
            location_id: activeLocationId,
            phone: rep.phone,
            exchanges: loop.exchanges,
            already_flagged: alreadyFlagged,
          },
        });
        return { text: "", should_send: false };
      }
    } catch (err) {
      console.warn("[processor] loop-guard falhou (não-fatal):", err);
    }
  }
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
  // F11 (contact-resolution 2026-06): removido o seed cross-turn dead-code que iterava
  // turn.tool_calls — o loader de histórico (webhook-handler.ts:762-768) NUNCA popula esse
  // campo (sempre undefined), então era no-op silencioso. A herança de contato real agora vem
  // do "contato em foco" (F3) + recent_contacts (F10). turnContextState segue criado vazio
  // (consumido pelos detectores de loop/rajada do turno atual, não do histórico).
  const verbosityPref = (rep.profile?.preferences as { verbosity?: "brief" | "normal" | "detailed" } | undefined)?.verbosity;

  // 4.3 Pedro 2026-05-16: detecta silence gap. Lê últimas 4 msgs do rep
  // com created_at (ConversationTurn não tem timestamp, precisa query).
  // Caso Gustavo: 5h15min de silêncio entre "cancela" e "você tá funcionando?".
  // Fix M9 (review 2026-05-16): filtra por active_location_id pra evitar
  // falso positivo quando rep alterna entre locations.
  let silenceRecoveryBlock = "";
  try {
    const { data: recent } = await supabase
      .from("sparkbot_messages")
      .select("role, content, created_at")
      .eq("rep_identity_id", rep.id)
      .eq("active_location_id", activeLocationId)
      .order("created_at", { ascending: false })
      .limit(6);
    if (recent && recent.length >= 2) {
      const msgs = recent.reverse() as Array<{ role: "user" | "assistant" | "system"; content: string; created_at: string }>;
      const gap = detectSilenceGap(msgs, 30);
      if (gap) {
        silenceRecoveryBlock = renderSilenceRecoveryForPrompt(gap);
        console.log(`[processor] silence gap detectado: ${gap.gap_minutes}min (bot_was_waiting=${gap.bot_was_waiting})`);
      }
    }
  } catch (err) {
    console.warn("[processor] silence-recovery check falhou (não-fatal):", err);
  }

  // Plataforma Modular (Fase 1): args do prompt do SparkBot, montados uma vez.
  const sparkbotPromptArgs: BuildPromptArgs = {
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
      // 4.3 Pedro 2026-05-16: bloco silence recovery quando gap >30min
      silenceRecoveryBlock,
    },
  };
  // Motor unificado (flag default OFF). Na Fase 1 o assembler DELEGA pro builder
  // existente → output idêntico; a flag separa só o caminho. Ver assembler.ts.
  const systemPrompt = isUnifiedMotorEnabled()
    ? assembleSystemPrompt({ templateKey: "sparkbot", audience: "rep", sparkbotArgs: sparkbotPromptArgs })
    : buildSparkbotSystemPrompt(sparkbotPromptArgs);

  let runtimeContext = buildSparkbotRuntimeContext({
    locationTimezone: timezone,
    locale,
    channel,
    // F1 (cost-reduction 2026-06): os blocos voláteis vão pela user message (não-cacheada),
    // não mais pelo system prompt. Reusa o objeto já montado em sparkbotPromptArgs (o system
    // ignora esse campo agora). Mantém o prefixo cacheado byte-estável por-conversa.
    conversationalLayer: sparkbotPromptArgs.conversationalLayer,
    // B3 (Onda B custo 2026-07-21): FORMATO DE HORA + CONTEXTO DO REP + MEMÓRIA saíram do
    // system (única variação por-rep) → system byte-idêntico por config = cache compartilhado
    // entre os 55 reps do hub. Strings verbatim, mesma informação disponível ao LLM.
    repContextBlock: buildRepContextBlock({
      rep,
      locationName: sparkbotPromptArgs.locationName,
      locationTimezone: timezone,
      locale,
    }),
  });

  // F3 (contact-resolution 2026-06): "CONTATO EM FOCO" — herda o contact_id de um proativo
  // recente (F1/F8) ou de contatos resolvidos no chat (F10), pra o bot NÃO re-buscar do zero
  // quando o rep responde "marca o follow-up dele" (caso Fernanda). Pista que se re-valida,
  // nunca id cego. Vai no runtime context (user message, não-cacheada) → não mexe no cache (H44).
  try {
    const activeContact = await getActiveContactContext(supabase, rep.id, {
      activeLocationId,
      recentContacts: readRecentContacts(rep.profile),
    });
    const focusBlock = renderContactInFocusBlock(activeContact);
    if (focusBlock) runtimeContext = `${runtimeContext}\n\n${focusBlock}`;
  } catch (err) {
    console.warn("[processor] contato-em-foco (F3) falhou (não-fatal):", err);
  }

  // Constrói user message (pode ter imagem anexada)
  const userMessage: LLMMessage = buildUserMessage(input.input, runtimeContext);

  // 5. LLM call com tools — prepend histórico da sessão (turns anteriores como
  // user/assistant messages). Alto benefício pra cache hit: turns anteriores
  // são byte-exact estáveis, só o último muda.
  // Fix review 2026-06-05: filtra turns com content STRING vazio. Claude rejeita
  // histórico com mensagem de content "" (400 invalid_request) — mantém os de
  // content não-string (imagem) intactos.
  const history: LLMMessage[] = (input.conversationHistory || [])
    .filter((t) => typeof t.content !== "string" || t.content.trim().length > 0)
    .map((t) => ({
      role: t.role,
      content: t.content,
    }));

  // ToolContext explícito pra ser reutilizado pelo coherence gate re-run abaixo.
  const toolCtx: ToolContext = buildToolCtx({
    rep,
    locationId: activeLocationId,
    companyId: location.company_id,
    ghlClient: ghlClientForCtx,
    testSessionId: input.testSessionId,
    confirmationMode: input.config.confirmation_mode || "high_only",
    // Tools (ex: import_contacts_from_data) acessam rows via ctx.attachment
    // pra economizar tokens vs LLM copiando rows no args.
    attachment:
      input.input.kind === "tabular" || input.input.kind === "image" || input.input.kind === "document"
        ? input.input
        : null,
    enabledKbs: input.config.enabled_kbs,
  });

  // P2 (2026-05-20): usa runSparkbotTurn (helper compartilhado com dispatcher).
  // Passa o confirmationMode pra getAllToolDefinitions injetar `confirmed_by_rep`
  // no schema das tools que o gate exige — sem isso o LLM fica em loop
  // "Confirma? → sim → bloqueado de novo" (visto em prod 2026-04-30).
  // Stevo interativo (Pedro 2026-05-20): esconde present_options do LLM quando o
  // gate STEVO_INTERACTIVE_ENABLED tá off → bot idêntico a hoje. On = LLM pode usar
  // (e o prompt-builder ensina). Pareia com o gate de envio no stevo-handler.
  // web_ui sempre tem present_options (no painel vira lista numerada via
  // fallback; não depende do Stevo). WhatsApp depende de STEVO_INTERACTIVE_ENABLED.
  const interactiveEnabled =
    /^(1|true|yes)$/i.test(process.env.STEVO_INTERACTIVE_ENABLED?.trim() || "") ||
    input.channel === "web_ui";
  const disabledTools = interactiveEnabled
    ? input.config.disabled_tools
    : [...(input.config.disabled_tools || []), "present_options"];

  // H52 review adversarial R2: âncora do relógio do TURNO INTEIRO. Os reruns
  // do coherence-gate/anti-repeat abaixo herdam este relógio — sem isso cada
  // rerun re-ancorava 45s NOVOS (turno de 44s + rerun de 35s = 79s > hard-limit
  // 60s → lambda morta muda ANTES do billing/envio, a classe que o H52 mata).
  const turnStartedAt = Date.now();
  const result = await runSparkbotTurn({
    systemPrompt,
    messages: [...history, userMessage],
    toolCtx,
    toolSelection: {
      kind: "all",
      confirmationMode: input.config.confirmation_mode || "high_only",
      disabledTools,
    },
    model: input.config.ai_model,
    fallbackModel: input.config.fallback_model,
    // A1 (estudo de custo 2026-07-20) — REVERTE o F4/H44 ("cacheTtl: 1h"): o TTL 1h foi
    // medido NET-NEGATIVO (18% dos gaps entre turnos são >1h = frios de qualquer jeito,
    // vs só 10% na janela 5-60min que ele salvava) E SUB-COBRADO (a Anthropic fatura
    // write de 1h a 2x = $6/M no sonnet; pricing.ts cobrava o flat de 1.25x = ~$56-63/mês
    // de custo real invisível ao cost_usd). Voltamos ao default 5m. Se reativar um dia:
    // ANTES ler usage.cache_creation.ephemeral_{5m,1h} do SDK e cobrar o bucket 1h a 2x.
    //
    // A2 (estudo de custo 2026-07-20): present_options é tool TERMINAL — o texto final é
    // gerado deterministicamente (interactiveFallbackText, ~linha 1054) e o texto da
    // chamada LLM seguinte era DESCARTADO (683 chamadas/mês de ~76K tok pagas à toa).
    // Só encerra com payload VÁLIDO (mesma validação da extração); payload inválido ou
    // erro → o loop segue e o LLM escreve o texto como antes (os ~2% de casos inválidos).
    terminalTools: interactiveEnabled
      ? [
          {
            name: "present_options",
            validate: (inp) =>
              extractInteractiveFromToolCalls([{ name: "present_options", input: inp }]) !== null,
          },
        ]
      : undefined,
  });

  // F10 (contact-resolution 2026-06): registra contatos resolvidos NESTE turno no buffer
  // recent_contacts (rep_identities.profile) → o "contato em foco" (F3) os herda no próximo
  // turno (caso "achei o Pedro agora; marca reunião com ele"). Best-effort, não-fatal.
  try {
    for (const tc of result.tool_calls) {
      const r = tc.result as { status?: string; data?: Record<string, unknown> } | undefined;
      if (!r || r.status === "error") continue;
      const d = r.data || {};
      const input = (tc.input || {}) as Record<string, unknown>;
      const fn = input.firstName ?? input.first_name;
      const ln = input.lastName ?? input.last_name;
      const nameFromInput =
        (typeof input.name === "string" && input.name) ||
        [fn, ln].filter((x): x is string => typeof x === "string" && !!x).join(" ") ||
        undefined;
      let resolved: { id: string; name?: string } | null = null;
      // Cada tool devolve um SHAPE diferente (revisado contra o código real de contacts.ts):
      if (tc.name === "search_contacts" && d.confidence === "high" && d.best_match) {
        const bm = d.best_match as { id?: string; name?: string };
        if (bm.id) resolved = { id: bm.id, name: bm.name };
      } else if (tc.name === "create_contact") {
        const id = (d.contact_id || (d.contact as { id?: string } | undefined)?.id) as string | undefined;
        if (id) resolved = { id, name: nameFromInput };
      } else if (tc.name === "get_contact") {
        // H47-F1 (fix 2026-07-10): get_contact devolve data FLAT ({id, name, ...}, SEM
        // wrapper `contact` — ver contacts.ts). O código antigo lia `d.contact` → sempre
        // undefined → o caminho canônico de re-validação da herança NUNCA alimentava o
        // buffer. Lê flat primeiro; mantém `d.contact` como fallback defensivo.
        const c = ((d.contact as Record<string, unknown> | undefined) || d) as {
          id?: string; name?: string; contactName?: string; firstName?: string; lastName?: string;
        };
        if (c.id) resolved = { id: String(c.id), name: c.name || c.contactName || [c.firstName, c.lastName].filter(Boolean).join(" ") || undefined };
      } else if (tc.name === "update_contact") {
        const id = typeof input.contact_id === "string" ? input.contact_id : undefined;
        if (id) resolved = { id, name: nameFromInput };
      }
      if (resolved) await recordRecentContact(supabase, rep.id, resolved);
    }
  } catch (err) {
    console.warn("[processor] recent_contacts (F10) falhou (não-fatal):", err);
  }

  // 5b. Detectar falhas consecutivas de LLM (parse error / max iterations).
  // Igual o sales tem em ai_paused_reason. Pra Sparkbot, conta turns
  // recentes em assistant_test_messages via testSessionId; se 2 falhas
  // seguidas, sinaliza degradado e oferece fallback ao rep em vez de loop.
  const llmFailed =
    result.stopped_reason === "error" || result.stopped_reason === "max_iterations";
  // F49 (Pedro 2026-06-04): turno REAL com falha de LLM (parse error / max
  // iterations) vira signal + Sentry IDENTIFICÁVEL. Antes só ficava em
  // metadata.llm_failed, invisível sem query — é o "problema técnico" calado.
  // (Test session segue no fluxo abaixo, que dá retry explícito após 2 falhas.)
  if (llmFailed && !input.testSessionId) {
    reportError({
      title: "SparkBot: LLM falhou no turno (parse/max_iterations)",
      feature: "sparkbot-turn",
      severity: "high",
      description: `stopped_reason=${result.stopped_reason}. Resposta pode ter saído via fallback ou ficado incompleta.`,
      metadata: {
        rep_id: rep.id,
        location_id: activeLocationId,
        stopped_reason: result.stopped_reason,
        primary_error: result.primary_error ? String(result.primary_error).slice(0, 300) : undefined,
        secondary_error: result.secondary_error ? String(result.secondary_error).slice(0, 300) : undefined,
      },
    });
  }
  // Anti-timeout silencioso (incidente Manuela 2026-06-22): o turno bateu no
  // orçamento de wall-clock e devolveu fallback gracioso em vez de a lambda
  // morrer calada (rep no silêncio). Signal medium pra VER quem está batendo —
  // turno pesado demais (ex: criar 14 appointments de uma vez). O texto JÁ sai
  // pro rep (result.text é não-vazio), isto é só observabilidade.
  if (result.stopped_reason === "time_budget" && !input.testSessionId) {
    reportError({
      title: "SparkBot: turno parou por orçamento de tempo (anti-timeout)",
      feature: "sparkbot-turn",
      severity: "medium",
      description: `Turno excedeu ~45s e devolveu fallback gracioso (${result.tool_calls.length} tools no turno). Provável tarefa pesada num único turno.`,
      metadata: {
        rep_id: rep.id,
        location_id: activeLocationId,
        tools_in_turn: result.tool_calls.length,
        // Ultra-review 2026-07-17: as últimas tools do turno dizem QUAL passo
        // pesado estourou (antes o sinal não permitia diagnosticar — Fabiana).
        last_tools: result.tool_calls.slice(-5).map((t) => t.name),
      },
    });
  }
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
    call_usage: result.call_usage,
      };
    }
  }

  // ── Coherence gate (Onda 1 · V2 2026-05-20): VERDADE DE EXECUÇÃO ──
  // Migrado para core/coherence-gate.ts. Antes o detector só gerava signal
  // ("não bloqueava a resposta"); agora AGE. Se o bot afirma escrita sem a tool
  // correspondente ter rodado COM SUCESSO no turno:
  //   • 'rerun'  → re-roda 1× COM tools (seguro: nenhuma escrita ok no turno,
  //     nada a duplicar) pra de fato executar/corrigir.
  //   • 'rewrite'→ re-roda 1× SEM tools (zero side-effect) pra reescrever com
  //     honestidade. NUNCA re-executa — não duplica ação de cliente em andamento.
  // Roda ANTES do billing pra os tokens do re-run entrarem na cobrança.
  if (result.text) {
    const coherence = analyzeCoherence(result.text, result.tool_calls as ToolCallRecord[]);
    if (!coherence.coherent) {
      const toolNames = result.tool_calls.map((tc) => tc.name);
      for (const v of coherence.violations) {
        recordSignalAsync({
          type: "failure",
          title: `Coherence ${coherence.action}: ${v.family} sem tool (${v.detector})`,
          description: `Bot afirmou "${v.matched_text}" sem a tool de escrita correspondente com sucesso no turno. Ação tomada: ${coherence.action}.`,
          severity: "high",
          source: "bot_auto",
          metadata: {
            rep_id: rep.id,
            rep_phone: rep.phone,
            location_id: activeLocationId,
            agent_id: input.agentId,
            family: v.family,
            detector: v.detector,
            matched_text: v.matched_text,
            action: coherence.action,
            response_preview: result.text.slice(0, 300),
            tools_called: toolNames,
            model_used: result.model_used,
          },
        });
      }
      console.warn(
        `[Sparkbot] COHERENCE ${coherence.action} rep=${rep.id} families=[${coherence.violations
          .map((v) => v.family)
          .join(",")}] tools=[${toolNames.join(",")}]`,
      );

      // Loop-breaker (Fix bug observado em prod 2026-06-04 — caso Sieder Madrona):
      // se JÁ mandamos o fallback honesto no turno ANTERIOR, não repete. Sem isso
      // o gate re-dispara todo turno numa conversa de discovery (onde não há ação
      // real pra executar) e o rep fica preso recebendo o MESMO texto verbatim,
      // sem conseguir sair. Detectamos pela "impressão digital" do fallback na
      // última msg do assistant no histórico.
      const lastAssistantMsg = [...history].reverse().find(
        (m) => m.role === "assistant" && typeof m.content === "string",
      );
      const alreadyWarnedLastTurn =
        !!lastAssistantMsg &&
        (lastAssistantMsg.content as string)
          .toLowerCase()
          .includes(HONEST_FALLBACK_FINGERPRINT);

      if (!input.testSessionId) {
        try {
          const directive =
            coherence.action === "rerun" ? coherence.correctiveDirective : coherence.rewriteDirective;
          // 'rerun' re-executa COM tools (nada feito ainda); 'rewrite' SEM tools (não duplica).
          const rerunTools =
            coherence.action === "rerun"
              ? getAllToolDefinitions(
                  input.config.confirmation_mode || "high_only",
                  disabledTools,
                )
              : [];
          const rerun = await runWithTools({
            systemPrompt,
            messages: [
              ...history,
              userMessage,
              { role: "assistant", content: result.text },
              { role: "user", content: directive },
            ],
            tools: rerunTools,
            executor: (name, args) => executeTool(name, args, toolCtx),
            model: input.config.ai_model,
            fallbackModel: input.config.fallback_model,
            // H52 R2: rerun herda o relógio do turno — no máx 12s, e nunca
            // além de turnStart+55s (sobra ~5s pro billing/envio pós-loop).
            deadlineAt: Math.min(Date.now() + 12_000, turnStartedAt + 55_000),
          });
          result.prompt_tokens += rerun.prompt_tokens;
          result.completion_tokens += rerun.completion_tokens;
          result.cached_tokens += rerun.cached_tokens;
          // B0 (review Onda B): rerun também entra na anatomia (senão sum(call_usage)
          // não fecha com prompt_tokens exatamente nos turnos anômalos que o B0 mede).
          result.cache_creation_tokens = (result.cache_creation_tokens ?? 0) + (rerun.cache_creation_tokens ?? 0);
          if (rerun.call_usage?.length) result.call_usage = [...(result.call_usage || []), ...rerun.call_usage];
          // Recheck contra a UNIÃO das tools (turno original + re-run): cobre
          // 'rerun' (write nova) e 'rewrite' (write já feita no turno original).
          const combined = [...result.tool_calls, ...rerun.tool_calls];
          const recheck = analyzeCoherence(rerun.text, combined as ToolCallRecord[]);
          if (rerun.text && recheck.coherent) {
            result.text = rerun.text;
            result.tool_calls = combined;
          } else if (alreadyWarnedLastTurn) {
            // Loop-breaker: o fallback honesto JÁ foi enviado no turno anterior.
            // Repetir trava o rep num loop verbatim (caso Sieder). Deixa a
            // resposta do re-run (mais honesta) ou a original passar pra destravar.
            result.text = rerun.text || result.text;
            result.tool_calls = combined;
            recordSignalAsync({
              type: "failure",
              title: "Coherence loop-breaker: fallback repetido evitado",
              description: `Fallback honesto já enviado no turno anterior — deixei a resposta natural passar pra não travar o rep num loop. Investigar falso-positivo do gate (families: ${coherence.violations.map((v) => v.family).join(",")}).`,
              severity: "high",
              source: "bot_auto",
              metadata: {
                rep_id: rep.id,
                rep_phone: rep.phone,
                location_id: activeLocationId,
                agent_id: input.agentId,
                families: coherence.violations.map((v) => v.family),
              },
            });
          } else {
            result.text = coherence.safeRewrite;
            recordSignalAsync({
              type: "failure",
              title: "Coherence: re-run não resolveu → fallback honesto",
              description: `Após re-run (${coherence.action}) ainda incoerente; resposta substituída por fallback seguro.`,
              severity: "high",
              source: "bot_auto",
              metadata: {
                rep_id: rep.id,
                rep_phone: rep.phone,
                location_id: activeLocationId,
                agent_id: input.agentId,
              },
            });
          }
        } catch (err) {
          console.error(
            "[Sparkbot] coherence re-run falhou (non-fatal):",
            err instanceof Error ? err.message : err,
          );
          // Loop-breaker: se já avisamos no turno anterior, NÃO repete o fallback
          // (mantém o result.text original em vez de travar o rep).
          if (!alreadyWarnedLastTurn) result.text = coherence.safeRewrite;
        }
      }
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
        cacheCreationTokens: result.cache_creation_tokens ?? 0,
        // P1 review 2026-06-05: paridade de telemetria com lead-facing
        // (queue-processor:1139 "Fix HIGH-2"). O CUSTO da visão já entra via
        // prompt_tokens do multimodal (imagem vai inline em processor.ts:937);
        // imageCount é só pra o audit/cross-check de image_count não ficar 0.
        imageCount: input.input.kind === "image" ? 1 : 0,
        // Internal team usa "custom key" semantics: tracked em usage_records
        // mas NÃO cobrado do wallet. Audit trail mantido pra Pedro ver custo
        // mesmo internal em Supabase queries.
        usesCustomKey: isInternal,
      });
    } catch (err) {
      console.error("[Sparkbot] Billing failed (non-blocking):", err instanceof Error ? err.message : err);
    }
  }

  // (Coherence gate roda ANTES do billing — ver acima. Detector migrado para
  // core/coherence-gate.ts e agora é blocking, não mais signal-only.)

  // Interativo (Etapa 3): se o LLM chamou present_options, monta o payload e usa
  // o texto numerado como fallback (web/GHL e quando o envio interativo falha).
  // O texto-fallback é o que persiste em content (histórico legível).
  let interactive = extractInteractiveFromToolCalls(result.tool_calls);
  let interactiveVia: "present_options" | "backstop" | undefined = interactive
    ? "present_options"
    : undefined;
  // BACKSTOP (Pedro 2026-05-20): LLM escreveu lista numerada com cue de escolha
  // mas ESQUECEU present_options → converte deterministicamente em lista/botão.
  // Garante adoção mesmo sem adesão 100%. Loga pra medir/calibrar.
  if (!interactive && result.text) {
    const bk = detectNumberedOptionsFallback(result.text);
    if (bk) {
      interactive = bk;
      interactiveVia = "backstop";
      console.warn(
        `[Sparkbot] interactive BACKSTOP fired rep=${rep.id} — lista numerada sem present_options (${bk.options.length} opções, ${bk.kind}). Calibrar prompt.`,
      );
    }
  }
  // Pedro 2026-05-21: o LLM abusa de travessão (—/–) e soa robótico; a regra de
  // prompt sozinha NÃO segurou (msgs pós-deploy ainda vinham com "—"). Strip
  // determinístico no que SAI pro rep — troca por hífen normal (sem o "tell" de AI).
  const stripDashes = (s: string): string => s.replace(/[—–]/g, "-");
  if (interactive) {
    interactive.body = stripDashes(interactive.body);
    interactive.options = interactive.options.map((o) => ({
      ...o,
      label: stripDashes(o.label),
      description: o.description ? stripDashes(o.description) : o.description,
    }));
    if (interactive.title) interactive.title = stripDashes(interactive.title);
    if (interactive.footer) interactive.footer = stripDashes(interactive.footer);
    if (interactive.buttonText) interactive.buttonText = stripDashes(interactive.buttonText);
  }
  let finalText = stripDashes(interactive ? interactiveFallbackText(interactive) : result.text);

  // ── Anti-repeat guard (F57, Fix bug observado em prod 2026-06-04 — Sieder + Soraia) ──
  // Independente de coherence: se o texto que VAMOS mandar é eco verbatim de uma das
  // últimas msgs do PRÓPRIO bot (turno COERENTE → o gate acima nem dispara → o
  // loop-breaker do F53 nunca alcança), o rep fica preso recebendo a mesma coisa
  // (caso Sieder: apology echo; caso Soraia: "Confirma?"/"Nota salva" repetidos).
  // Re-roda 1× SEM tools com diretiva anti-repeat; se ainda repetir, manda fallback
  // determinístico DIFERENTE. Limpa o interactive — o desvio é texto, não menu.
  // Roda sobre finalText (depois do interactive) pra pegar o caso present_options.
  // Nota: como é DEPOIS do billing, os tokens do re-run entram em result.tokens
  // (uso real reportado) mas não são cobrados — path raro de recuperação, custo
  // desprezível, alinhado com "adoção > margem".
  if (finalText && !input.testSessionId) {
    const echoed = findBotEcho(finalText, history);
    if (echoed) {
      console.warn(
        `[Sparkbot] ANTI-REPEAT rep=${rep.id} — texto ≈ msg anterior do bot; re-run pra quebrar loop`,
      );
      let broke = REPEAT_HARD_FALLBACK;
      try {
        const rerun = await runWithTools({
          systemPrompt,
          messages: [
            ...history,
            userMessage,
            { role: "assistant", content: finalText },
            { role: "user", content: REPEAT_BREAK_DIRECTIVE },
          ],
          tools: [], // SEM tools — quebrar loop é resposta, não ação (confirmation gate já protege escrita)
          executor: (name, args) => executeTool(name, args, toolCtx),
          model: input.config.ai_model,
          fallbackModel: input.config.fallback_model,
          // H52 R2: herda o relógio do turno (ver rerun do coherence acima).
          deadlineAt: Math.min(Date.now() + 12_000, turnStartedAt + 55_000),
        });
        result.prompt_tokens += rerun.prompt_tokens;
        result.completion_tokens += rerun.completion_tokens;
        result.cached_tokens += rerun.cached_tokens;
        // B0 (review Onda B): rerun também entra na anatomia + cache_creation (paridade
        // com o rerun do coherence-gate acima).
        result.cache_creation_tokens = (result.cache_creation_tokens ?? 0) + (rerun.cache_creation_tokens ?? 0);
        if (rerun.call_usage?.length) result.call_usage = [...(result.call_usage || []), ...rerun.call_usage];
        // Só aceita o re-run se ele REALMENTE saiu do loop (não ecoa de novo).
        if (rerun.text && !findBotEcho(rerun.text, history) && !isNearDuplicate(rerun.text, finalText)) {
          broke = stripDashes(rerun.text);
        }
      } catch (err) {
        console.error(
          "[Sparkbot] anti-repeat re-run falhou (non-fatal):",
          err instanceof Error ? err.message : err,
        );
      }
      finalText = broke;
      interactive = null; // o desvio é texto puro; remove o menu repetido
      interactiveVia = undefined;
      recordSignalAsync({
        type: "failure",
        title: "Anti-repeat guard: loop verbatim quebrado",
        description:
          "Bot ia repetir a própria mensagem anterior num turno coerente (o gate não pega). Re-run forçado pra destravar o rep. Investigar por que o LLM ecoou (prompt/contexto/falso-bloqueio).",
        severity: "medium",
        source: "bot_auto",
        metadata: {
          rep_id: rep.id,
          rep_phone: rep.phone,
          location_id: activeLocationId,
          agent_id: input.agentId,
          echoed_preview: echoed.slice(0, 160),
          final_preview: finalText.slice(0, 160),
        },
      });
    }
  }

  return {
    text: finalText || "Não consegui gerar resposta. Tenta de novo?",
    should_send: true,
    tokens: {
      prompt: result.prompt_tokens,
      completion: result.completion_tokens,
      cached: result.cached_tokens,
    },
    model_used: result.model_used,
    tools_executed: result.tool_calls.map((tc) => tc.name),
    call_usage: result.call_usage,
    tool_calls: result.tool_calls,
    llm_failed: llmFailed,
    primary_error: result.primary_error,
    secondary_error: result.secondary_error,
    interactive: interactive ?? undefined,
    interactive_via: interactiveVia,
    contact_resolution: summarizeContactResolution(result.tool_calls),
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
    // F1 (cost-reduction 2026-06): prefixa o runtimeContext (header) também no turno tabular.
    // Antes os blocos voláteis (turnContext/verbosity/silence) vinham via system (sempre
    // enviado); agora vêm pelo header — sem isto, turno de planilha perderia esse contexto
    // (e de quebra ganha o [Agora/ISO/offset] que antes faltava no caminho tabular).
    return { role: "user", content: `${header}${lines.join("\n")}` };
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
