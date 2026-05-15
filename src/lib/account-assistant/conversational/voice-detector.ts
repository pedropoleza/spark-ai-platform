/**
 * Adaptive Voice Detector (H30.1, Pedro 2026-05-15).
 *
 * Analisa últimas N mensagens do rep e classifica tom. Sistema prompt
 * injeta hint dinâmico pro bot espelhar (mirror) o tom.
 *
 * Classes: short | verbose | urgent | neutral.
 *
 * Heurística simples (NÃO LLM — rápido, determinístico):
 *   - avg chars/msg < 15 + sem pontuação completa → short
 *   - avg > 80 + frases compostas → verbose
 *   - "!!!" / caps lock / "agora" / "urgente" → urgent
 *   - senão → neutral
 */

export type RepStyle = "short" | "verbose" | "urgent" | "neutral";

/**
 * Sample size — só últimas 5 mensagens do rep (não histórico inteiro).
 * Caller filtra por role=user antes de passar.
 */
export function detectRepStyle(recentUserMessages: string[]): RepStyle {
  const sample = recentUserMessages.slice(-5).filter((m) => m && m.trim().length > 0);
  if (sample.length === 0) return "neutral";

  // 1. Urgent — detecta palavras-chave
  const urgentRegex = /!!!|\bagora\b|\burgente\b|\brápido\b|^[A-Z\s!?]{10,}$/;
  for (const msg of sample) {
    if (urgentRegex.test(msg)) return "urgent";
  }

  // 2. Curtos — avg chars baixo + sem pontuação completa
  const avgLen = sample.reduce((sum, m) => sum + m.length, 0) / sample.length;
  const hasCompletePunctuation = sample.some((m) => /[.!?]$/.test(m.trim()));
  const hasAbbrev = sample.some((m) => /\b(vc|blz|tá|pra|t\+|vlw|fmz|ok|sim|n[aã]o)\b/i.test(m));

  if (avgLen < 20 && !hasCompletePunctuation && hasAbbrev) return "short";

  // 3. Verbose — avg alto + frases compostas
  if (avgLen > 80 && sample.some((m) => m.split(/[.!?]/).filter((s) => s.trim().length > 0).length >= 2)) {
    return "verbose";
  }

  return "neutral";
}
