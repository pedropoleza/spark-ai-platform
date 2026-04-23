/**
 * Pós-processamento mecânico da resposta da IA.
 *
 * Remove saudação/apresentação/reciprocidade quando NÃO é o primeiro turno.
 * Garantia mecânica contra modelo que ignora a regra do prompt.
 *
 * Design conservador: cada pattern é específico e exige ancoragem explícita
 * (ex: empresa SÓ casa se começar com vírgula/espaço + "da/do/de"). Evita
 * recortar conteúdo legítimo (ex: "Então, me fala..." NÃO deve virar "Me fala...").
 */

// Emojis de cumprimento/entusiasmo listados literalmente (sem flag /u que quebra em ES5).
const GREETING_EMOJI_CHARSET = "😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏😐😑😒😓😔😕😖😗😘😙😚😛😜😝😞😟😠😡😢😣😤😥😦😧😨😩😪😫😬😭😮😯😰😱😲😳😴😵😶😷🙂🙃🙄🙅🙆🙇🙈🙉🙊🙋🙌🙍🙎🙏👋✨🎉❤💙💚💛💜🧡🤍🤎🖤";

// Cada pattern tem comentário explicando o QUE casa e o QUE não casa.
const GREETING_PATTERNS: RegExp[] = [
  // [P1] Saudações clássicas PT: "Oi", "Olá", "Hei", "Ei", "Opa", "E aí"
  //   MATCH: "Oi!", "Olá, ", "E aí "
  //   NÃO MATCH: "Oiça" (porque requer pontuação/espaço depois)
  /^[\s]*(oi+|olá+|ola+|hei+|ei+|eae+|e\s*aí+|e\s*ai+|opa+|alo+|aloha+)(?=[\s!.,?]|$)[\s!.,?]*/i,

  // [P2] Saudações por período do dia
  /^[\s]*(bom\s+dia+|boa\s+tarde+|boa\s+noite+)(?=[\s!.,?]|$)[\s!.,?]*/i,

  // [P3] "Tudo bem?" e variações — pega versão solta OU com reciprocidade
  // ("Tudo bem?", "Tudo bem sim", "Tudo bem por aqui também", "Td bem obrigado")
  /^[\s]*(tudo\s+bem|td\s+bem|tudo\s+j[oó]ia|tudo\s+certo|como\s+vai|como\s+voc[eê]\s+est[aá]|beleza)(\s+(sim|certo|claro|também|tb|tbm|obrigad[oa]|por\s+aqui(\s+também)?))*[?!,. ]*/i,

  // [P4a] Reciprocidade "por aqui também", "tudo ótimo por aqui"
  /^[\s]*(por\s+aqui(\s+(também|tb|tbm))?|tudo\s+ótimo\s+por\s+aqui|tudo\s+joia\s+por\s+aqui)[?!,. ]*/i,

  // [P4b] Agradecimentos de abertura
  /^[\s]*(obrigad[oa]\s+por\s+(entrar\s+em\s+contato|escrever|mandar\s+mensagem|(a\s+)?mensagem|sua\s+mensagem))[?!,. ]*/i,
  /^[\s]*(que\s+bom\s+(te\s+(ver|conhecer|ouvir)|falar\s+com\s+voc[eê]))[?!,. ]*/i,

  // [P5] Emojis isolados no começo (não se tiverem texto antes)
  new RegExp("^[\\s]*[" + GREETING_EMOJI_CHARSET + "]+[\\s!.,]*"),

  // [P6] Apresentação pessoal: "Sou X", "Aqui é o X", "Meu nome é X"
  //   Aceita 1-2 palavras capitalizadas depois (nome + sobrenome)
  //   Requer verbo explícito no começo (não casa "Então," nem palavras soltas)
  /^[\s]*(aqui\s+é\s+(o\s+|a\s+)?|sou\s+(o\s+|a\s+)?|eu\s+sou\s+(o\s+|a\s+)?|meu\s+nome\s+é\s+|me\s+chamo\s+)[A-ZÀ-Ý][a-záéíóúâêîôûãõç]{1,20}(\s+[A-ZÀ-Ý][a-záéíóúâêîôûãõç]{1,20})?[?!,. ]*/i,

  // [P7] Referência à empresa/equipe: ", da X", "do time da X", "da equipe da X"
  //   PREFIXO OBRIGATÓRIO: vírgula (opcional) + espaço + "da|do|de"
  //   Até 3 palavras capitalizadas depois (nomes compostos de empresa)
  //   NÃO MATCH: "Então," ou qualquer coisa sem o prefixo "da|do|de"
  /^[\s]*,?\s*(da|do|de|das|dos)\s+(equipe\s+(da|do|de)\s+|time\s+(da|do|de)\s+|pessoal\s+(da|do|de)\s+|galera\s+(da|do|de)\s+)?[A-ZÀ-Ý][A-Za-zÀ-ÿ]{1,20}(\s+[A-ZÀ-Ý][A-Za-zÀ-ÿ]{1,20}){0,2}(?=[\s,!.?]|$)[?!,. ]*/i,
];

/**
 * Remove iterativamente os padrões de saudação/apresentação do INÍCIO.
 * Loop guardado: máx 15 iterações, nunca reduz abaixo de 3 caracteres úteis.
 * Se sobrar menos que 3 chars úteis, retorna a mensagem original como fallback.
 */
export function stripLeadingGreetings(msg: string): string {
  if (!msg || typeof msg !== "string") return msg;
  let result = msg;
  let changed = true;
  let guard = 0;

  while (changed && guard < 15) {
    changed = false;
    guard++;
    for (const p of GREETING_PATTERNS) {
      const next = result.replace(p, "");
      if (next !== result && next.length >= 3) {
        result = next;
        changed = true;
      }
    }
  }

  // Cleanup: remover pontuação solta e emojis órfãos no começo após stripping
  result = result.replace(/^[\s,.!?;:]+/, "").trim();
  // Se depois de strip pontuação o primeiro char ainda é emoji isolado, remove
  const emojiLeadRe = new RegExp("^[" + GREETING_EMOJI_CHARSET + "]+[\\s,.!?;:]*");
  result = result.replace(emojiLeadRe, "").trim();

  // Capitalizar primeira letra se virou minúscula após stripping
  if (result.length > 0 && /[a-záéíóúâêîôûãõç]/.test(result[0])) {
    result = result[0].toUpperCase() + result.slice(1);
  }

  // Salvaguarda: se sobrou pouco útil, volta ao original (não deixa a IA muda)
  return result.length >= 3 ? result : msg;
}

/**
 * Remove travessão ("—", "–") substituindo por vírgula + espaço.
 * Trim espaços duplos resultantes. SEMPRE ativo (todo turno, todo tipo de agente).
 * WhatsApp é conversa rápida — travessão parece robô e ninguém digita.
 */
export function stripDashes(msg: string): string {
  if (!msg || typeof msg !== "string") return msg;
  return msg
    // Após pontuação final (?/./!): só remove travessão, não adiciona vírgula
    .replace(/([?!.])\s*[—–]\s*/g, "$1 ")
    // Caso geral: travessão vira vírgula + espaço
    .replace(/\s*[—–]\s*/g, ", ")
    // Vírgula depois de pontuação final ("?," "." etc) — normaliza
    .replace(/([?!.])\s*,\s*/g, "$1 ")
    // Limpezas
    .replace(/\s+,/g, ",")              // " ," vira ","
    .replace(/,\s*,/g, ",")              // ",," vira ","
    .replace(/\s{2,}/g, " ")              // espaços múltiplos viram 1
    .trim();
}

/**
 * Aplica TODAS as sanitizações na resposta:
 * - Remoção de travessão: SEMPRE (todo turno)
 * - Remoção de saudação/apresentação: SÓ em turnos > 1
 *
 * Preserva formato (string ou array).
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
    // Se o 1º ficou inútil (< 3 chars) e tem outros, remove
    if (sanitized[0].length < 3 && sanitized.length > 1) return sanitized.slice(1);
    return sanitized;
  }

  return applyBoth(message);
}
