/**
 * Pós-processamento mecânico da resposta da IA.
 *
 * Motivo: mesmo com regras explícitas no prompt ("NÃO comece com oi/olá/sou X"),
 * modelos menores (gpt-4.1-mini, gpt-4o-mini) ocasionalmente ignoram e repetem
 * saudação a cada turno. Garantia prompt-only é insuficiente. Este módulo
 * aplica remoções mecânicas antes da mensagem sair pra IRL.
 *
 * Escopo:
 * - Só atua quando priorTurnCount > 0 (turno não é o primeiro)
 * - Remove saudações, emojis de cumprimento e apresentações pessoais no INÍCIO
 * - Se restar só a apresentação (caso patológico), retorna original pra não
 *   enviar vazio
 */

// Emojis típicos de cumprimento/entusiasmo (literais para evitar flag /u).
// Inclui range smileys (U+1F600-U+1F64F), 👋, 🙌, ✨, 🎉, corações, etc.
const GREETING_EMOJI_CHARSET = "😀😁😂😃😄😅😆😇😈😉😊😋😌😍😎😏😐😑😒😓😔😕😖😗😘😙😚😛😜😝😞😟😠😡😢😣😤😥😦😧😨😩😪😫😬😭😮😯😰😱😲😳😴😵😶😷🙂🙃🙄🙅🙆🙇🙈🙉🙊🙋🙌🙍🙎🙏👋✨🎉❤💙💚💛💜🧡🤍🤎🖤";

const GREETING_PATTERNS: RegExp[] = [
  // Saudações clássicas
  /^[\s]*(oi+|olá+|ola+|hei+|ei+|eae+|e\s*aí+|e\s*ai+|opa+)[\s!.,]*/i,
  /^[\s]*(bom\s+dia+|boa\s+tarde+|boa\s+noite+|bom\s+dia\s*!|boa\s+tarde\s*!|boa\s+noite\s*!)[\s!.,]*/i,
  /^[\s]*(tudo\s+bem\??|td\s+bem\??|tudo\s+j[oó]ia\??|tudo\s+certo\??|como\s+vai\??|como\s+voc[eê]\s+est[aá]\??|beleza\??)[\s!.,?]*/i,
  // Emojis de cumprimento no início
  new RegExp("^[\\s]*[" + GREETING_EMOJI_CHARSET + "]+[\\s!.,]*"),
  // Apresentações pessoais: "sou X", "aqui é o X", "meu nome é X"
  /^[\s]*(aqui\s+é\s+(o\s+|a\s+)?|sou\s+(o\s+|a\s+)?|eu\s+sou\s+(o\s+|a\s+)?|meu\s+nome\s+é\s+)[A-Za-zÀ-ÿ\s]{2,40}([\s,!.]+|$)/i,
  // Empresa/equipe: "da Spark Leads", ", da equipe da X", "do time da X"
  /^[\s]*[,.]?\s*(da\s+|do\s+|de\s+)?(equipe\s+|time\s+|pessoal\s+)?(da\s+|do\s+|de\s+|das\s+|dos\s+)?[A-ZÀ-Ý][A-Za-zÀ-ÿ\s]{1,40}([\s,!.]+|$)/,
];

/**
 * Remove iterativamente os padrões de saudação do início da mensagem.
 * Loop guardado: máximo 10 iterações, nunca reduz abaixo de 3 caracteres.
 */
export function stripLeadingGreetings(msg: string): string {
  if (!msg || typeof msg !== "string") return msg;
  let result = msg;
  let changed = true;
  let guard = 0;

  while (changed && guard < 10) {
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

  result = result.trim();
  // Capitalizar primeira letra se virou minúscula após stripping
  if (result.length > 0 && result[0] !== result[0].toUpperCase()) {
    result = result[0].toUpperCase() + result.slice(1);
  }

  // Salvaguarda: se sobrou nada útil, volta ao original
  return result.length >= 3 ? result : msg;
}

/**
 * Aplica sanitização condicional à resposta da IA, considerando o formato
 * (string ou array de strings). Só atua em turnos posteriores ao 1º.
 */
export function sanitizeAgentMessage(
  message: string | string[],
  priorTurnCount: number | undefined,
): string | string[] {
  if (!priorTurnCount || priorTurnCount === 0) return message;

  if (Array.isArray(message)) {
    // Aplica strip só no primeiro elemento do array (o único que "começa" a resposta).
    // Se após strip o primeiro elemento ficou vazio/minúsculo, remove ele.
    if (message.length === 0) return message;
    const first = message[0];
    const stripped = stripLeadingGreetings(first);
    if (stripped === first) return message;
    if (stripped.length < 3 && message.length > 1) return message.slice(1);
    return [stripped, ...message.slice(1)];
  }

  return stripLeadingGreetings(message);
}
