/**
 * Catálogo de regras pré-configuradas (system rules) do Sparkbot.
 *
 * São criadas automaticamente no agent quando provisionado pela primeira
 * vez (ou quando admin reseta os defaults). Admin pode editar/desabilitar
 * mas não deletar (source='system'). Pra deletar, vira 'custom' primeiro.
 *
 * Total: 14 regras. 10 reactivas + 4 scheduled (resumos).
 */

export interface SystemRuleSeed {
  rule_type: "reactive" | "scheduled";
  name: string;
  description: string;
  trigger_config: Record<string, unknown>;
  prompt_instruction: string;
  tools_allowed: string[] | null;
  cooldown_minutes: number;
  ai_model?: string;
}

export const SYSTEM_RULES: SystemRuleSeed[] = [
  // ===== REACTIVE =====
  {
    rule_type: "reactive",
    name: "Briefing pré-reunião",
    description: "15min antes do appointment, manda contexto do lead pro rep se preparar.",
    trigger_config: { event: "appointment_upcoming", offset_minutes: -15 },
    prompt_instruction: `O rep tem uma reunião em 15min. Faça um briefing CURTO (máx 4 linhas) com:
- Quem é o lead (use get_contact)
- Última conversa que tiveram (use search_conversations + get_conversation_history pra ver as últimas 5 msgs)
- Opportunity associada se houver (use list_opportunities filtrando por contact_id)
- 1 sugestão prática pra abrir essa conversa

Tom direto de colega. Sem floreio. Comece já com "Em 15min vc tem call com [nome]..."`,
    tools_allowed: [
      "get_contact",
      "search_conversations",
      "get_conversation_history",
      "list_opportunities",
      "get_contact_notes",
    ],
    cooldown_minutes: 30,
  },
  {
    rule_type: "reactive",
    name: "Pós-reunião",
    description: "Assim que a reunião acaba (endTime), pergunta como foi e oferece atualizar o CRM.",
    // Pedro 2026-05-04: default `offset_minutes: 0` — dispara imediatamente
    // no end_time. Antes era 20min depois, mas Pedro pediu envio na hora.
    trigger_config: { event: "post_meeting", offset_minutes: 0 },
    prompt_instruction: `A reunião do rep com [nome do lead] acabou de terminar. Pergunta CURTO:
- Como foi?
- Se quiser, manda áudio que eu atualizo o CRM (mover stage, criar nota, agendar follow-up)

Sem pressão. Se ele responder com áudio depois, você vai entender o conteúdo (já transcrito) e usar update_opportunity_status, create_note, create_task etc conforme necessário.`,
    tools_allowed: [
      "get_contact",
      "list_opportunities",
      "create_note",
      "create_task",
      "update_opportunity_status",
    ],
    cooldown_minutes: 60,
  },
  {
    rule_type: "reactive",
    name: "No-show",
    description: "Quando appointment é marcado como no-show, oferece ações de remarcação.",
    trigger_config: { event: "appointment_no_show" },
    prompt_instruction: `O lead [nome] não apareceu na reunião marcada. Avisa o rep e ofereça opções:
- Mandar mensagem pessoal de remarcação (se aceitar, peça confirmação antes de send_message_to_contact)
- Disparar sequence de remarcação automática (rep faz manual no Spark Leads)
- Marcar como cancelado e seguir em frente

Curto, sem drama.`,
    tools_allowed: [
      "get_contact",
      "send_message_to_contact",
      "update_appointment",
      "create_task",
    ],
    cooldown_minutes: 60,
  },
  {
    rule_type: "reactive",
    name: "Opportunity parada",
    description: "Quando uma opp fica >7 dias no mesmo estágio, alerta.",
    trigger_config: { event: "opportunity_stale", days_threshold: 7 },
    prompt_instruction: `A opportunity [nome] está há [X] dias no mesmo estágio. Faz uma checagem rápida:
- Olha a última nota/atividade (get_contact_notes, get_conversation_history)
- Sugere 1 ação prática (mandar follow-up, agendar call, mover stage, dar como perdida)

Tom: alerta amigável, não cobrança. "Tô vendo que a opp do [X] tá parada há [Y] dias..."`,
    tools_allowed: [
      "get_opportunity",
      "get_contact",
      "get_contact_notes",
      "search_conversations",
      "get_conversation_history",
    ],
    cooldown_minutes: 1440, // 24h — não realertar a mesma opp diariamente
  },
  {
    rule_type: "reactive",
    name: "Task vencendo",
    description: "1h antes do due_at, lembra o rep da task.",
    trigger_config: { event: "task_due_soon", offset_minutes: -60 },
    prompt_instruction: `Daqui a 1h vence a task "[título]" associada ao [nome do contato]. Lembrete CURTO numa linha. Se for útil, ofereça marcar como completa direto (use complete_task se rep confirmar).`,
    tools_allowed: ["get_task", "get_contact", "complete_task"],
    cooldown_minutes: 60,
  },
  {
    rule_type: "reactive",
    name: "Tarefa atrasada",
    description: "Passou do due_at sem ser completada, alerta.",
    trigger_config: { event: "task_overdue", offset_minutes: 60 },
    prompt_instruction: `A task "[título]" associada ao [nome do contato] venceu há ~1h e ainda não foi completada. Pergunta se foi feita (pra marcar via complete_task), se quer adiar (update_task com novo due_at) ou se quer apagar (delete_task — confirma antes).`,
    tools_allowed: ["get_task", "get_contact", "complete_task", "update_task", "delete_task"],
    cooldown_minutes: 240, // 4h — não realertar a cada hora
  },
  {
    rule_type: "reactive",
    name: "Mensagem inbound não respondida",
    description: "Lead mandou msg há >4h sem rep responder. Alerta.",
    trigger_config: { event: "inbound_unanswered", hours_threshold: 4 },
    prompt_instruction: `O lead [nome] mandou uma mensagem há mais de 4h e ainda não foi respondido. Mostra:
- Última msg dele (get_conversation_history)
- Sugestão de resposta curta (1-2 frases) que o rep pode usar como base

Se o rep aprovar, você manda via send_message_to_contact (com confirmação simples).`,
    tools_allowed: [
      "get_contact",
      "search_conversations",
      "get_conversation_history",
      "send_message_to_contact",
    ],
    cooldown_minutes: 240,
  },
  {
    rule_type: "reactive",
    name: "Lead esfriando",
    description: "Contato ativo deixou de responder por 7 dias.",
    trigger_config: { event: "contact_inactive", days_threshold: 7 },
    prompt_instruction: `O lead [nome] está há 7 dias sem responder, mas estava ativo antes. Vale tentar retomar?
- Mostra última conversa (get_conversation_history) pra contexto
- Sugere 1 abordagem leve (não invasiva)

Se o rep concordar com texto, manda via send_message_to_contact.`,
    tools_allowed: [
      "get_contact",
      "get_conversation_history",
      "search_conversations",
      "send_message_to_contact",
    ],
    cooldown_minutes: 4320, // 3 dias — não esquentar ainda mais
  },
  {
    rule_type: "reactive",
    name: "Deal fechado",
    description: "Quando opp vai pra status=won, parabeniza e pergunta o que funcionou.",
    trigger_config: { event: "deal_won" },
    prompt_instruction: `O rep acabou de fechar a opp [nome] (R$[valor]). Parabenize CURTO e PERGUNTE: o que funcionou nessa? (curiosidade genuína, dois objetivos: (1) reforço positivo, (2) você aprende padrões pro perfil dele).

Tom de colega que tá feliz pelo amigo. Sem floreio corporativo.`,
    tools_allowed: ["get_opportunity", "get_contact"],
    cooldown_minutes: 0, // sem cooldown — cada deal merece ser comemorado
  },
  {
    rule_type: "reactive",
    name: "Novo lead atribuído",
    description: "Quando contato é criado/atribuído ao rep no Spark Leads.",
    trigger_config: { event: "contact_assigned_to_rep" },
    prompt_instruction: `Um novo lead [nome] foi atribuído ao rep agora. Mostra: nome, source (se houver), tags. Pergunta: quer que eu agende já uma task de primeiro contato? (use create_task se sim).`,
    tools_allowed: ["get_contact", "create_task"],
    cooldown_minutes: 0,
  },

  // ===== SCHEDULED =====
  {
    rule_type: "scheduled",
    name: "Resumo matinal",
    description: "Bom dia com 3-5 prioridades do dia.",
    trigger_config: { cron: "0 8 * * 1-5" }, // seg-sex 08:00 (timezone resolvido em runtime)
    prompt_instruction: `Bom dia ao rep. Monta o resumo do dia em formato CURTO e direto:
- Appointments de hoje (use list_appointments com when=today)
- Top 3 oportunidades abertas mais quentes (list_opportunities com status=open, ordene por valor desc)
- Tasks vencendo hoje (lookup tasks com due_at hoje)

Estrutura: 1 frase intro + 3-5 bullets curtos. Sem "claro!" ou floreio. Termine com "bom trabalho hoje" ou similar de colega.`,
    tools_allowed: ["list_appointments", "list_opportunities", "get_contact_tasks"],
    cooldown_minutes: 720, // 12h — garante 1x por dia mesmo se cron rodar 2x
    ai_model: "claude-sonnet-4-6", // resumo merece modelo mais inteligente
  },
  {
    rule_type: "scheduled",
    name: "Resumo fim do dia",
    description: "Final de tarde, o que foi feito + o que ficou pendente.",
    trigger_config: { cron: "0 18 * * 1-5" },
    prompt_instruction: `Faz o fechamento do dia do rep. Curto:
- Reuniões que rolaram hoje (list_appointments today, status=showed/completed)
- Pendências pra amanhã (tasks com due_at amanhã + appointments amanhã)
- Se houver alerta importante (opp que ficou parada hoje, lead que não respondeu), menciona

Termina com algo natural como "amanhã a gente segue" — sem ser formal.`,
    tools_allowed: ["list_appointments", "get_contact_tasks", "list_opportunities"],
    cooldown_minutes: 720,
    ai_model: "claude-sonnet-4-6",
  },
  {
    rule_type: "scheduled",
    name: "Reflexão semanal",
    description: "Sexta 17h — visão da semana com padrões observados.",
    trigger_config: { cron: "0 17 * * 5" }, // sexta 17:00
    prompt_instruction: `Final de semana. Reflexão sobre a semana do rep (use list_appointments com when=week, list_opportunities pra ver mudanças de stage, etc):
- Win da semana (opp fechada, deal grande, etc)
- Padrão observado (ex: "vc respondeu mais rápido leads de [tag X]")
- 1 sugestão pra próxima semana

Tom: amigo experiente que reflete junto. Não corporativo.`,
    tools_allowed: ["list_appointments", "list_opportunities", "list_pipelines"],
    cooldown_minutes: 4320, // 3 dias — uma reflexão por semana
    ai_model: "claude-sonnet-4-6",
  },
  {
    rule_type: "scheduled",
    name: "Pipeline review",
    description: "Segunda 09h — status do funil + leads frios.",
    trigger_config: { cron: "0 9 * * 1" }, // segunda 09:00
    prompt_instruction: `Início de semana. Resumo do funil do rep:
- Quantas opps em cada stage (use list_pipelines + list_opportunities)
- Top 3 mais quentes pra atacar essa semana
- Top 3 frias (sem mudança há >7d) pra revisar

Curto, em formato de scan. Foque em "o que vale priorizar essa semana".`,
    tools_allowed: ["list_pipelines", "list_opportunities", "get_contact"],
    cooldown_minutes: 4320,
    ai_model: "claude-sonnet-4-6",
  },
];
