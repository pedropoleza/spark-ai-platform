/**
 * Rótulos plain-PT-BR dos módulos (do design v3). O usuário não-tech NUNCA vê
 * a palavra "módulo" — vê "Como o agente fala", "Horário de atendimento", etc.
 * Chaveado pela key real do catálogo (agent_modules.key / ModuleCategory).
 */
export const MODULE_LABEL: Record<string, string> = {
  behavior: "Como o agente fala",
  active_hours: "Horário de atendimento",
  followup: "Mensagens automáticas (follow-up)",
  qualification: "Qualificação de leads",
  scheduling: "Agendamento de reuniões",
  compliance: "Limites e LGPD",
  channel: "Canais",
  crm_ops: "Ações no CRM",
  knowledge: "Documentos de apoio",
  bulk: "Disparo em massa",
};

export const MODULE_SUBTITLE: Record<string, string> = {
  behavior: "Personalidade, modelo de IA, instruções customizadas",
  active_hours: "Quando o agente responde · fuso · dias da semana",
  followup: "Sequência de retomada para quem não respondeu",
  qualification: "O que perguntar para identificar um bom lead",
  scheduling: "Calendário · duração · lembretes",
  compliance: "Quantas mensagens por dia · opt-out · disclaimer",
  channel: "WhatsApp, Instagram — quais canais estão ativos",
  crm_ops: "Quais ações o agente pode fazer no Spark Leads",
  knowledge: "Tabelas de preço, FAQ, argumentário",
  bulk: "Campanhas e disparos para listas",
};

export function moduleLabel(key: string, fallback?: string): string {
  return MODULE_LABEL[key] || fallback || key;
}
