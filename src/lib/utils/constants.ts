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
  recruitment_agent: {
    name: "Agente de Recrutamento",
    description: "Qualifica candidatos e agenda entrevistas com especialistas",
    icon: "Users",
  },
  account_assistant: {
    name: "Assistente de Conta",
    description: "Auxilia clientes com dúvidas sobre suas contas",
    icon: "UserCog",
    comingSoon: true,
  },
} as const;

export const CONVERSATION_TEMPLATES = [
  {
    id: "recruitment_aggressive",
    label: "Recrutamento Direto",
    description: "Foca em agendar reunião rapidamente, cria urgência",
    instructions: "Seu objetivo é agendar uma conversa rápida com o especialista. Seja direto mas amigável. Crie curiosidade sobre a oportunidade sem dar muitos detalhes — os detalhes ficam pra reunião. Se o lead demonstrar qualquer interesse, proponha horários imediatamente. Não prolongue a conversa com muitas perguntas.",
  },
  {
    id: "sales_consultive",
    label: "Vendas Consultiva",
    description: "Entende a dor do cliente antes de propor solução",
    instructions: "Entenda primeiro a situação e necessidade do lead. Faça perguntas sobre o momento atual, desafios e objetivos. Só depois de entender o contexto, apresente como podemos ajudar. Conecte os benefícios do produto/serviço com os problemas mencionados pelo lead. Agende quando sentir que o lead está convencido.",
  },
  {
    id: "qualification_fast",
    label: "Qualificação Rápida",
    description: "Coleta dados essenciais e qualifica rapidamente",
    instructions: "Colete as informações necessárias de forma natural e rápida. Não se aprofunde em conversas longas. Seja objetivo mas educado. Após coletar os dados essenciais, informe que a equipe entrará em contato com mais detalhes.",
  },
  {
    id: "rapport_first",
    label: "Rapport e Conexão",
    description: "Prioriza criar conexão humana antes de qualquer coisa",
    instructions: "Priorize criar uma conexão genuína com o lead. Pergunte sobre a pessoa, sua história, o que faz. Mostre interesse real. Use o nome da pessoa frequentemente. Só depois de criar rapport natural, entre nos assuntos de negócio. A conversa deve parecer entre amigos, não entre vendedor e cliente.",
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
