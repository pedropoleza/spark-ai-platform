/**
 * Guarda determinística contra follow-up que REPETE pergunta ignorada
 * (caso Alves Cury 2026-08-31 — o "pediu nome 5×" da Lucy voltou como
 * "em qual estado?" 3× pra Cleidmar, Joe e Marcos Ciprian em 26-27/08).
 *
 * A regra "nunca repita pergunta que o lead ignorou" existia SÓ em prompt
 * (custom_prompt do follow-up, v3 de 17/08) e comprovadamente vaza — classe
 * H73/H85: instrução de prompt não sobrevive; quem garante é o código.
 *
 * O guard compara os PEDIDOS do texto candidato com os pedidos que a IA já
 * mandou na conversa (linhas AGENTE do histórico). Duas vias de match:
 *  1. Mesma FAMÍLIA de dado (estado, nome, trabalho, telefone, horário...) —
 *     precisa e cobre paráfrase ("em qual estado você mora?" ↔ "me conta em
 *     qual estado você está").
 *  2. Similaridade token-set (Dice) sobre tokens de conteúdo (deburr, sem
 *     stopwords pt/es) — cobre repetição fora das famílias mapeadas.
 *
 * Puro e testável. Quem decide o que fazer com o veredito é o runner
 * (regenerar 1x com proibição explícita; repetiu de novo → cancela o toque).
 */

const STOPWORDS = new Set(
  (
    "a o as os de do da dos das em no na nos nas um uma que e ou é eh você voce vc " +
    "para pra pro com sem seu sua seus suas te me eu tu ele ela por aqui ali la já ja " +
    "se tem ter mais como mas ainda então entao ai aí ok tudo bem esta está estao estão " +
    "ser sao são foi vai vou pode podemos possa quando onde qual quais quem muito bem " +
    "só so até ate depois antes hoje amanhã amanha agora dia deu dar isso isto aquilo " +
    // espanhol (leads hispânicos — caso Marcos Ciprian)
    "el la los las un una en tu te con eso esto puedo puedes estás estas qué que cómo " +
    "cuál cual dónde donde para por según segun también tambien"
  )
    .split(/\s+/)
    .filter(Boolean),
);

// Verbos de pedido — não carregam o CONTEÚDO do pedido, saem dos tokens.
const ASK_VERBS = new Set(
  "conta fala diz diga manda mandar envia enviar passa passar responde responder informa informar cuéntame cuentame dime mándame mandame".split(/\s+/),
);

/** Famílias de dado que a IA costuma pedir. Mesmo family em 2 pedidos = repetição. */
const FAMILIAS: Record<string, string[]> = {
  estado: ["estado", "estados"],
  nome: ["nome", "chama", "chamar", "chamo", "llamas", "nombre"],
  trabalho: ["faz", "fazendo", "trabalha", "trabalho", "trabalhando", "ocupacao", "profissao", "trabajas", "trabajo", "dedicas"],
  telefone: ["telefone", "numero", "whatsapp", "celular", "telefono"],
  horario: ["horario", "horarios", "horas", "hora", "agenda", "agendar", "disponibilidade"],
  documentacao: ["social", "security", "ssn", "permissao", "permit", "documentacao", "documento", "green", "card"],
};

export function deburrLower(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

/** Tokens de conteúdo de uma frase (deburr, sem pontuação/stopwords/ask-verbs). */
export function contentTokens(sentence: string): string[] {
  return deburrLower(sentence)
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t) && !ASK_VERBS.has(t));
}

/**
 * Extrai os PEDIDOS de um texto: frases interrogativas ("?") e imperativos de
 * pedido ("me conta...", "pode me mandar...", "preciso do...").
 */
export function extractAsks(text: string): string[] {
  if (!text) return [];
  const sentences = text
    .split(/(?<=[.!?\n])\s*/u)
    .map((s) => s.trim())
    .filter(Boolean);
  const asks: string[] = [];
  for (const s of sentences) {
    const isQuestion = s.endsWith("?") || s.includes("?");
    const isImperativeAsk =
      /(?:^|\b)(me\s+(conta|fala|diga?|manda|diz|passa|informa)|pode\s+me\s+(mandar|falar|dizer|passar)|preciso\s+(do|de|que|saber)|s[óo]\s+preciso|cu[ée]ntame|d[íi]me|m[áa]ndame)\b/iu.test(
        s,
      );
    // Oferta de horário é pedido-de-escolha ("Tem quinta às 7 ou sexta às 2.")
    // — sem isto, o follow-up que re-oferece os MESMOS slots não era flagado.
    const isSlotOffer =
      /\b(tem|tenho|consigo|tengo)\b/iu.test(s) &&
      /\d{1,2}\s*(?:da\s+(?:manh|tard|noit)|[ap]m\b|h\b|:\d{2})/iu.test(s);
    if (isQuestion || isImperativeAsk || isSlotOffer) asks.push(s);
  }
  return asks;
}

function familiesOf(tokens: string[]): Set<string> {
  const fams = new Set<string>();
  for (const t of tokens) {
    for (const [fam, words] of Object.entries(FAMILIAS)) {
      if (words.includes(t)) fams.add(fam);
    }
  }
  return fams;
}

function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return (2 * inter) / (a.size + b.size);
}

export interface RepeatVerdict {
  repeated: boolean;
  /** O pedido anterior que o candidato repete (pra injetar na regeneração). */
  matched?: string;
  via?: "familia" | "similaridade";
  similarity?: number;
}

/**
 * O texto candidato de follow-up repete algum pedido que a IA já fez?
 * `priorAiTexts` = textos outbound anteriores da IA nesta conversa (ordem livre).
 */
export function isRepeatedAsk(
  candidate: string,
  priorAiTexts: string[],
  opts: { diceThreshold?: number; minShared?: number } = {},
): RepeatVerdict {
  const threshold = opts.diceThreshold ?? 0.55;
  const minShared = opts.minShared ?? 2;

  const candAsks = extractAsks(candidate);
  if (candAsks.length === 0) return { repeated: false };

  const priorAsks: string[] = [];
  for (const t of priorAiTexts) priorAsks.push(...extractAsks(t));
  if (priorAsks.length === 0) return { repeated: false };

  for (const cand of candAsks) {
    const cTokens = contentTokens(cand);
    const cSet = new Set(cTokens);
    const cFams = familiesOf(cTokens);
    for (const prior of priorAsks) {
      const pTokens = contentTokens(prior);
      const pSet = new Set(pTokens);
      // Via 1: mesma família de dado (estado↔estado, nome↔chamar...).
      const pFams = familiesOf(pTokens);
      for (const f of cFams) {
        if (pFams.has(f)) {
          return { repeated: true, matched: prior, via: "familia" };
        }
      }
      // Via 2: similaridade token-set.
      let shared = 0;
      for (const t of cSet) if (pSet.has(t)) shared++;
      const d = dice(cSet, pSet);
      if (shared >= minShared && d >= threshold) {
        return { repeated: true, matched: prior, via: "similaridade", similarity: d };
      }
    }
  }
  return { repeated: false };
}

/**
 * Linhas "AGENTE: ..." de um recentHistory ("LEAD: ...\nAGENTE: ..." — formato
 * do follow-up runner) → só os textos da IA.
 */
export function agentLinesFromHistory(recentHistory: string): string[] {
  if (!recentHistory) return [];
  return recentHistory
    .split("\n")
    .filter((l) => l.startsWith("AGENTE:"))
    .map((l) => l.slice("AGENTE:".length).trim())
    .filter(Boolean);
}
