/**
 * Preços por 1M tokens (USD). Inclui:
 *   - input fresh (token novo, não cached)
 *   - cachedInput (read do prompt cache)
 *   - cacheWriteInput (1ª gravação no cache, premium em Anthropic)
 *   - output (completion)
 *
 * Anthropic:
 *   - cache_read   = 10% do input
 *   - cache_write  = 125% do input  (5min ephemeral)
 *
 * OpenAI:
 *   - GPT-4.1 / o-series cobram 25% no cached
 *   - GPT-4o cobra 50% no cached
 *   - OpenAI não tem cache_write premium
 */
interface ModelPricing {
  input: number;
  cachedInput: number;       // preço lido do cache
  cacheWriteInput: number;   // preço da PRIMEIRA gravação (Anthropic 125%, OpenAI = input)
  output: number;
}

const TOKEN_PRICING: Record<string, ModelPricing> = {
  // ===== Anthropic Claude (cache write = 1.25x input) =====
  "claude-sonnet-4-6":         { input: 3.00,  cachedInput: 0.30,  cacheWriteInput: 3.75,   output: 15.00 },
  // A3 (estudo de custo 2026-07-20): sonnet-5 estava FORA da tabela → caía no DEFAULT
  // gpt-4.1-mini e sub-cobrava ~8x (3 agentes lead-facing ativos, 3 semanas sem ninguém
  // ver). Cobramos o preço de TABELA ($3/$15): a Anthropic pratica intro $2/$10 até
  // 2026-08-31 — a folga cobre o pós-intro sem precisar de update agendado.
  "claude-sonnet-5":           { input: 3.00,  cachedInput: 0.30,  cacheWriteInput: 3.75,   output: 15.00 },
  "claude-haiku-4-5":          { input: 1.00,  cachedInput: 0.10,  cacheWriteInput: 1.25,   output: 5.00  },
  "claude-haiku-4-5-20251001": { input: 1.00,  cachedInput: 0.10,  cacheWriteInput: 1.25,   output: 5.00  },
  // A3: o preço do Opus 4.6 estava 3x ERRADO pra cima ($15/$75 era a família Opus 4.1);
  // Opus 4.5-4.8 custam $5/$25 (cache-read $0.50, write $6.25). 4-7/4-8 preventivos.
  "claude-opus-4-6":           { input: 5.00,  cachedInput: 0.50,  cacheWriteInput: 6.25,   output: 25.00 },
  "claude-opus-4-7":           { input: 5.00,  cachedInput: 0.50,  cacheWriteInput: 6.25,   output: 25.00 },
  "claude-opus-4-8":           { input: 5.00,  cachedInput: 0.50,  cacheWriteInput: 6.25,   output: 25.00 },

  // ===== OpenAI GPT-5.4 (placeholder — modelo não anunciado oficialmente) =====
  // Sinalizado em UI; se algum agent estiver setado nesse modelo o pricing
  // ainda funciona como fallback razoável até preços reais saírem.
  "gpt-5.4-nano":  { input: 0.20,  cachedInput: 0.05,  cacheWriteInput: 0.20,  output: 1.25  },
  "gpt-5.4-mini":  { input: 0.75,  cachedInput: 0.075, cacheWriteInput: 0.75,  output: 4.50  },
  "gpt-5.4":       { input: 2.50,  cachedInput: 0.25,  cacheWriteInput: 2.50,  output: 15.00 },

  // ===== OpenAI GPT-4.1 series =====
  "gpt-4.1-mini":  { input: 0.40,  cachedInput: 0.10,  cacheWriteInput: 0.40,  output: 1.60  },
  "gpt-4.1":       { input: 2.00,  cachedInput: 0.50,  cacheWriteInput: 2.00,  output: 8.00  },
  "gpt-4.1-nano":  { input: 0.10,  cachedInput: 0.025, cacheWriteInput: 0.10,  output: 0.40  },

  // ===== OpenAI o-series (raciocínio) =====
  "o4-mini":       { input: 1.10,  cachedInput: 0.275, cacheWriteInput: 1.10,  output: 4.40  },

  // ===== Legado =====
  "gpt-4o":        { input: 2.50,  cachedInput: 1.25,  cacheWriteInput: 2.50,  output: 10.00 },
  "gpt-4o-mini":   { input: 0.15,  cachedInput: 0.075, cacheWriteInput: 0.15,  output: 0.60  },
};

const DEFAULT_PRICING = TOKEN_PRICING["gpt-4.1-mini"];

/**
 * Audio (Whisper). Preço por SEGUNDO (USD).
 * Whisper-1 cobra $0.006/min = $0.0001/s.
 */
const AUDIO_PRICING: Record<string, number> = {
  "whisper-1": 0.006 / 60,
};

// Pedro 2026-05-04: ajustado pra 10% — foco em adoção, não margem. Cobre
// fees escondidos (GHL marketplace fee ~5%, Stripe se mudar, etc) com
// pequena margem operacional. Pode subir depois se necessário.
const MARKUP_PERCENTAGE = 0.10; // 10%

export interface UsageCost {
  model: string;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  cacheCreationTokens: number;
  totalTokens: number;
  audioSeconds: number;
  costUsd: number;      // custo real
  markupUsd: number;    // 10% markup (Pedro 2026-05-04 — antes era 20%)
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

interface CalculateCostInput {
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  cachedTokens?: number;          // tokens LIDOS do cache (subset de promptTokens)
  cacheCreationTokens?: number;   // tokens GRAVADOS no cache (Anthropic 125%)
  audioSeconds?: number;          // Whisper
  audioModel?: string;            // default whisper-1
}

/**
 * Calcula o custo de uma chamada de IA.
 *
 * Componentes:
 *   - cached:        cachedTokens × cachedInput
 *   - cache_write:   cacheCreationTokens × cacheWriteInput  (Anthropic only, 125%)
 *   - fresh input:   (promptTokens − cachedTokens − cacheCreationTokens) × input
 *   - output:        completionTokens × output
 *   - audio:         audioSeconds × AUDIO_PRICING[model]
 *
 * Convenção: Anthropic SDK retorna cache_creation_input_tokens e
 *            cache_read_input_tokens SEPARADOS de input_tokens.
 *            llm-client.ts soma todos em prompt_tokens pra normalizar com
 *            OpenAI; então aqui descontamos ambos do "fresh" pra evitar
 *            double count.
 */
export function calculateCost(
  modelOrInput: string | CalculateCostInput,
  promptTokens?: number,
  completionTokens?: number,
  cachedTokens?: number,
): UsageCost {
  // Sobrecarga compatível com call sites antigos (4 args posicionais)
  const args: CalculateCostInput = typeof modelOrInput === "string"
    ? {
        model: modelOrInput,
        promptTokens: promptTokens ?? 0,
        completionTokens: completionTokens ?? 0,
        cachedTokens: cachedTokens ?? 0,
      }
    : modelOrInput;

  const model = args.model;
  const promptT = args.promptTokens ?? 0;
  const completionT = args.completionTokens ?? 0;
  const cachedT = args.cachedTokens ?? 0;
  const cacheCreationT = args.cacheCreationTokens ?? 0;
  const audioSec = args.audioSeconds ?? 0;
  const audioModel = args.audioModel ?? "whisper-1";

  const pricing = resolvePricing(model);

  // Cached + cache_write são subconjuntos de prompt_tokens (já somados pelo
  // llm-client.ts). Fresh = promptT - cachedT - cacheCreationT.
  const safeCached = Math.min(cachedT, promptT);
  const safeCacheCreation = Math.min(cacheCreationT, Math.max(0, promptT - safeCached));
  const freshInputTokens = Math.max(0, promptT - safeCached - safeCacheCreation);

  const freshInputCost = (freshInputTokens / 1_000_000) * pricing.input;
  const cachedInputCost = (safeCached / 1_000_000) * pricing.cachedInput;
  const cacheWriteCost = (safeCacheCreation / 1_000_000) * pricing.cacheWriteInput;
  const outputCost = (completionT / 1_000_000) * pricing.output;

  const audioRate = AUDIO_PRICING[audioModel] ?? 0;
  const audioCost = audioSec * audioRate;

  const costUsd = freshInputCost + cachedInputCost + cacheWriteCost + outputCost + audioCost;
  const markupUsd = costUsd * MARKUP_PERCENTAGE;
  const totalChargeUsd = costUsd + markupUsd;

  return {
    model,
    promptTokens: promptT,
    completionTokens: completionT,
    cachedTokens: safeCached,
    cacheCreationTokens: safeCacheCreation,
    totalTokens: promptT + completionT,
    audioSeconds: audioSec,
    costUsd: Math.round(costUsd * 1_000_000) / 1_000_000,
    markupUsd: Math.round(markupUsd * 1_000_000) / 1_000_000,
    totalChargeUsd: Math.round(totalChargeUsd * 1_000_000) / 1_000_000,
  };
}

/**
 * A3 (estudo de custo 2026-07-20): true se o modelo resolve pra pricing CONHECIDO
 * (chave exata, prefixo, ou modelo de áudio). O trackAndCharge usa isto pra emitir
 * admin_signal quando um modelo cai no DEFAULT — o claude-sonnet-5 ficou 3 semanas
 * cobrando ~1/8 do preço real com um console.warn que ninguém lê.
 */
export function isKnownModel(model: string): boolean {
  if (TOKEN_PRICING[model] || AUDIO_PRICING[model]) return true;
  return Object.keys(TOKEN_PRICING).some((key) => model.startsWith(key));
}

/**
 * Formata custo em USD legível.
 *  $0.000 (zero) | $0.5¢ (sub-cent) | $0.0123 (cent+).
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `${(usd * 100).toFixed(3)}¢`;
  return `$${usd.toFixed(4)}`;
}
