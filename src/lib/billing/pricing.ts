/**
 * Precos por 1M tokens (em USD) — atualizar conforme pricing da OpenAI
 */
const TOKEN_PRICING: Record<string, { input: number; output: number }> = {
  // GPT-5.4 series (flagship, mais recente)
  "gpt-5.4-nano":  { input: 0.20,  output: 1.25  },
  "gpt-5.4-mini":  { input: 0.75,  output: 4.50  },
  "gpt-5.4":       { input: 2.50,  output: 15.00 },
  // GPT-4.1 series (melhor custo-beneficio)
  "gpt-4.1-mini":  { input: 0.40,  output: 1.60  },
  "gpt-4.1":       { input: 2.00,  output: 8.00  },
  // o-series (raciocinio)
  "o4-mini":       { input: 1.10,  output: 4.40  },
  // Legado
  "gpt-4o":        { input: 2.50,  output: 10.00 },
  "gpt-4o-mini":   { input: 0.15,  output: 0.60  },
};

const MARKUP_PERCENTAGE = 0.20; // 20%

export interface UsageCost {
  model: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;      // custo real
  markupUsd: number;    // 20% markup
  totalChargeUsd: number; // total a cobrar
}

/**
 * Calcula o custo de uma chamada de IA
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number
): UsageCost {
  const pricing = TOKEN_PRICING[model] || TOKEN_PRICING["gpt-4.1-mini"];

  const inputCost = (promptTokens / 1_000_000) * pricing.input;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  const costUsd = inputCost + outputCost;
  const markupUsd = costUsd * MARKUP_PERCENTAGE;
  const totalChargeUsd = costUsd + markupUsd;

  return {
    model,
    promptTokens,
    completionTokens,
    totalTokens: promptTokens + completionTokens,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    markupUsd: Math.round(markupUsd * 1_000_000) / 1_000_000,
    totalChargeUsd: Math.round(totalChargeUsd * 1_000_000) / 1_000_000,
  };
}

/**
 * Formata custo em USD legivel
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${(usd * 100).toFixed(3)}¢`;
  return `$${usd.toFixed(4)}`;
}
