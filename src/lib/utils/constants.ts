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
    description: "Qualifica leads e agenda reunioes com corretores",
    icon: "Headphones",
  },
  recruitment_agent: {
    name: "Agente de Recrutamento",
    description: "Qualifica candidatos e agenda entrevistas com especialistas",
    icon: "Users",
  },
  account_assistant: {
    name: "Assistente de Conta",
    description: "Auxilia clientes com duvidas sobre suas contas",
    icon: "UserCog",
    comingSoon: true,
  },
} as const;

export const OBJECTIVES = {
  qualification_only: {
    label: "Apenas Qualificacao",
    description: "O agente coleta informacoes sem agendar reuniao",
  },
  qualification_and_booking: {
    label: "Qualificacao + Agendamento",
    description: "O agente qualifica o lead e agenda uma reuniao",
  },
  booking_only: {
    label: "Apenas Agendamento",
    description: "O agente agenda reuniao sem perguntas de qualificacao",
  },
} as const;
