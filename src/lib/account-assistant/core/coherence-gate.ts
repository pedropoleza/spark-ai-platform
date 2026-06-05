// core/coherence-gate.ts — "Verdade de execução" (Onda 1, refatoração V2 2026-05-20)
//
// PRINCÍPIO: o bot só pode AFIRMAR uma escrita (salvei/criei/movi/enviei/marquei)
// se a tool correspondente rodou COM SUCESSO neste turno. Antes (processor.ts) o
// detector de alucinação só gerava signal e "não bloqueava a resposta" — agora
// vira um GATE que age (re-run seguro ou reescrita honesta).
//
// Migrado e estendido de processor.ts. Mudanças vs detector antigo:
//   1. Verifica o RESULTADO da tool, não só o nome. Caso Gustavo msg 114:
//      get_contact_notes retornou {status:"not_found"} e create_note nunca rodou
//      → o detector antigo (por nome) já pegava tools=[], mas write que FALHA
//      passava como satisfeita. Agora exige sucesso.
//   2. Separa oportunidade CRIAR vs MOVER/ATUALIZAR. Caso Henry: "Movido pra
//      Policy Delivery" tendo chamado create_opportunity (2 duplicatas) e zero
//      update — o detector antigo considerava create satisfatória pra "movido".
//   3. analyzeCoherence() decide o caminho SEGURO: re-run só quando NÃO houve
//      escrita bem-sucedida no turno (nada a duplicar). Se já houve escrita ok
//      (ex: 4 mensagens enviadas), NUNCA re-executa — reescreve a parte falsa.
//
// Módulo PURO (sem I/O) — testável via scripts/test-coherence-gate.ts.

export interface ToolCallRecord {
  name: string;
  input?: unknown;
  result?: unknown;
}

// ── Tools de WRITE (mutação no Spark Leads ou no state do bot) ──
const WRITE_TOOL_NAME_PATTERNS = [
  /^create_/, /^update_/, /^delete_/, /^add_/, /^remove_/, /^complete_/,
  /^send_/, /^schedule_/, /^import_/, /^block_/, /^cancel_/, /^pause_/,
  /^resume_/, /^switch_/, /^confirm_/, /^set_/, /^forget_/, /^accept_/,
  /^reject_/, /^reply_/, /^assign_/, /^move_/,
];

export function isWriteTool(toolName: string): boolean {
  return WRITE_TOOL_NAME_PATTERNS.some((re) => re.test(toolName));
}

/**
 * Heurística de sucesso da tool. Conservadora: na dúvida considera SUCESSO
 * (evita bloquear resposta legítima). Só considera FALHA quando o result
 * declara status de erro explicitamente. {simulated:true} (test mode) = ok.
 */
export function toolSucceeded(result: unknown): boolean {
  if (result === null || result === undefined) return false;
  if (typeof result !== "object") return true;
  const r = result as Record<string, unknown>;
  const status = typeof r.status === "string" ? r.status.toLowerCase() : null;
  if (status && ["error", "not_found", "failed", "fail", "denied", "blocked", "rejected"].includes(status)) {
    return false;
  }
  if (r.error !== undefined && r.error !== null && r.error !== false) return false;
  if (r.ok === false || r.success === false) return false;
  return true;
}

// ── Famílias de claim → tools que satisfazem ──
// opportunity dividida em CREATE vs UPDATE/MOVE (caso Henry).
interface ClaimPattern {
  family: string;
  regex: RegExp;
  satisfying_tools: string[];
}

const CLAIM_PATTERNS: ClaimPattern[] = [
  {
    family: "note",
    regex: /\b(nota\s+(salva|criada|adicionada)|notas?\s+(salvas?|criadas?|adicionadas?)|anotei|anota[çc][oõ]es?\s+salvas?|coloquei\s+nas?\s+notas?|salvei\s+a\s+nota|salvei.*como\s+nota|anotado\s+(nos?\s+)?notes?)\b/i,
    satisfying_tools: ["create_note", "update_note"],
  },
  {
    family: "task",
    regex: /\b(task\s+(criada|adicionada|salva|completada|conclu[ií]da)|tarefa\s+(criada|adicionada|salva|completada|conclu[ií]da)|marquei\s+(a\s+)?task)\b/i,
    satisfying_tools: ["create_task", "update_task", "complete_task"],
  },
  {
    family: "tag",
    regex: /\btags?\s+(adicionada|aplicada|colocada|removida|tirada|posta)s?\b/i,
    satisfying_tools: ["add_tag", "remove_tag"],
  },
  {
    family: "reminder",
    regex: /\blembrete\s+(agendado|marcado|criado|salvo|cancelado|removido)s?\b/i,
    satisfying_tools: ["schedule_reminder", "schedule_recurring_reminder", "cancel_reminder"],
  },
  {
    family: "appointment",
    regex: /\b(appointment|reuni[aã]o|agenda\s+do\s+cliente)\s+(marcad[ao]|agendad[ao]|criad[ao]|reagendad[ao]|cancelad[ao]|movid[ao])s?\b|\b(marquei|agendei|reagendei|cancelei)\s+(a\s+)?(reuni[aã]o|appointment|encontro)/i,
    satisfying_tools: ["create_appointment", "update_appointment", "delete_appointment", "block_calendar_slot"],
  },
  {
    family: "message",
    regex: /\b(mensagem|msg|whatsapp|sms|email|mensagens|msgs)\s+(enviad[ao]|mandad[ao]|dispar[aá]d[ao]|agendad[ao]|cancelad[ao])s?\b|\b(mandei|enviei|disparei|despachei)\s+(a\s+|o\s+)?(mensagem|msg|whatsapp|sms|email|texto)\b/i,
    satisfying_tools: ["send_message_to_contact", "schedule_message_to_contact", "schedule_bulk_message", "cancel_scheduled_message", "pause_bulk_message", "resume_bulk_message", "cancel_bulk_message"],
  },
  {
    family: "contact",
    regex: /\b(contato|lead|cliente)\s+(criad[ao]|adicionad[ao]|atualizad[ao]|alterad[ao]|deletad[ao]|apagad[ao]|removid[ao]|mergead[ao]|cadastrad[ao])s?\b|\b(criei|adicionei|atualizei|alterei|deletei|apaguei)\s+(o\s+)?(contato|lead|cliente)\b/i,
    satisfying_tools: ["create_contact", "update_contact", "delete_contact"],
  },
  {
    // CRIAÇÃO de opportunity — só create satisfaz.
    family: "opportunity_create",
    regex: /\b(oportunidade|opp|opportunity|deal|neg[oó]cio|pipeline)\s+(criad[ao]|adicionad[ao])s?\b|\b(criei)\s+(a\s+|o\s+|uma\s+|um\s+)?(oportunidade|opp|deal|neg[oó]cio|pipeline)\b/i,
    satisfying_tools: ["create_opportunity"],
  },
  {
    // MOVER/ATUALIZAR opportunity — create NÃO satisfaz (caso Henry).
    family: "opportunity_update",
    regex: /\b(oportunidade|opp|opportunity|deal|neg[oó]cio|pipeline)\s+(atualizad[ao]|movid[ao]|fechad[ao]|trocad[ao]|atribu[ií]d[ao]|abandonad[ao]|perdid[ao]|ganh[ao])s?\b|\b(movi|fechei|atualizei|atribu[ií])\s+(a\s+|o\s+)?(oportunidade|opp|deal|neg[oó]cio|pipeline)\b|\b(movid[ao]|mov[ií])\s+(pra|para|pro)\s+(M[0-9]|stage|[A-Z][a-z]+)/i,
    satisfying_tools: ["update_opportunity", "update_opportunity_status", "move_opportunity"],
  },
];

// Verbos de write em 1ª pessoa pretérito — catch-all genérico.
const GENERIC_WRITE_VERB_REGEX =
  /\b(criei|criamos|agendei|agendamos|marquei|marcamos|salvei|salvamos|anotei|anotamos|registrei|registramos|removi|removemos|adicionei|adicionamos|mandei|mandamos|enviei|enviamos|disparei|disparamos|atualizei|atualizamos|atribu[ií]|atribu[ií]mos|deletei|deletamos|apaguei|apagamos|completei|completamos|fechei|fechamos|movi|movemos|troquei|trocamos|bloqueei|bloqueamos|cancelei|cancelamos|pausei|pausamos|configurei|configuramos|confirmei|confirmamos|inseri|inserimos|despachei|despachamos|cadastrei|cadastramos|importei|importamos|sincronizei|sincronizamos|reagendei|reagendamos|reatribu[ií]|reatribu[ií]mos)\b/i;

/**
 * Checa se o match está em contexto NEGATIVO ou PREVIEW (reduz falsos-positivos).
 * Copiado verbatim de processor.ts (fix H32.7 + H33.1) — 8 heurísticas.
 */
export function isNegatedOrPreviewContext(text: string, matchIndex: number): boolean {
  const lookBehind = text.slice(Math.max(0, matchIndex - 80), matchIndex).toLowerCase();
  if (lookBehind.length === 0) return false;
  if (/\b(n[aã]o|nenhum[ao]?|jamais|nunca)\s+(automaticamente\s+|ainda\s+|mais\s+|tem\s+|tenho\s+|temos\s+|h[aá]\s+|existe\s+|existem\s+|nenhum[ao]?\s+)?[\w\s,]{0,15}$/i.test(lookBehind)) return true;
  if (/\b(n[aã]o\s+(tem|tenho|temos|h[aá]|existe|existem|preciso|consegui|consigo|d[aá]|posso)|sem\s+nenhum[ao]?|nem\s+)[\w\s,]{0,60}$/i.test(lookBehind)) return true;
  if (/(mensagem|texto|template|preview)\s+(que\s+)?(vai|ser[aá]|vou)\s+[\w\s,]{0,30}$/i.test(lookBehind)) return true;
  if (/(disparo|mensagem|texto)\s+(que\s+(vou\s+)?(mandar|enviar|disparar|ser[aá]|vai))/i.test(lookBehind)) return true;
  if (/\b(que|os\s+que|disparos?\s+que|tarefas?\s+que|notas?\s+que|reuni[aã]o\s+que)\s+(j[aá]\s+)?$/i.test(lookBehind)) return true;
  if (/\b(atendimento\s+em\s+andamento|status|nota\s+mais\s+recente|resumo\s+das?\s+notas?|primeira\s+reuni[aã]o|segunda\s+reuni[aã]o|terceira\s+reuni[aã]o)[\w\s,—\-:.]{0,60}$/i.test(lookBehind)) return true;
  if (/\b(sugest[aã]o|sugiro|recomendo|pr[oó]ximo[s]?\s+passo|acompanhar|criar\s+task)[\w\s,—\-:.]{0,60}$/i.test(lookBehind)) return true;
  if (/(^|\n)\s*\*?\s*\d+\.\s*\*?[^\n]{0,40}\*?\s*\n[\w\s,—\-:.]{0,60}$/i.test(lookBehind)) return true;
  const lookBehindFull = text.slice(Math.max(0, matchIndex - 200), matchIndex);
  const lastQuote = Math.max(lookBehindFull.lastIndexOf('"'), lookBehindFull.lastIndexOf("'"), lookBehindFull.lastIndexOf("“"));
  if (lastQuote >= 0) {
    const afterQuote = lookBehindFull.slice(lastQuote + 1);
    if (!/["'”]/.test(afterQuote)) return true;
  }
  return false;
}

export interface CoherenceViolation {
  family: string;
  matched_text: string;
  detector: "specific" | "generic";
}

/**
 * Retrocompat: detector por NOME de tool (igual processor.ts antigo). Mantido
 * para o caminho de signal-only. Prefira analyzeCoherence() para o gate.
 */
export function detectHallucination(responseText: string, toolsCalled: string[]): CoherenceViolation[] {
  const found: CoherenceViolation[] = [];
  for (const pattern of CLAIM_PATTERNS) {
    const match = responseText.match(pattern.regex);
    if (!match || match.index === undefined) continue;
    if (isNegatedOrPreviewContext(responseText, match.index)) continue;
    if (!pattern.satisfying_tools.some((t) => toolsCalled.includes(t))) {
      found.push({ family: pattern.family, matched_text: match[0], detector: "specific" });
    }
  }
  const generic = responseText.match(GENERIC_WRITE_VERB_REGEX);
  if (generic && generic.index !== undefined && !isNegatedOrPreviewContext(responseText, generic.index)) {
    if (toolsCalled.filter(isWriteTool).length === 0) {
      if (!found.some((f) => f.matched_text === generic[0])) {
        found.push({ family: "generic_write", matched_text: generic[0], detector: "generic" });
      }
    }
  }
  return found;
}

export type CoherenceAction = "ok" | "rerun" | "rewrite";

export interface CoherenceResult {
  coherent: boolean;
  violations: CoherenceViolation[];
  /** true se alguma tool de WRITE rodou com sucesso neste turno → re-run NÃO é seguro (risco de duplicar). */
  hadSuccessfulWrite: boolean;
  /** Ação recomendada: 'ok' | 'rerun' (seguro) | 'rewrite' (não re-executar). */
  action: CoherenceAction;
  /** Diretiva corretiva para injetar num re-run seguro. */
  correctiveDirective: string;
  /** Reescrita honesta de fallback fixo (quando re-run não resolve ou falha). */
  safeRewrite: string;
  /** Diretiva para reescrita SEM tools (caso 'rewrite' — não re-executa nada). */
  rewriteDirective: string;
}

/**
 * Gate de coerência: cruza o texto afirmado com os tool_calls (nome + RESULTADO)
 * e decide o caminho SEGURO conforme D1 (re-run + reescrever), sem nunca arriscar
 * duplicar uma ação de cliente já executada com sucesso.
 */
/**
 * Fingerprint estável do fallback honesto (safeRewrite). O loop-breaker do
 * processor usa isto pra detectar "já mandei o fallback no turno anterior" sem
 * string mágica duplicada que pode driftar (review 2026-06-05).
 */
export const HONEST_FALLBACK_FINGERPRINT = "ainda não consegui concluir isso aqui";

export function analyzeCoherence(responseText: string, toolCalls: ToolCallRecord[]): CoherenceResult {
  const successfulToolNames = toolCalls.filter((tc) => toolSucceeded(tc.result)).map((tc) => tc.name);
  const hadSuccessfulWrite = toolCalls.some((tc) => isWriteTool(tc.name) && toolSucceeded(tc.result));

  const violations: CoherenceViolation[] = [];
  for (const pattern of CLAIM_PATTERNS) {
    const match = responseText.match(pattern.regex);
    if (!match || match.index === undefined) continue;
    if (isNegatedOrPreviewContext(responseText, match.index)) continue;
    // Satisfeita SÓ se a tool exata da família rodou COM SUCESSO.
    if (!pattern.satisfying_tools.some((t) => successfulToolNames.includes(t))) {
      violations.push({ family: pattern.family, matched_text: match[0], detector: "specific" });
    }
  }
  const generic = responseText.match(GENERIC_WRITE_VERB_REGEX);
  if (generic && generic.index !== undefined && !isNegatedOrPreviewContext(responseText, generic.index)) {
    // Genérico só dispara se NENHUMA write rodou com sucesso (afirmação sem lastro).
    if (toolCalls.filter((tc) => isWriteTool(tc.name) && toolSucceeded(tc.result)).length === 0) {
      if (!violations.some((v) => v.matched_text === generic[0])) {
        violations.push({ family: "generic_write", matched_text: generic[0], detector: "generic" });
      }
    }
  }

  const coherent = violations.length === 0;
  // Re-run SÓ é seguro quando não houve escrita bem-sucedida (nada a duplicar).
  const action: CoherenceAction = coherent ? "ok" : hadSuccessfulWrite ? "rewrite" : "rerun";

  const claims = violations.map((v) => `"${v.matched_text}"`).join(", ");
  const correctiveDirective =
    `[verificação interna do sistema — não exponha isto ao usuário] Você afirmou ${claims}, mas nenhuma ferramenta de escrita correspondente foi executada com sucesso neste turno. ` +
    `Se a ação ainda não foi feita, EXECUTE a ferramenta agora. Se você se enganou ou a ação não é possível, responda com a informação correta SEM afirmar que fez algo que não aconteceu.`;

  const safeRewrite =
    `Na real, ${HONEST_FALLBACK_FINGERPRINT} — não quero te dizer que fiz algo que não foi feito. Pode confirmar pra eu tentar de novo?`;

  const rewriteDirective =
    "[verificação interna do sistema — não exponha isto ao usuário] Reescreva sua última resposta com total honestidade. " +
    `Ferramentas realmente executadas com sucesso neste turno: ${successfulToolNames.join(", ") || "nenhuma"}. ` +
    `NÃO afirme que fez ${claims || "a ação"} — isso não foi concluído. Diga o que de fato aconteceu e, para o que não foi feito, ` +
    "fale com naturalidade que ainda não conseguiu (ou pergunte se quer que tente de novo). NÃO chame nenhuma ferramenta agora; apenas reescreva o texto.";

  return { coherent, violations, hadSuccessfulWrite, action, correctiveDirective, safeRewrite, rewriteDirective };
}
