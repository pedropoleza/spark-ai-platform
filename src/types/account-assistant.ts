/**
 * Tipos do Account Assistant (Sparkbot).
 *
 * Diferente de sales/recruitment agents (que conversam com LEADS), o Account
 * Assistant conversa com o REP comercial humano via WhatsApp dedicado e opera
 * o GHL em nome dele. Não confunde com AgentConfig dos outros agentes — ele
 * reusa agent_configs mas adiciona colunas específicas.
 */

/** Link entre um rep (por phone) e suas identidades GHL em N locations. */
export interface GHLUserLink {
  location_id: string;
  ghl_user_id: string;
  location_name: string | null;
  role: string | null;
  /**
   * Timezone IANA do user GHL nessa location (ex: 'America/Sao_Paulo').
   * Capturado no momento do identify (GHL users API). Pode ser null se a API
   * não devolver o campo (legado) — caller usa rep.timezone (top-level) como
   * fallback, ou location.timezone, ou 'America/New_York'.
   */
  timezone?: string | null;
}

/** Perfil adaptativo — o que o Sparkbot aprende sobre o rep ao longo do tempo. */
export interface RepProfile {
  preferences?: {
    tone?: "casual" | "formal";
    response_style?: "brief" | "detailed";
    emoji_usage?: "none" | "occasional";
    verbosity?: "brief" | "normal" | "detailed";
    /**
     * Nome preferido do rep (fix caso Manuela 2026-06-23): o display_name vem do
     * cadastro do GHL (single source of truth do CRM) e às vezes está errado
     * (ex: "Manoela" em vez de "Manuela"). Quando o rep corrige como quer ser
     * chamado, o bot persiste aqui via `set_rep_preferred_name` e passa a usar
     * este nome no lugar do display_name. Mesmo padrão "GHL sugere, rep
     * sobrescreve, persiste" que o timezone já usa.
     */
    preferred_name?: string;
    /**
     * Agendamento V2 (Pedro 2026-05-22, D2): preferência de calendário/duração
     * pra agendar sem perguntar a cada vez. Resolução no prompt: nome dito >
     * esta pref > único calendário do rep. Setado via tool `set_scheduling_pref`
     * (bot aprende no 1º uso) ou pela UI do Spark (E4). `default_calendar_name`
     * é guardado junto só pra surfacing no prompt (memória) sem tool call.
     */
    scheduling?: {
      default_calendar_id?: string;
      default_calendar_name?: string;
      default_duration_min?: number;
      /**
       * Humanização (estudo 2026-06-24, fix 1.6): reps cujo calendário vive
       * "bloqueado" (blocks/demos de propósito) forçam slot TODA vez — o
       * "confirmar mesmo assim?" vira ritual sem sentido (atrito #1 do
       * agendamento). `force_slot_count` conta forças confirmadas na própria
       * agenda; ao bater o threshold, `auto_force_slot` liga e o bot passa a
       * agendar direto + avisar passivo, sem o passo extra. Reversível.
       */
      force_slot_count?: number;
      auto_force_slot?: boolean;
    };
  };
  habits?: {
    active_hours?: string[];       // ex: ["08:00-12:00", "14:00-18:00"]
    prefers_morning?: boolean;
    typical_follow_up_window?: string; // ex: "24h"
  };
  relationships?: {
    vip_contacts?: string[];       // ghl contact IDs
    difficult_contacts?: string[];
  };
  opt_outs?: {
    weekend_alerts?: boolean;
    pre_meeting_briefing?: boolean;
  };
  /**
   * Quiet hours pessoais do rep (override por-rep do quiet_hours do agent).
   * Quando setado, dispatcher respeita PRIMEIRO o do rep, depois cai no do agent.
   * Ex: { enabled: true, start: "21:00", end: "08:00", days: [0,1,2,3,4,5,6] }
   */
  quiet_hours_personal?: QuietHoursConfig;
  notes?: string[];                // free-form observações
  /**
   * Aliases — atalhos pessoais do rep pra termos do CRM/operação.
   * Pedro 2026-05-14: introduzido pra resolver bug do Gustavo onde bot
   * desconhecia que "M2" significa "M2 dos 5 ao 20k" (stage interno).
   *
   * Format: { "alias": "expansão" }
   * Ex: { "M3": "Inscrito M3 (20k-50k)", "boca raton": "tag mora perto de boca raton" }
   *
   * Injetado no system prompt em buildMemorySection → bot interpreta
   * aliases sem precisar perguntar a cada turn. Persistido em
   * rep_identities.profile JSONB.
   *
   * Setado/removido via tools `set_rep_alias` e `forget_rep_alias`.
   */
  aliases?: Record<string, string>;
}

export interface RepIdentity {
  id: string;
  phone: string;
  display_name: string | null;
  ghl_users: GHLUserLink[];
  active_location_id: string | null;
  profile: RepProfile;
  terms_accepted_at: string | null;
  /**
   * Pedro 2026-05-05: rep que recusou termos. Bot silencia daqui em diante
   * (não responde nada) até admin limpar manualmente. Persistido pelo
   * `rejectTerms()` em identity.ts. Antes desse fix, processor entrava em
   * loop reenviando termos a cada msg posterior.
   */
  terms_rejected_at?: string | null;
  /**
   * Terms & Segurança PARTE 2 (campanha de grupo, migration 00113). Aceite/recusa
   * do 2º consentimento, pedido só antes da primeira campanha de grupo. Diferente
   * dos termos da Parte 1: REJECT aqui NÃO silencia o SparkBot (só bloqueia grupo).
   * `_pending_at` = rep está no fluxo de aceite (gate determinístico no processor).
   */
  group_campaign_terms_accepted_at?: string | null;
  group_campaign_terms_rejected_at?: string | null;
  group_campaign_terms_pending_at?: string | null;
  unanswered_count: number;
  unanswered_pause_until: string | null;
  /**
   * Timezone IANA do REP (não da location). Single source of truth pra
   * formatar horário no prompt e calcular ISO 8601 de schedule_reminder.
   * Resolution chain: rep.timezone → location.timezone → 'America/New_York'.
   * Pode vir do GHL user.timezone (auto-sugestão) ou da tool confirm_rep_timezone
   * (rep confirmou). Veja `timezone_confirmed_at` pra distinguir.
   */
  timezone?: string | null;
  /**
   * Timestamp da confirmação verbal do rep via tool `confirm_rep_timezone`.
   * NULL = `timezone` é só sugestão automática (GHL user ou location) e o
   * gate em executeTool bloqueia tools tz-sensitive até rep confirmar.
   * Resetado quando rep informa novo fuso (viagem etc).
   */
  timezone_confirmed_at?: string | null;
  /**
   * Quando true, SparkBot processa requests mas NÃO cobra o wallet GHL.
   * Usado pra agency owner/admins. Veja migration 00048.
   */
  is_internal?: boolean;
  /**
   * Timestamp da última msg INBOUND do rep (de qualquer canal). Crítico
   * pra opt-in gate: proativos só dispara se !== null (rep iniciou
   * conversa pelo menos 1x — opt-in via WhatsApp legítimo).
   * Fix CRITICAL bug 2026-05-06: setup wizard auto-aceita terms mas isso
   * NÃO conta como opt-in. Sem inbound real, enviar proativo = ban risk.
   */
  last_inbound_at?: string | null;
  /**
   * Pausa proativos (silence gate). Bot continua respondendo inbound,
   * mas não inicia conversa. Resetado em qualquer inbound do rep.
   */
  proactive_paused_at?: string | null;
  proactive_warned_at?: string | null;
  consecutive_proactive_without_reply?: number;
  /**
   * Opt-in/opt-out do "Resumo matinal" diário (Pedro 2026-05-12).
   * Default TRUE pra todos. Rep pode desativar via tool set_daily_briefing.
   */
  daily_briefing_enabled?: boolean;
  /**
   * Preferências de proatividade POR REP (FORGE-3 2026-05-21). JSONB:
   * { "<rule_key>": { enabled?: bool, params?: { lead_min?: number } } }.
   * Ausência de uma key = segue o default da matriz (proactive/preferences.ts).
   * Ligável/desligável pelo rep via chat (tool set_proactivity) e pela UI do Spark.
   */
  proactivity_prefs?: Record<string, { enabled?: boolean; params?: Record<string, number> }>;
  created_at: string;
  updated_at: string;
}

/** Estado pendente de uma sessão — aguardando input do rep. */
export type PendingAction =
  | {
      type: "confirm_action";
      tool: string;
      args: Record<string, unknown>;
      summary: string;            // o que vai acontecer em linguagem natural
      risk: "medium" | "high";
      expires_at: string;
    }
  | {
      type: "clarify_entity";
      entity_type: "contact" | "opportunity" | "appointment";
      original_query: string;
      tool_pending: string;       // qual tool refazer após clarificação
      args_pending: Record<string, unknown>;
      candidates: Array<{
        id: string;
        label: string;            // "João Silva — última conv 2d, Negotiation R$5k"
        metadata?: Record<string, unknown>;
      }>;
      expires_at: string;
    }
  | {
      type: "choose_location";
      options: Array<{ location_id: string; location_name: string }>;
      expires_at: string;
    }
  | {
      type: "awaiting_terms_acceptance";
      sent_at: string;
    };

export interface AssistantConversation {
  id: string;
  rep_id: string;
  ghl_conversation_id: string | null;
  pending_action: PendingAction | null;
  pending_messages: string[];
  debounce_expires_at: string | null;
  last_turn_at: string | null;
  turn_count: number;
  ai_paused_at: string | null;
  ai_paused_reason: string | null;
  created_at: string;
  updated_at: string;
}

/** Input multimodal que o rep pode enviar. */
export type RepInput =
  | { kind: "text"; text: string }
  | { kind: "audio"; transcribed_text: string; original_url?: string }
  | { kind: "image"; base64_data_uri: string; caption?: string; filename?: string }
  | { kind: "document"; extracted_text: string; filename: string; caption?: string }
  | { kind: "tabular"; tabular: TabularData; caption?: string };

/** Dados parseados de planilha (CSV/XLSX). Pass-through — não persiste arquivo original. */
export interface TabularData {
  filename: string;
  /** Colunas detectadas (cabeçalhos da primeira linha). */
  columns: string[];
  /** Total de linhas no arquivo (pode ser > rows.length se truncamos). */
  total_rows: number;
  /** Linhas parseadas (truncadas a TABULAR_MAX_ROWS=500). */
  rows: Array<Record<string, string | number | null>>;
  /** Sheets do XLSX (para CSV: array de 1 com nome do filename). */
  sheets?: TabularSheet[];
  /** Sheet ativa (default: primeira). */
  active_sheet?: string;
  /** Source mime: 'text/csv' | 'application/vnd...sheet' */
  source_mime: string;
}

export interface TabularSheet {
  name: string;
  columns: string[];
  total_rows: number;
  rows: Array<Record<string, string | number | null>>;
}

/** Tool do catálogo V1. */
export interface ToolDefinition {
  name: string;
  description: string;
  risk: "safe" | "medium" | "high";
  // JSON Schema dos args (formato OpenAI/Claude tools API)
  parameters: Record<string, unknown>;
}

/** Resultado da execução de uma tool. */
export type ToolResult =
  | { status: "ok"; data: unknown }
  | {
      status: "ambiguous";
      entity_type: "contact" | "opportunity" | "appointment";
      original_query: string;
      candidates: Array<{ id: string; label: string; metadata?: Record<string, unknown> }>;
    }
  | { status: "not_found"; message: string }
  | {
      status: "error";
      message: string;
      retryable: boolean;
      /**
       * Onda 2 (2026-05-20): código de classificação do erro de escopo/IAM.
       * - "unsupported_endpoint": GHL retornou IAM 5xx permanente (ex: delete_appointment).
       * - "scope_or_location": GHL retornou 403 por escopo insuficiente ou location sem acesso.
       * Usado por executeTool pra chamar flagScopeIssue no admin.
       */
      code?: string;
    }
  /**
   * Status "degraded" (review 2026-05-05): tool executou parcialmente mas
   * faltou info crítica (ex: list_my_free_slots conseguiu /free-slots mas
   * TODOS os event lookups falharam — não pôde detectar conflicts). LLM
   * deve usar com cautela e sempre confirmar com rep antes de ação
   * irreversível baseada nesses dados.
   */
  | { status: "degraded"; data: unknown; degradation_reason?: string };

/** Config do Account Assistant (extensão da AgentConfig). */
export interface AssistantWhitelistEntry {
  ghl_user_id: string;
  name: string;
  phone: string;
}

export interface QuietHoursConfig {
  enabled: boolean;
  start: string;          // "22:00"
  end: string;            // "07:00"
  timezone: string;       // "America/New_York"
  days: number[];         // 0=dom..6=sab
}

export interface AccountAssistantConfigExtras {
  allowed_ghl_users: AssistantWhitelistEntry[];
  confirmation_mode: "always" | "medium_and_high" | "high_only";
  no_response_threshold: number;
  quiet_hours: QuietHoursConfig | Record<string, never>;
  alert_toggles: Record<string, boolean>; // placeholder V2 (deprecated em favor de proactive_rules)
  // Configs adicionadas em 2026-05-03 (migration 00047 + reuso de campos):
  custom_instructions?: string | null;
  knowledge_base_instructions?: string | null;
  daily_proactive_limit?: number;       // 0 = desabilitado
  fallback_model?: string | null;
  disabled_tools?: string[];            // tool names
  enabled_kbs?: string[];                // ['national_life_group', 'agency_brazillionaires']
  // Multimodal switches (já existiam em agent_configs, agora são respeitados)
  enable_audio_transcription?: boolean;
  enable_image_analysis?: boolean;
  enable_pdf_reading?: boolean;
  // Tones (já existiam, reusados)
  tone_creativity?: number | null;       // 1-10
  tone_formality?: number | null;        // 1-10
  tone_naturalness?: number | null;      // 1-10
  tone_aggressiveness?: number | null;   // 1-10
  // Comportamento de mensagens
  debounce_seconds?: number | null;
}

// =====================================================
// V2 — Proactive rules
// =====================================================

/** Trigger config das regras reativas (eventos GHL). */
export type ReactiveTrigger =
  | { event: "appointment_upcoming"; offset_minutes: number }       // -15min antes
  | { event: "post_meeting"; offset_minutes: number }                // +20min depois
  | { event: "appointment_no_show" }
  | { event: "opportunity_stale"; days_threshold: number }
  | { event: "task_due_soon"; offset_minutes: number }              // -60min antes
  | { event: "task_overdue"; offset_minutes: number }                // +60min depois
  | { event: "inbound_unanswered"; hours_threshold: number }
  | { event: "deal_won" }
  | { event: "contact_assigned_to_rep" }
  | { event: "contact_inactive"; days_threshold: number };

export type ScheduledTrigger = {
  cron: string;
  timezone?: string;
};

export type ProactiveRuleType = "reactive" | "scheduled";
export type ProactiveRuleSource = "system" | "custom";

export interface ProactiveRule {
  id: string;
  agent_id: string;
  rule_type: ProactiveRuleType;
  name: string;
  description: string | null;
  enabled: boolean;
  trigger_config: ReactiveTrigger | ScheduledTrigger | Record<string, unknown>;
  prompt_instruction: string;
  /** null = todas as tools, array = subset por nome */
  tools_allowed: string[] | null;
  cooldown_minutes: number;
  ai_model: string | null;
  source: ProactiveRuleSource;
  created_at: string;
  updated_at: string;
  /**
   * H39: timestamp da última poll de uma rule reactive (post_meeting). Throttle
   * do polling GHL (claim atômico no cron, intervalo 5min) + gate do guard do
   * pg_cron. Default epoch (1970). Ignorado por rules scheduled.
   */
  reactive_last_polled_at?: string;
}

export type AlertDispatchStatus =
  | "sent"
  | "skipped_cooldown"
  | "skipped_quiet_hours"
  | "skipped_disabled"
  | "skipped_silence" // rep não tá respondendo — silence gate barrou (3+ proativos sem resposta)
  | "failed";

export interface AlertState {
  id: string;
  rep_id: string;
  rule_id: string;
  target_id: string | null;
  last_fired_at: string;
  status: AlertDispatchStatus;
  tokens_used: number | null;
  cost_usd: number | null;
}
