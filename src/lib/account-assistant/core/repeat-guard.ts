/**
 * Anti-repeat guard (F57, Fix bug observado em prod 2026-06-04 — Sieder + Soraia).
 *
 * O coherence loop-breaker (F53) só roda DENTRO do bloco `if (!coherence.coherent)`.
 * Mas o loop verbatim mais comum acontece em turnos COERENTES: o bot ecoa a própria
 * última mensagem (re-perguntar "Confirma?", repetir "Nota salva", repetir um
 * fallback honesto que já virou parte do histórico). Como o texto ecoado não afirma
 * escrita nenhuma, a coerência passa, o gate não dispara, e o rep fica preso
 * recebendo a MESMA mensagem sem conseguir sair.
 *
 * Este guard é INDEPENDENTE de coherence: detecta quando o texto que o bot VAI
 * mandar é quase-idêntico a uma das últimas mensagens do PRÓPRIO bot e força um
 * desvio (re-run sem tools → resposta diferente; se ainda repetir, fallback
 * determinístico que garantidamente quebra o loop).
 *
 * Puro/testável: a detecção (normalização + near-dup + findBotEcho) não tem efeito
 * colateral. O re-run/fallback é orquestrado no processor.
 */
import type { LLMMessage } from "../llm-client";

/**
 * Normaliza pra comparação de repetição: minúsculas, sem acentos, sem
 * espaços/pontuação/símbolos/emojis. Assim "Confirma? 1. Confirmar ✅" e
 * "confirma 1 confirmar" colapsam no mesmo, e diferenças de travessão/emoji
 * não escondem um eco.
 */
export function normalizeForRepeat(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // tira acentos (combining diacritical marks)
    .replace(/[\s\p{P}\p{S}]/gu, "") // tira espaços, pontuação, símbolos/emojis
    .trim();
}

/**
 * Comprimento mínimo (normalizado) pra considerar repetição. Evita matar acks
 * curtos e naturais ("ok", "feito!", "beleza 😊") que repetem sem ser bug.
 */
export const MIN_REPEAT_LEN = 25;

/**
 * a e b são quase-idênticos? Igualdade normalizada, OU um contém INTEIRO o outro
 * com ≥80% do tamanho (cobre "o bot repetiu a msg e só acrescentou uma frasezinha").
 * Casos reais de prod são exatos (ratio 1.0) — o containment é o bônus de robustez.
 */
export function isNearDuplicate(a: string, b: string): boolean {
  const na = normalizeForRepeat(a);
  const nb = normalizeForRepeat(b);
  if (na.length < MIN_REPEAT_LEN || nb.length < MIN_REPEAT_LEN) return false;
  if (na === nb) return true;
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (long.includes(short) && short.length / long.length >= 0.8) return true;
  return false;
}

/**
 * O texto que o bot vai mandar é eco de uma das últimas `lookback` msgs do
 * PRÓPRIO bot no histórico? Retorna a msg ecoada (pra logar) ou null.
 *
 * Olha só mensagens do assistant com content string (texto que o rep viu).
 * lookback=5 (estudo 2026-06-24, fix 2.2): lookback=2 só pegava o A-B-A imediato;
 * o caso Leidi/Daniely teve o MESMO "Confirma?" re-perguntado 4× espalhado por
 * vários turnos e horas — os ecos caíam fora da janela de 2. Janela maior pega
 * o loop disperso sem matar acks curtos (protegidos por MIN_REPEAT_LEN).
 */
export function findBotEcho(currentText: string, history: LLMMessage[], lookback = 5): string | null {
  if (!currentText || normalizeForRepeat(currentText).length < MIN_REPEAT_LEN) return null;
  const assistantTexts = history
    .filter((m) => m.role === "assistant" && typeof m.content === "string")
    .map((m) => m.content as string);
  const recent = assistantTexts.slice(-lookback);
  for (const prev of recent) {
    if (isNearDuplicate(currentText, prev)) return prev;
  }
  return null;
}

/**
 * Diretiva pro re-run quebrar o loop — SEM tools (zero side-effect; o confirmation
 * gate já protege escrita). Instrui o LLM a NÃO repetir e a tratar o que o rep
 * realmente disse.
 */
export const REPEAT_BREAK_DIRECTIVE =
  "ATENCAO INTERNA (nao mencione isso ao usuario): voce acabou de enviar essa MESMA mensagem (ou quase) " +
  "no turno anterior e o usuario respondeu de novo. Repetir trava a conversa. NAO repita o mesmo texto. " +
  "Faca UMA destas, de forma breve e natural: " +
  "(a) responda DIRETO a duvida ou objecao que o usuario acabou de levantar; " +
  "(b) se voce esta esperando uma confirmacao que nao veio, explique em 1 frase o que a opcao/confirmacao faz e pergunte de um jeito diferente; " +
  "(c) se travou tentando uma acao, diga com honestidade o que falta pra concluir. " +
  "A resposta tem que ser DIFERENTE da sua ultima mensagem.";

/**
 * Fallback determinístico (último recurso, se o re-run ainda repetir ou vier
 * vazio). Texto garantidamente diferente que devolve a palavra pro rep e quebra
 * o loop de vez.
 */
export const REPEAT_HARD_FALLBACK =
  "Opa, acho que acabei te respondendo a mesma coisa 😅. Me explica com outras palavras o que você precisa que eu já resolvo!";
