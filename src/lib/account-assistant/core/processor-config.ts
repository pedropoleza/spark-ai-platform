/**
 * Helper compartilhado de config do processIncoming (ultra-review 2026-07-22).
 *
 * PROBLEMA que resolve: a rota Stevo (~97% do tráfego inbound) chamava
 * processIncoming com config HARDCODED e ignorava `agent_configs` — então o A5
 * (10 disabled_tools) ficava INERTE no WhatsApp e qualquer edição futura de
 * config (modelo, instruções, tones, tools) não chegava à rota dominante. As
 * rotas webhook-GHL e web-UI já liam o config; a Stevo não. Este mapeador único
 * (usado pelas 3) impede o drift voltar.
 *
 * ⚠️ enable_audio/image/pdf: default TRUE quando ausente (áudio é load-bearing
 * no SparkBot — estudo de uso). O config do hub tinha esses campos FALSE por
 * engano; foram corrigidos pra true junto com este fix, então o `?? true` é
 * apenas a rede de segurança pra configs que nunca setaram o campo.
 */

/** Linha de config que o processIncoming aceita (espelha ProcessInput.config). */
export interface ProcessorConfig {
  confirmation_mode: "always" | "medium_and_high" | "high_only";
  ai_model?: string;
  fallback_model?: string | null;
  custom_instructions?: string | null;
  knowledge_base_instructions?: string | null;
  disabled_tools: string[];
  enabled_kbs: string[];
  tone_creativity?: number | null;
  tone_formality?: number | null;
  tone_naturalness?: number | null;
  tone_aggressiveness?: number | null;
  enable_audio_transcription: boolean;
  enable_image_analysis: boolean;
  enable_pdf_reading: boolean;
}

const DEFAULT_KBS = ["national_life_group", "agency_brazillionaires"];

/**
 * Monta o config do processIncoming a partir de uma row de `agent_configs`
 * (ou null se não achou — cai nos defaults seguros, comportamento de antes).
 */
export function buildProcessorConfig(
  agentConfig: Record<string, unknown> | null | undefined,
): ProcessorConfig {
  const c = agentConfig || {};
  return {
    confirmation_mode:
      (c.confirmation_mode as ProcessorConfig["confirmation_mode"]) || "high_only",
    ai_model: (c.ai_model as string) || undefined,
    fallback_model: (c.fallback_model as string | null) ?? null,
    custom_instructions: (c.custom_instructions as string | null) || null,
    knowledge_base_instructions: (c.knowledge_base_instructions as string | null) || null,
    disabled_tools: Array.isArray(c.disabled_tools) ? (c.disabled_tools as string[]) : [],
    enabled_kbs: Array.isArray(c.enabled_kbs) ? (c.enabled_kbs as string[]) : DEFAULT_KBS,
    tone_creativity: (c.tone_creativity as number | null) ?? null,
    tone_formality: (c.tone_formality as number | null) ?? null,
    tone_naturalness: (c.tone_naturalness as number | null) ?? null,
    tone_aggressiveness: (c.tone_aggressiveness as number | null) ?? null,
    enable_audio_transcription: (c.enable_audio_transcription as boolean) ?? true,
    enable_image_analysis: (c.enable_image_analysis as boolean) ?? true,
    enable_pdf_reading: (c.enable_pdf_reading as boolean) ?? true,
  };
}
