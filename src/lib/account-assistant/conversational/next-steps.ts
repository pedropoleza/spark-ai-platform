/**
 * Next-Step Suggestions (H29.3, Pedro 2026-05-15).
 *
 * Após cada write tool com status=ok, bot oferece 1-2 next actions
 * relevantes. Mapeamento fixo aqui — NUNCA chunky (max 2). Bot escolhe
 * 1 das sugestões pra apresentar (não lista todas).
 *
 * Filosofia:
 *   - Sugestões são CONCRETAS e ACIONÁVEIS ("criar opp", não "fazer mais")
 *   - Próximo passo NATURAL no fluxo (criou contato → opp/tag, não delete)
 *   - 1 sugestão por turn — não polui
 *   - Bot pode SKIPAR se rep tá em flow rápido (urgent style)
 */

export interface NextStepSuggestion {
  /** Pergunta curta sugestiva pro bot apresentar */
  prompt: string;
  /** Tool que bot chamaria se rep aceitar (referência) */
  hint_tool?: string;
}

/**
 * Mapeamento tool_executed → suggestions[] (top 2 mais prováveis).
 * Bot escolhe 1 baseado em contexto.
 */
export const NEXT_STEP_MAP: Record<string, NextStepSuggestion[]> = {
  // CONTACTS
  create_contact: [
    { prompt: "Quer criar uma opportunity pra ele também?", hint_tool: "create_opportunity" },
    { prompt: "Adicionar alguma tag?", hint_tool: "add_tag" },
  ],
  update_contact: [
    { prompt: "Quer atualizar mais algum campo dele?", hint_tool: "update_contact" },
  ],

  // NOTES
  create_note: [
    { prompt: "Quer criar uma task de follow-up?", hint_tool: "create_task" },
    { prompt: "Adicionar tag relacionada?", hint_tool: "add_tag" },
  ],

  // TASKS
  create_task: [
    { prompt: "Quer que eu te lembre antes da task vencer?", hint_tool: "schedule_reminder" },
    { prompt: "Atribuir a outro user da equipe?", hint_tool: "update_task" },
  ],
  complete_task: [
    { prompt: "Quer criar a próxima task de follow-up?", hint_tool: "create_task" },
  ],

  // TAGS
  add_tag: [
    { prompt: "Adicionar mais alguma tag?", hint_tool: "add_tag" },
  ],

  // OPPS
  create_opportunity: [
    { prompt: "Quer agendar reunião inicial com o contato?", hint_tool: "create_appointment" },
    { prompt: "Criar task de qualificação?", hint_tool: "create_task" },
  ],
  update_opportunity: [
    { prompt: "Quer atualizar mais algum campo?", hint_tool: "update_opportunity" },
  ],
  update_opportunity_status: [
    // Bot decide baseado no novo status:
    // won → "marcar tag cliente?", "mover pra pipeline Policies?"
    // lost → "registrar motivo?"
    { prompt: "Quer registrar o motivo da mudança em uma nota?", hint_tool: "create_note" },
  ],

  // REMINDERS
  schedule_reminder: [
    { prompt: "Quer criar uma task no Spark Leads também (visível no app)?", hint_tool: "create_task" },
  ],

  // APPOINTMENTS
  create_appointment: [
    { prompt: "Quer mandar uma msg de confirmação pro contato?", hint_tool: "send_message_to_contact" },
    { prompt: "Te lembro 1h antes do appointment?", hint_tool: "schedule_reminder" },
  ],
  update_appointment: [
    { prompt: "Avisar o contato da mudança via WhatsApp?", hint_tool: "send_message_to_contact" },
  ],

  // MESSAGES
  send_message_to_contact: [
    { prompt: "Quer agendar follow-up caso ele não responda em 24h?", hint_tool: "schedule_reminder" },
  ],

  // BULK
  schedule_bulk_message_v2: [
    { prompt: "Quer acompanhar o progresso agora?", hint_tool: "get_bulk_job_progress" },
  ],

  // ALIASES & TIMEZONE
  set_rep_alias: [
    { prompt: "Quer salvar mais algum atalho?", hint_tool: "set_rep_alias" },
  ],
  confirm_rep_timezone: [
    // Sem sugestão — é setup
  ],

  // BLOCK CALENDAR
  block_calendar_slot: [
    { prompt: "Quer bloquear mais algum horário?", hint_tool: "block_calendar_slot" },
  ],

  // IMPORT TABULAR
  import_contacts_from_data: [
    { prompt: "Quer disparar uma msg de boas-vindas pros importados?", hint_tool: "schedule_bulk_message_v2" },
  ],
};

/**
 * Retorna 1 sugestão pro bot apresentar após write tool.
 * Estratégia: pega a primeira do array (mais provável).
 * Bot pode ignorar se contexto não pede (rep urgente, fluxo curto).
 */
export function getTopSuggestion(toolName: string): NextStepSuggestion | null {
  const list = NEXT_STEP_MAP[toolName];
  if (!list || list.length === 0) return null;
  return list[0];
}

/**
 * Retorna TODAS sugestões pra contexto onde rep pediu opções múltiplas.
 */
export function getAllSuggestions(toolName: string): NextStepSuggestion[] {
  return NEXT_STEP_MAP[toolName] || [];
}

/**
 * Renderiza bloco de sugestão pro system prompt (injetado após write tool result).
 */
export function renderSuggestionForPrompt(toolName: string): string {
  const top = getTopSuggestion(toolName);
  if (!top) return "";
  return `[NEXT_STEP_HINT após ${toolName}] Considere oferecer ao rep: "${top.prompt}" (1 linha apenas, no template 3 SUCCESS_NEXT). Pula se rep está em fluxo urgente OU se contexto já fez essa próxima ação.`;
}
