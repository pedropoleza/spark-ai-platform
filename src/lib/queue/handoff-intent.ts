/**
 * "O lead pediu pra falar com humano?" — por INTENÇÃO, não por substring
 * (review de uso 2026-08-25).
 *
 * O BUG: `evaluateShouldRespond` fazia `bodyNorm.includes(keyword)` com as
 * keywords de `custom_keywords_handoff`. O default seeded inclui o substantivo
 * solto **"pessoa"** (presente em 31 dos 32 agent_configs) — e "pessoa" aparece
 * o tempo todo na fala normal de um lead. Resultado medido em 13 dias: **11 de
 * 11 handoffs** da frota foram falso positivo, todos pelo gatilho "pessoa":
 *
 *   "Não sou fumante e sou solteiro, vivo só com uma pessoa"   ← estado civil
 *   "Moro com um pessoa"                                        ← estado civil
 *   "Eu trabalho interna cuidando de pessoas idosas"
 *   "Oi Marina essa pessoa sou eu!"
 *
 * Ou seja: a IA parava de responder exatamente quando o lead estava preenchendo
 * a triagem de underwriting — a hora em que ela mais precisa continuar.
 *
 * A CORREÇÃO: pedir humano é um ATO DE FALA, não uma palavra. O alvo ("pessoa",
 * "humano", "atendente") só conta quando vem acompanhado de intenção — verbo de
 * falar/transferir, desejo explícito, ou pergunta de presença ("tem alguém aí?").
 *
 * A superfície de config NÃO muda: o admin continua editando
 * `custom_keywords_handoff` na UI. O que muda é como cada entrada é lida:
 *   • entrada com ESPAÇO ("falar com alguém", "quero falar com alguém",
 *     "falar com a marcia") já carrega a intenção → segue substring, como antes;
 *   • entrada de UMA PALAVRA ("pessoa", "humano", "atendente") é tratada como
 *     ALVO e exige contexto de intenção por perto.
 *
 * Puro e testável (sem I/O).
 */

/** Normaliza pra comparação: minúsculas, sem acento, espaços colapsados. */
export function normalizarTexto(s: string): string {
  return (s || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Verbos que transformam o alvo num pedido. Sem um destes (ou um dos padrões
 * de presença/desejo abaixo), "pessoa" é só um substantivo da vida do lead.
 */
const VERBOS_FALA = "fal(?:ar|o|a|e|ei)|convers(?:ar|o|a|e)|atend(?:er|e|a|imento)|responder|ajudar";
const VERBOS_TRANSFER =
  "pass(?:a|ar|e|ou)|transfer(?:e|ir|a)|cham(?:a|ar|e)|encaminh(?:a|ar|e)|direcion(?:a|ar|e)|coloc(?:a|ar)";
const DESEJO =
  "quero|queria|gostaria|preciso|precisava|posso|pode|poderia|consigo|tem como|da pra|prefiro|prefiria";
const PRESENCA = "tem|existe|ha|tinha|teria";

/**
 * Conector + determinante entre o verbo e o alvo: "falar **com um** atendente".
 * Curto de propósito — o alvo tem que ser o OBJETO do verbo, não uma palavra
 * que por acaso aparece na mesma frase. Foi essa a lição de rodar o matcher
 * contra as 29 interrupções reais: com janela de 45 chars, "não tem interesse
 * de conversar com alguém que não é aquela **pessoa** do vídeo" ainda casava.
 */
const LIGACAO = "(?:\\s+(?:com|pra|para|c\\/|de|ao|a))?(?:\\s+(?:um|uma|o|a|algum|alguma))?\\s+";

/**
 * NÃO é pedido de handoff: o lead narrando que VAI falar com terceiro.
 * "Tenho que falar com a pessoa / Ele pode hj às 11" — é o cônjuge dele, não
 * o nosso atendimento. Obrigação/futuro + artigo DEFINIDO é a assinatura;
 * "preciso falar com UM atendente" (indefinido) continua sendo pedido.
 */
const NARRATIVA_TERCEIRO =
  "(?:tenho|tinha|preciso|precisava|vou|vamos|devo|deveria)\\s+(?:que\\s+)?(?:falar|conversar)\\s+com\\s+(?:o|a)\\s+";

/**
 * Até este tamanho (chars, texto normalizado), a simples presença do alvo já
 * conta como pedido — ver comentário em `alvoComIntencao`. Calibrado nos dados:
 * a mensagem de pedido mais longa observada é "quero falar com um atendente"
 * (28); a menção-em-frase mais curta entre os falso-positivos de prod tem 130+.
 */
const MSG_CURTA = 45;

/**
 * "humano" também é ADJETIVO em PT, e nessas colocações fixas ele qualifica o
 * substantivo anterior em vez de nomear alguém: "erro humano", "ser humano",
 * "recursos humanos". Nenhuma delas é pedido, e todas cabem numa mensagem curta
 * — então a regra de mensagem curta sozinha as deixaria passar.
 *
 * "atendimento humano" fica de FORA da lista de propósito: aquilo é pedido, e já
 * está no default como frase.
 */
const USO_ADJETIVO =
  "(?:erro|ser|seres|corpo|recursos?|fator|direitos?|lado|calor|toque|contato|comportamento|olhar|julgamento|elemento)\\s+";

/**
 * O alvo de uma palavra aparece como PEDIDO de handoff?
 *
 * Exige que o alvo seja objeto direto de um verbo de fala/transferência, ou de
 * um desejo explícito, ou pergunta de presença ("tem alguém aí?"). O `\b` final
 * impede casar dentro do plural — "cuidando de pessoas idosas" não é pedido.
 */
function alvoComIntencao(textoNorm: string, alvo: string): boolean {
  const alvoEsc = alvo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // O \b final é o que impede "humano" casar dentro de "humanoide" e "pessoa"
  // dentro de "pessoas".
  const alvoRe = `${alvoEsc}\\b`;

  // Bloqueios vencem qualquer padrão positivo: narrativa sobre terceiro
  // ("tenho que falar com a pessoa" = o cônjuge dele) e uso adjetival
  // ("erro humano"). Só descartam a OCORRÊNCIA bloqueada — se o alvo aparece
  // de novo em outro ponto do texto, os padrões abaixo ainda podem casar.
  const bloqueado = new RegExp(`(?:${NARRATIVA_TERCEIRO}|${USO_ADJETIVO})${alvoRe}`, "gi");
  const textoLimpo = textoNorm.replace(bloqueado, " ");
  if (!new RegExp(`\\b${alvoRe}`, "i").test(textoLimpo)) return false;
  textoNorm = textoLimpo;

  // Pedido curto e seco NÃO tem verbo: "humano por favor", "atendente!",
  // "humano?". Quem pede humano digita pouco. Já quem MENCIONA o alvo dentro de
  // uma frase longa está falando de outra coisa ("Gostei da atendente de IA. A
  // ideia era bater um papo e quem sabe um poder ajudar o outro..." — caso real
  // de prod). O comprimento é o discriminador honesto entre os dois.
  if (textoNorm.length <= MSG_CURTA && new RegExp(`\\b${alvoRe}`, "i").test(textoNorm)) {
    return true;
  }

  const padroes = [
    // "quero falar com um atendente" · "to falando com humano" · "me atende uma pessoa"
    new RegExp(`(?:${VERBOS_FALA})\\w*${LIGACAO}${alvoRe}`, "i"),
    // "me passa pra um humano" · "transfere pra uma pessoa" · "chama o atendente"
    new RegExp(`(?:${VERBOS_TRANSFER})\\w*${LIGACAO}${alvoRe}`, "i"),
    // "quero um atendente" · "preciso de um humano" (desejo direto, sem verbo de fala)
    new RegExp(`(?:${DESEJO})${LIGACAO}${alvoRe}`, "i"),
    // "tem alguém aí?" · "tem um atendente disponível?"
    new RegExp(
      `(?:${PRESENCA})${LIGACAO}${alvoRe}[^.!?]{0,20}?\\b(ai|aqui|online|disponivel|agora)\\b`,
      "i",
    ),
  ];
  return padroes.some((rx) => rx.test(textoNorm));
}

export interface HandoffMatch {
  /** A entrada de `custom_keywords_handoff` que casou. */
  keyword: string;
  /** "frase" = entrada com espaço (substring, como antes). "alvo" = palavra só + intenção. */
  modo: "frase" | "alvo";
}

/**
 * Procura pedido de humano na mensagem do lead.
 *
 * @param body     texto da mensagem do lead
 * @param keywords `custom_keywords_handoff` do agente
 * @returns o match, ou null quando não é pedido
 */
export function detectarPedidoDeHumano(
  body: string,
  keywords: string[] | null | undefined,
): HandoffMatch | null {
  if (!body) return null;
  const texto = normalizarTexto(body);
  if (!texto) return null;

  const lista = (keywords || []).map((k) => normalizarTexto(k)).filter(Boolean);
  // Determinismo: frases primeiro (mais específicas), depois alvos.
  const frases = lista.filter((k) => k.includes(" "));
  const alvos = lista.filter((k) => !k.includes(" "));

  for (const k of frases) {
    if (texto.includes(k)) return { keyword: k, modo: "frase" };
  }
  for (const k of alvos) {
    if (alvoComIntencao(texto, k)) return { keyword: k, modo: "alvo" };
  }
  return null;
}
