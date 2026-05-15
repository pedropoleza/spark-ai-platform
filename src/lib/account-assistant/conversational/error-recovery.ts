/**
 * Error Recovery Flow (H30.4, Pedro 2026-05-15).
 *
 * Bot identifica tipo de erro do GHL e propõe ação concreta de recovery
 * em vez de só "deu erro, tenta de novo". Bot prompt instrui usar
 * recovery_plan.response_template quando erro tem tipo conhecido.
 */

export interface RecoveryPlan {
  /** Identificador do tipo de erro */
  error_type: string;
  /** Ação automática que bot pode tentar antes de pedir input do rep */
  auto_action: "none" | "call_tool_x" | "retry_after_wait" | "extract_id_and_suggest_update";
  /** Tool a chamar (se auto_action !== 'none') */
  auto_tool?: string;
  /** Template de resposta — bot adapta tokenizando placeholders */
  response_template: string;
  /** Quão grave (afeta tom da resposta) */
  severity: "info" | "warning" | "error";
}

/**
 * Mapeia substring do error.message → RecoveryPlan.
 * Bot prompt instrui inspecionar tool_result e usar plan correspondente.
 */
export const ERROR_RECOVERY_MAP: RecoveryPlan[] = [
  // Calendar
  {
    error_type: "slot_not_available",
    auto_action: "call_tool_x",
    auto_tool: "get_free_slots",
    response_template:
      "❌ *Slot ocupado* (look-busy do calendar OU conflito). Vou puxar alternativas próximas — *me dá 1 segundo*.",
    severity: "warning",
  },
  {
    error_type: "team_member_not_part_of_calendar",
    auto_action: "none",
    response_template:
      "❌ *Esse calendar não tem você no time*. Posso:\n*1.* Tentar com outro calendar onde você está.\n*2.* Você adiciona seu user no Spark Leads e tenta de novo.",
    severity: "warning",
  },
  {
    error_type: "no_team_members_in_calendar",
    auto_action: "none",
    response_template:
      "❌ *Esse calendar não tem nenhum team member configurado* (admin precisa adicionar no Spark Leads). Quer marcar em outro calendar?",
    severity: "error",
  },

  // Contacts
  {
    error_type: "duplicated_contact",
    auto_action: "extract_id_and_suggest_update",
    response_template:
      "Esse contato *já existe* (id ${contact_id}). Posso *atualizar os dados dele* em vez de criar novo. Continua?",
    severity: "info",
  },
  {
    error_type: "phone_invalid",
    auto_action: "none",
    response_template:
      "❌ *Phone inválido*: '${value}'. Use formato E.164 (+5511987654321) ou dígitos puros.",
    severity: "warning",
  },
  {
    error_type: "email_invalid",
    auto_action: "none",
    response_template: "❌ *Email inválido*: '${value}'. Confere a digitação?",
    severity: "warning",
  },

  // Permissions
  {
    error_type: "permission_denied",
    auto_action: "none",
    response_template:
      "❌ *Permissão negada* — esse recurso é de outra location OU o token precisa de re-auth. Vou registrar pro admin avaliar.",
    severity: "error",
  },

  // Rate / Server
  {
    error_type: "rate_limited",
    auto_action: "retry_after_wait",
    response_template:
      "⏳ Spark Leads tá lento, tentando de novo em 5s...",
    severity: "info",
  },
  {
    error_type: "server_error_5xx",
    auto_action: "retry_after_wait",
    response_template:
      "⚠️ Erro temporário do Spark Leads. Retento em alguns segundos.",
    severity: "warning",
  },

  // 404 / Not found
  {
    error_type: "resource_not_found",
    auto_action: "none",
    response_template:
      "❌ *Recurso não encontrado* — ID inválido ou deletado. Me confirma o nome/ID atual.",
    severity: "warning",
  },

  // Custom
  {
    error_type: "filter_engine_invalid_field",
    auto_action: "call_tool_x",
    auto_tool: "describe_filter_capabilities",
    response_template:
      "❌ *Field '${field}' não existe* nesta location. Posso listar os fields disponíveis e te dizer qual usar.",
    severity: "info",
  },
  {
    error_type: "alias_ambiguous",
    auto_action: "none",
    response_template:
      "⚠️ *'${alias}' bate em ${count} candidatos*: ${list}. Qual deles?",
    severity: "info",
  },
];

/**
 * Detecta tipo de erro a partir da mensagem.
 * Retorna RecoveryPlan ou null se sem match.
 */
export function detectRecoveryPlan(errorMessage: string): RecoveryPlan | null {
  const msg = (errorMessage || "").toLowerCase();

  if (/slot.*not.*available|no longer available/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "slot_not_available")!;
  if (/user.*not.*part of calendar team/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "team_member_not_part_of_calendar")!;
  if (/no team members associated|team member.*missing/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "no_team_members_in_calendar")!;
  if (/duplicat|já existe/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "duplicated_contact")!;
  if (/phone.*invalid|invalid phone/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "phone_invalid")!;
  if (/email.*invalid|invalid email/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "email_invalid")!;
  if (/permission|forbidden|unauthor/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "permission_denied")!;
  if (/rate.limit|429/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "rate_limited")!;
  if (/server.error|5[0-9]{2}/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "server_error_5xx")!;
  if (/404|not.found|recurso não encontrado/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "resource_not_found")!;
  if (/field.*desconhecido|unsupported field/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "filter_engine_invalid_field")!;
  if (/ambíguo|tem \d+ matches/i.test(msg))
    return ERROR_RECOVERY_MAP.find((r) => r.error_type === "alias_ambiguous")!;

  return null;
}

/**
 * Renderiza guidance pro system prompt explicando como bot deve usar plans.
 */
export const ERROR_RECOVERY_PROMPT_GUIDE = `
# ERROR RECOVERY — usar templates ao reagir a tool errors

Quando uma tool retorna status='error', verifique a mensagem do erro:

| Padrão no error msg | Resposta-template |
|---|---|
| "slot not available" / "no longer available" | "❌ Slot ocupado. Vou puxar alternativas — me dá 1 segundo." → AUTO-CHAMA get_free_slots e mostra top 3 |
| "user not part of calendar team" | "❌ Você não tá no time desse calendar. Opções: (1) tentar outro calendar (2) admin te adicionar" |
| "duplicated" / "já existe" | "Esse contato já existe (id X). Atualizo os dados dele?" → AUTO-EXTRAI o contact_id da mensagem |
| "phone invalid" / "email invalid" | "❌ Campo inválido: '<valor>'. Confere a digitação." |
| "permission denied" / "forbidden" | "❌ Permissão negada. Vou registrar pro admin." |
| "rate limited" / "429" | "⏳ Spark Leads tá lento, retento em 5s" → AGUARDA + RETRY 1x automaticamente |
| "404" / "not found" | "❌ ID inválido ou deletado. Me confirma o nome/ID atual." |
| "field desconhecido" (FEL) | "❌ Field não existe aqui. Vou listar fields disponíveis." → AUTO-CHAMA describe_filter_capabilities |
| "ambíguo" / "tem N matches" | Mostra menu numerado das opções, peça pra escolher |

REGRAS:
- SEMPRE proponha próxima ação concreta — nunca só "tenta de novo".
- Quando "auto-chama X", chama tool X no MESMO turn e mostra resultado.
- Use template 4 ERROR_RETRY (1 linha causa + 1 linha ação).
- NUNCA esconda o erro: rep precisa saber o que aconteceu.
`;
