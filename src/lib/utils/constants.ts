export const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

export const GHL_API_VERSION = "2021-07-28";

export const AI_MODELS = [
  // === Claude (Anthropic) ===
  // Sonnet 4.6 é o padrão (Pedro 2026-05-05) — qualidade muito acima de
  // GPT em stress tests (review 2026-04-28: GPT 6/7 falhas de prompt-following,
  // Claude 0/7). Custo +20% mas vale.
  { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (recomendado)", description: "$3/$15 por 1M tokens", provider: "anthropic" },
  { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (rápido e barato)", description: "$0.80/$4 por 1M tokens", provider: "anthropic" },
  // === OpenAI GPT === (manter pra legado/fallback — usuário pode escolher)
  { value: "gpt-4.1-mini", label: "GPT-4.1 Mini", description: "$0.40/$1.60 por 1M tokens", provider: "openai" },
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
  recruitment_agent: {
    name: "Agente de Recrutamento",
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
 * Consultiva" num agente de recrutamento (ou vice-versa) e contaminar o prompt.
 * "both" = aparece nos dois tipos (templates genéricos).
 */
export const CONVERSATION_TEMPLATES = [
  // ============== RECRUTAMENTO ==============
  {
    id: "recruitment_aggressive",
    label: "Recrutamento Direto",
    description: "Foca em agendar reunião rapidamente, cria urgência",
    agentType: "recruitment_agent" as const,
    instructions: "Seu objetivo é agendar uma conversa rápida com o especialista. Seja direto mas amigável. Crie curiosidade sobre a oportunidade de carreira sem dar muitos detalhes, os detalhes ficam pra reunião. Se o candidato demonstrar qualquer interesse, proponha horários imediatamente. Não prolongue a conversa com muitas perguntas. Trate como CANDIDATO, nunca como comprador. Essa é uma oportunidade de carreira, não uma venda.",
  },
  {
    id: "recruitment_curious",
    label: "Recrutamento por Curiosidade",
    description: "Desperta curiosidade sobre a oportunidade antes de agendar",
    agentType: "recruitment_agent" as const,
    instructions: "Trate o contato como candidato a uma oportunidade profissional. Desperte curiosidade sobre a área e o potencial de carreira. Valorize o candidato como profissional, pergunte sobre a trajetória dele de forma genuína. Quando mencionar a oportunidade, enquadre como desenvolvimento profissional e não como venda. O agendamento é para ele conhecer o processo, não para comprar algo.",
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
