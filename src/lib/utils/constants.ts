export const GHL_API_BASE = process.env.GHL_API_BASE || "https://services.leadconnectorhq.com";

export const GHL_API_VERSION = "2021-07-28";

export const AI_MODELS = [
  // GPT-5.4 series (mais recente — flagship)
  { value: "gpt-5.4-nano", label: "GPT-5.4 Nano (mais barato)", description: "$0.20/$1.25 por 1M tokens" },
  { value: "gpt-5.4-mini", label: "GPT-5.4 Mini", description: "$0.75/$4.50 por 1M tokens" },
  { value: "gpt-5.4", label: "GPT-5.4 (flagship)", description: "$2.50/$15.00 por 1M tokens" },
  // GPT-4.1 series (melhor custo-beneficio)
  { value: "gpt-4.1-mini", label: "GPT-4.1 Mini (recomendado)", description: "$0.40/$1.60 por 1M tokens" },
  { value: "gpt-4.1", label: "GPT-4.1", description: "$2.00/$8.00 por 1M tokens" },
  // o-series (raciocinio)
  { value: "o4-mini", label: "o4-mini (raciocinio)", description: "$1.10/$4.40 por 1M tokens" },
  // Legado
  { value: "gpt-4o-mini", label: "GPT-4o Mini (legado)", description: "$0.15/$0.60 por 1M tokens" },
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
