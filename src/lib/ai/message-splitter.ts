/**
 * Splitter determinístico da saída lead-facing (healthcheck 2026-07-23, caso
 * "five star ricos" / location jA6uzx6tONyTeocxw4Cj).
 *
 * O agente de vendas (Sonnet) às vezes ignora a regra de "mensagens curtas" do
 * prompt e manda um PARÁGRAFO ÚNICO de 700-800 chars numa só bolha — um wall of
 * text no WhatsApp/SMS. O prompt já pede brevidade + array de bolhas, mas o
 * modelo escapa uma fração das vezes (healthcheck: p90=523, max=787, sempre
 * 1 bolha). Confiar só no prompt não resolve — mesma lição do outbound-sanitizer
 * (caso Marina): a garantia tem que ser DETERMINÍSTICA, no último passo antes de
 * enviar.
 *
 * Este módulo quebra bolhas longas em várias bolhas curtas, cortando SEMPRE em
 * fim de frase (nunca no meio de palavra), SEM PERDER CONTEÚDO — o excedente que
 * passa do teto de bolhas é FUNDIDO na última, nunca descartado (lição H52/caso
 * Andrea: `slice(0, N)` silenciava conteúdo). Bolha já curta passa intacta
 * (paridade total pros agentes que não têm o problema).
 *
 * Additive/reversível: sem bolha longa = comportamento idêntico ao de antes.
 */

// Acima deste tamanho, a bolha é quebrada. Abaixo, passa intacta.
// p90 do location afetado = 523 chars → 550 deixa a conversa normal intacta e
// só pega os "walls" (o topo da distribuição, ~8% das mensagens).
export const SPLIT_TRIGGER_CHARS = 550;

// Alvo de tamanho de cada bolha resultante ao quebrar (empacota frases até aqui).
const CHUNK_TARGET_CHARS = 300;

// Uma frase sozinha acima disso é quebrada por espaço (fallback pra parágrafo
// sem pontuação — raro, mas evita uma bolha gigante escapar).
const SENTENCE_HARD_CHARS = 400;

// Teto de bolhas por turno (anti-spam). Excedente é FUNDIDO na última bolha, não
// descartado (H52 no-loss). Mesmo teto do splitter do SparkBot (sparkbot-send.ts).
const MAX_BUBBLES = 5;

/**
 * Quebra um texto em frases. Corta em fim de frase (. ! ? …) seguido de espaço,
 * mantendo a pontuação junto da frase. Quebras de linha também são fronteiras.
 */
function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Fallback: frase única acima de `max` chars (parágrafo corrido sem pontuação).
 * Corta no último espaço antes do teto; se não houver espaço útil, corte duro.
 */
function hardSplitLongSentence(sentence: string, max: number): string[] {
  if (sentence.length <= max) return [sentence];
  const out: string[] = [];
  let rest = sentence;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max);
    if (cut < max * 0.5) cut = max; // sem espaço útil na 2ª metade → corte cru
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) out.push(rest);
  return out;
}

/** Empacota frases em bolhas de até ~CHUNK_TARGET_CHARS, sem cortar frase. */
function packSentences(sentences: string[]): string[] {
  const chunks: string[] = [];
  let cur = "";
  for (const s of sentences) {
    for (const piece of hardSplitLongSentence(s, SENTENCE_HARD_CHARS)) {
      if (!cur) {
        cur = piece;
      } else if (cur.length + 1 + piece.length <= CHUNK_TARGET_CHARS) {
        cur = `${cur} ${piece}`;
      } else {
        chunks.push(cur);
        cur = piece;
      }
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

/**
 * Quebra UMA bolha em várias, se ela passar do gatilho. Bolha curta volta como
 * `[texto]`; string vazia vira `[]` (o chamador decide o fallback).
 */
export function splitLongBubble(text: string): string[] {
  const t = (text || "").trim();
  if (!t) return [];
  if (t.length <= SPLIT_TRIGGER_CHARS) return [t];
  const packed = packSentences(splitIntoSentences(t));
  return packed.length ? packed : [t];
}

// Teto de tamanho de um FOLLOW-UP. Diferente da conversa ao vivo: um follow-up
// é UM toque curto e direto (a cliente do five star ricos pediu explicitamente
// "mais curto e certeiro", ex: "pode mandar os dados pra eu preparar a cotação?"
// ~75 chars). Nunca vira várias bolhas — é um lembrete, não uma conversa.
export const FOLLOWUP_MAX_CHARS = 260;

/**
 * Condensa um follow-up pra UMA mensagem curta. Mantém FRASES INTEIRAS até o
 * budget (garante ao menos a 1ª frase — normalmente já contém o pedido). No-op
 * pra follow-up já curto. Determinístico: é o backstop pro modelo que ignora a
 * regra de brevidade do prompt (mesma filosofia do sanitizer/splitter).
 */
export function condenseFollowUp(text: string, maxChars = FOLLOWUP_MAX_CHARS): string {
  const t = (text || "").trim();
  if (t.length <= maxChars) return t;
  const sentences = splitIntoSentences(t);
  let out = "";
  for (const s of sentences) {
    if (!out) {
      out = s;
    } else if (out.length + 1 + s.length <= maxChars) {
      out = `${out} ${s}`;
    } else {
      break;
    }
  }
  // 1ª frase sozinha já passa do budget → corta por espaço (raro).
  if (out.length > maxChars) out = hardSplitLongSentence(out, maxChars)[0];
  return out || t.slice(0, maxChars).trim();
}

export interface SplitOutboundResult {
  messages: string[];
  didSplit: boolean; // true se ALGUMA bolha foi de fato quebrada
}

/**
 * Normaliza um array de bolhas lead-facing: quebra as longas e aplica o teto de
 * bolhas (excedente fundido na última). NUNCA descarta conteúdo.
 */
export function splitLeadOutbound(messages: string[]): SplitOutboundResult {
  const expanded: string[] = [];
  let didSplit = false;

  for (const m of messages) {
    const parts = splitLongBubble(m);
    if (parts.length > 1) didSplit = true;
    expanded.push(...parts);
  }

  // Teto de bolhas: funde o excedente na última (H52 no-loss), nunca corta.
  let capped = expanded;
  if (expanded.length > MAX_BUBBLES) {
    capped = [
      ...expanded.slice(0, MAX_BUBBLES - 1),
      expanded.slice(MAX_BUBBLES - 1).join("\n\n"),
    ];
  }

  return { messages: capped.filter((s) => s.trim()), didSplit };
}
