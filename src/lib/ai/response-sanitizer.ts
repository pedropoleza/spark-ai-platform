/**
 * Pós-processamento mecânico da resposta da IA.
 *
 * Remove saudação/apresentação/reciprocidade quando NÃO é o primeiro turno.
 * Garantia mecânica contra modelo que ignora a regra do prompt.
 *
 * Design:
 * - Patterns principais são específicos e ancorados (ex: empresa SÓ casa se
 *   começar com "da/do/de"). Evita recortar conteúdo válido.
 * - Vocativo (nome do lead solto) é pass SEPARADO e CONDICIONAL — só roda
 *   se alguma saudação foi stripada nesse loop. Previne cortar "Então,".
 * - Travessão e reticências longas são removidos SEMPRE (todo turno).
 */

// Emojis de cumprimento/entusiasmo listados literalmente (sem flag /u).
const GREETING_EMOJI_CHARSET = "😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏😐😑😒😓😔😕😖😗😘😙😚😛😜😝😞😟😠😡😢😣😤😥😦😧😨😩😪😫😬😭😮😯😰😱😲😳😴😵😶😷🙂🙃🙄🙅🙆🙇🙈🙉🙊🙋🙌🙍🙎🙏👋✨🎉❤💙💚💛💜🧡🤍🤎🖤";

// Patterns principais — executados em loop até nada mais casar.
const GREETING_PATTERNS: RegExp[] = [
  // [P1] Saudações clássicas PT
  /^[\s]*(oi+|olá+|ola+|hei+|ei+|eae+|e\s*aí+|e\s*ai+|opa+|alo+|aloha+)(?=[\s!.,?]|$)[\s!.,?]*/i,

  // [P2] Saudações por período do dia
  /^[\s]*(bom\s+dia+|boa\s+tarde+|boa\s+noite+)(?=[\s!.,?]|$)[\s!.,?]*/i,

  // [P3] "Tudo bem?" e variações com reciprocidade encadeada
  //   MATCH: "Tudo bem?", "Tudo bem sim", "Tudo bem por aqui também"
  /^[\s]*(tudo\s+bem|td\s+bem|tudo\s+j[oó]ia|tudo\s+certo|como\s+vai|como\s+voc[eê]\s+est[aá]|beleza)(\s+(sim|certo|claro|também|tb|tbm|obrigad[oa]|por\s+aqui(\s+também)?))*[?!,. ]*/i,

  // [P4a] Reciprocidade "por aqui também", "tudo ótimo por aqui"
  /^[\s]*(por\s+aqui(\s+(também|tb|tbm))?|tudo\s+ótimo\s+por\s+aqui|tudo\s+joia\s+por\s+aqui)[?!,. ]*/i,

  // [P4b] Agradecimentos de abertura
  /^[\s]*(obrigad[oa]\s+por\s+(entrar\s+em\s+contato|escrever|mandar\s+mensagem|(a\s+)?mensagem|sua\s+mensagem))[?!,. ]*/i,
  /^[\s]*(que\s+bom\s+(te\s+(ver|conhecer|ouvir)|falar\s+com\s+voc[eê]))[?!,. ]*/i,

  // [P5] Emojis isolados no começo
  new RegExp("^[\\s]*[" + GREETING_EMOJI_CHARSET + "]+[\\s!.,]*"),

  // [P6a] Apresentação pessoal COM nome: "Sou Victor", "Aqui é o Victor", "Meu nome é João"
  /^[\s]*(aqui\s+é\s+(o\s+|a\s+)?|sou\s+(o\s+|a\s+)?|eu\s+sou\s+(o\s+|a\s+)?|meu\s+nome\s+é\s+|me\s+chamo\s+)[A-ZÀ-Ý][a-záéíóúâêîôûãõç]{1,20}(\s+[A-ZÀ-Ý][a-záéíóúâêîôûãõç]{1,20})?[?!,. ]*/i,

  // [P6b] Apresentação SEM nome: "Aqui é da equipe de atendimento", "Sou da equipe de X"
  /^[\s]*(aqui\s+é\s+|sou\s+|somos\s+|eu\s+sou\s+)(da\s+|do\s+|de\s+)?(equipe|time|pessoal|galera|staff|suporte|atendimento|comercial)(\s+(de|da|do|dos|das)\s+[A-Za-zÀ-ÿ\s]{1,40})?[?!,. ]*/i,

  // [P7] Referência à empresa/equipe: ", da X", "do time da X", "da equipe da X"
  //   PREFIXO OBRIGATÓRIO: "da|do|de" (não casa sem esse prefixo)
  /^[\s]*,?\s*(da|do|de|das|dos)\s+(equipe\s+(da|do|de)\s+|time\s+(da|do|de)\s+|pessoal\s+(da|do|de)\s+|galera\s+(da|do|de)\s+)?[A-ZÀ-Ý][A-Za-zÀ-ÿ]{1,20}(\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ]{1,20}){0,2}(?=[\s,!.?]|$)[?!,. ]*/i,
];

// Pattern de vocativo — SEM flag /i (requer maiúscula literal) e só é
// aplicado APÓS uma saudação ter sido removida na mesma iteração.
// MATCH: "Gabriel!", ", Maria?", " João,"
// NÃO MATCH quando rodado sozinho: "Então,", "Claro!", "Entendi."
//   (não são "apresentação reciprocal", mas como só roda depois de
//    strip de saudação, não são alcançados)
const VOCATIVE_PATTERN = /^[\s,]*[A-ZÀ-Ý][a-záéíóúâêîôûãõç]{1,25}\s*[!?,.]\s*/;

/**
 * Remove iterativamente os padrões de saudação/apresentação do INÍCIO.
 * Vocativo é removido APENAS após uma saudação ser removida na mesma iteração.
 * Guarda: máx 15 iterações, nunca reduz abaixo de 3 chars úteis.
 */
export function stripLeadingGreetings(msg: string): string {
  if (!msg || typeof msg !== "string") return msg;
  let result = msg;
  let guard = 0;
  let greetingStrippedThisLoop = true; // primeira iteração sempre roda

  while (guard < 15 && greetingStrippedThisLoop) {
    greetingStrippedThisLoop = false;
    guard++;

    // Pass 1: patterns principais
    for (const p of GREETING_PATTERNS) {
      const next = result.replace(p, "");
      if (next !== result && next.length >= 3) {
        result = next;
        greetingStrippedThisLoop = true;
      }
    }

    // Pass 2 (condicional): vocativo, só se strippamos alguma saudação
    if (greetingStrippedThisLoop) {
      const vocNext = result.replace(VOCATIVE_PATTERN, "");
      if (vocNext !== result && vocNext.length >= 3) {
        result = vocNext;
      }
    }
  }

  // Cleanup: pontuação solta e emojis órfãos no começo
  result = result.replace(/^[\s,.!?;:]+/, "").trim();
  const emojiLeadRe = new RegExp("^[" + GREETING_EMOJI_CHARSET + "]+[\\s,.!?;:]*");
  result = result.replace(emojiLeadRe, "").trim();

  // Capitalizar primeira letra se virou minúscula após stripping
  if (result.length > 0 && /[a-záéíóúâêîôûãõç]/.test(result[0])) {
    result = result[0].toUpperCase() + result.slice(1);
  }

  // Salvaguarda: se sobrou pouco útil, volta ao original (nunca deixa muda)
  return result.length >= 3 ? result : msg;
}

/**
 * Remove travessão/reticências e normaliza pontuação.
 * SEMPRE ativo (todo turno, todo tipo de agente).
 */
export function stripDashes(msg: string): string {
  if (!msg || typeof msg !== "string") return msg;
  return msg
    // Após pontuação final (?/./!): remove travessão sem adicionar vírgula
    .replace(/([?!.])\s*[—–]\s*/g, "$1 ")
    // Caso geral: travessão vira vírgula + espaço
    .replace(/\s*[—–]\s*/g, ", ")
    // Reticências longas ("...") viram ponto
    .replace(/\.{3,}/g, ".")
    // Vírgula depois de pontuação final — normaliza
    .replace(/([?!.])\s*,\s*/g, "$1 ")
    // Limpezas
    .replace(/\s+,/g, ",")
    .replace(/,\s*,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/**
 * Aplica sanitizações na resposta, preservando formato (string ou array).
 * - stripDashes: SEMPRE (todo turno)
 * - stripLeadingGreetings: só em turnos > 1
 */
export function sanitizeAgentMessage(
  message: string | string[],
  priorTurnCount: number | undefined,
): string | string[] {
  const applyBoth = (s: string): string => {
    let out = stripDashes(s);
    if (priorTurnCount && priorTurnCount > 0) {
      out = stripLeadingGreetings(out);
    }
    return out;
  };

  if (Array.isArray(message)) {
    if (message.length === 0) return message;
    const sanitized = message.map(applyBoth);
    if (sanitized[0].length < 3 && sanitized.length > 1) return sanitized.slice(1);
    return sanitized;
  }

  return applyBoth(message);
}
