export const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

export const GHL_API_VERSION = "2021-07-28";

export const AI_MODELS = [
  // === Claude (Anthropic) ===
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (melhor qualidade)", description: "$3/$15 por 1M tokens", provider: "anthropic" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (rápido e barato)", description: "$0.80/$4 por 1M tokens", provider: "anthropic" },
  // === OpenAI GPT ===
  { value: "gpt-4.1-mini", label: "GPT-4.1 Mini (recomendado)", description: "$0.40/$1.60 por 1M tokens", provider: "openai" },
  { value: "gpt-4.1", label: "GPT-4.1", description: "$2.00/$8.00 por 1M tokens", provider: "openai" },
  { value: "gpt-4o-mini", label: "GPT-4o Mini (legado)", description: "$0.15/$0.60 por 1M tokens", provider: "openai" },
  { value: "o4-mini", label: "o4-mini (raciocínio)", description: "$1.10/$4.40 por 1M tokens", provider: "openai" },
] as const;

export const AGENT_TYPES = {
  sales_agent: {
    name: "Agente de Vendas",
    description: "Qualifica leads e agenda reuniões com corretores",
    icon: "Headphones",
  },
  post_sales_agent: {
    name: "Agente de Pós-Vendas",
    description: "Atende clientes que já compraram: onboarding, NPS, retenção e suporte",
    icon: "Users",
  },
  account_assistant: {
    name: "Assistente de Conta",
    description: "Auxilia clientes com dúvidas sobre suas contas",
    icon: "UserCog",
    comingSoon: true,
  },
} as const;

/**
 * Templates de custom_instructions. Cada um tem `agentType` que limita em qual
 * aba de configuração aparece no dropdown. Evita o admin selecionar "Vendas
 * Consultiva" num agente de pós-vendas (ou vice-versa) e contaminar o prompt.
 * "both" = aparece nos dois tipos (templates genéricos).
 */
export const CONVERSATION_TEMPLATES = [
  // ============== PÓS-VENDAS ==============
  {
    id: "post_sales_onboarding",
    label: "Onboarding / Boas-Vindas",
    description: "Recebe o cliente novo, confirma compra e orienta próximos passos",
    agentType: "post_sales_agent" as const,
    instructions: "Você está dando boas-vindas a um cliente que ACABOU de comprar. Confirme a compra com entusiasmo genuíno, pergunte se ele precisa de alguma ajuda inicial, e oriente sobre os próximos passos (ativação, primeiro uso, contato de suporte). Trate como CLIENTE que já é nosso — nunca tente vender de novo. Seja acolhedor e objetivo. Se surgir dúvida técnica, agende uma conversa com o especialista/CS.",
  },
  {
    id: "post_sales_feedback",
    label: "Feedback / NPS",
    description: "Coleta feedback de satisfação de forma natural",
    agentType: "post_sales_agent" as const,
    instructions: "Você está coletando feedback de um cliente que já usa o produto/serviço há um tempo. Seja breve e genuíno. Pergunte como está sendo a experiência, se há algo que poderíamos melhorar, e qual a nota de 0 a 10 que ele daria. Se a nota for baixa (0-6), não se defenda — agradeça, pergunte o motivo, e agende uma conversa com o CS pra resolver. Se for alta (9-10), pergunte se topa indicar. Nunca use tom comercial.",
  },
  {
    id: "post_sales_retention",
    label: "Retenção / Renovação",
    description: "Retoma contato antes de renovação ou em risco de churn",
    agentType: "post_sales_agent" as const,
    instructions: "Você está falando com um cliente que pode estar em risco de cancelar ou está perto da renovação. NÃO parece desespero, não ofereça desconto de cara. Pergunte genuinamente como está a experiência, se há algo que não atendeu, o que seria ideal mudar. Ouça antes de propor. Se houver problema concreto, agende com o especialista pra resolver. Lembre que é CLIENTE, trate com respeito por já estar aqui — evite tom de vendedor reconquistando lead.",
  },
  // ============== VENDAS ==============
  {
    id: "sales_consultive",
    label: "Vendas Consultiva",
    description: "Entende a dor do cliente antes de propor solução",
    agentType: "sales_agent" as const,
    instructions: "Entenda primeiro a situação e necessidade do lead. Faça perguntas sobre o momento atual, desafios e objetivos. Só depois de entender o contexto, apresente como podemos ajudar. Conecte os benefícios do produto/serviço com os problemas mencionados pelo lead. Agende quando sentir que o lead está convencido. Trate como CLIENTE potencial interessado em contratar um produto/serviço.",
  },
  {
    id: "sales_direct",
    label: "Vendas Direta",
    description: "Foca em agendar reunião com corretor/consultor rapidamente",
    agentType: "sales_agent" as const,
    instructions: "Seu objetivo é agendar uma conversa do lead com o corretor/consultor. Seja claro que estamos falando sobre contratação de um produto/serviço. Colete os dados essenciais para o orçamento e proponha horários assim que possível. Não trate o lead como candidato a emprego, ele é um CLIENTE interessado em contratar.",
  },
  // ============== GENÉRICOS (ambos os tipos) ==============
  {
    id: "qualification_fast",
    label: "Qualificação Rápida",
    description: "Coleta dados essenciais e qualifica rapidamente",
    agentType: "both" as const,
    instructions: "Colete as informações necessárias de forma natural e rápida. Não se aprofunde em conversas longas. Seja objetivo mas educado. Após coletar os dados essenciais, informe que a equipe entrará em contato com mais detalhes.",
  },
  {
    id: "rapport_first",
    label: "Rapport e Conexão",
    description: "Prioriza criar conexão humana antes de qualquer coisa",
    agentType: "both" as const,
    instructions: "Priorize criar uma conexão genuína com o contato. Pergunte sobre a pessoa, sua história, o que faz. Mostre interesse real. Use o nome da pessoa frequentemente. Só depois de criar rapport natural, entre nos assuntos de negócio. A conversa deve parecer entre amigos, não transacional.",
  },
] as const;

export const OBJECTIVES = {
  qualification_only: {
    label: "Apenas Qualificação",
    description: "O agente coleta informações sem agendar reunião",
  },
  qualification_and_booking: {
    label: "Qualificação + Agendamento",
    description: "O agente qualifica o lead e agenda uma reunião",
  },
  booking_only: {
    label: "Apenas Agendamento",
    description: "O agente agenda reunião sem perguntas de qualificação",
  },
} as const;
