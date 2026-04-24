/**
 * Preços por 1M tokens (USD). Incluindo desconto de cached input.
 *
 * OpenAI: modelos GPT-4.1 e o-series cobram 25% nos cached tokens.
 *         gpt-4o series cobra 50% nos cached.
 * Anthropic: cache_read cobra 10% do input. cache_write cobra 125% do input
 *         (tratamos como input normal — conservador; o custo extra sai
 *         quando o cache é gravado pela primeira vez).
 */
interface ModelPricing {
  input: number;
  cachedInput: number; // preço do token lido do cache (por 1M)
  output: number;
}

const TOKEN_PRICING: Record<string, ModelPricing> = {
  // ===== Anthropic Claude =====
  "claude-sonnet-4-6":        { input: 3.00,  cachedInput: 0.30,  output: 15.00 },
  "claude-haiku-4-5":         { input: 0.80,  cachedInput: 0.08,  output: 4.00  },
  "claude-haiku-4-5-20251001":{ input: 0.80,  cachedInput: 0.08,  output: 4.00  },
  "claude-opus-4-6":          { input: 15.00, cachedInput: 1.50,  output: 75.00 },

  // ===== OpenAI GPT-5.4 (reservado para quando lançar) =====
  "gpt-5.4-nano":  { input: 0.20,  cachedInput: 0.05,  output: 1.25  },
  "gpt-5.4-mini":  { input: 0.75,  cachedInput: 0.075, output: 4.50  },
  "gpt-5.4":       { input: 2.50,  cachedInput: 0.25,  output: 15.00 },

  // ===== OpenAI GPT-4.1 series =====
  "gpt-4.1-mini":  { input: 0.40,  cachedInput: 0.10,  output: 1.60  },
  "gpt-4.1":       { input: 2.00,  cachedInput: 0.50,  output: 8.00  },
  "gpt-4.1-nano":  { input: 0.10,  cachedInput: 0.025, output: 0.40  },

  // ===== OpenAI o-series (raciocínio) =====
  "o4-mini":       { input: 1.10,  cachedInput: 0.275, output: 4.40  },

  // ===== Legado =====
  "gpt-4o":        { input: 2.50,  cachedInput: 1.25,  output: 10.00 },
  "gpt-4o-mini":   { input: 0.15,  cachedInput: 0.075, output: 0.60  },
};

const DEFAULT_PRICING = TOKEN_PRICING["gpt-4.1-mini"];

const MARKUP_PERCENTAGE = 0.20; // 20%

export interface UsageCost {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd: number;      // custo real
  markupUsd: number;    // 20% markup
  totalChargeUsd: number; // total a cobrar
}

/**
 * Resolve o pricing para um modelo. Aceita prefixos (ex: "claude-sonnet-4-6-20251103"
 * casa com "claude-sonnet-4-6").
 */
function resolvePricing(model: string): ModelPricing {
  if (TOKEN_PRICING[model]) return TOKEN_PRICING[model];
  // Fallback: prefixo conhecido
  for (const [key, pricing] of Object.entries(TOKEN_PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  console.warn(`[Pricing] Unknown model "${model}" — falling back to gpt-4.1-mini pricing`);
  return DEFAULT_PRICING;
}

/**
 * Calcula o custo de uma chamada de IA.
 * cachedTokens é subconjunto de promptTokens — preço diferenciado (desconto).
 */
export function calculateCost(
  model: string,
  promptTokens: number,
  completionTokens: number,
  cachedTokens: number = 0
): UsageCost {
  const pricing = resolvePricing(model);

  // Cached tokens são um subconjunto de prompt_tokens, cobrados com desconto.
  // Fresh input = prompt_tokens - cached_tokens.
  const safeCached = Math.min(cachedTokens, promptTokens);
  const freshInputTokens = Math.max(0, promptTokens - safeCached);

  const freshInputCost = (freshInputTokens / 1_000_000) * pricing.input;
  const cachedInputCost = (safeCached / 1_000_000) * pricing.cachedInput;
  const outputCost = (completionTokens / 1_000_000) * pricing.output;
  const costUsd = freshInputCost + cachedInputCost + outputCost;
  const markupUsd = costUsd * MARKUP_PERCENTAGE;
  const totalChargeUsd = costUsd + markupUsd;

  return {
    model,
    promptTokens,
    completionTokens,
    cachedTokens: safeCached,
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
