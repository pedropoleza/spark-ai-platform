/**
 * Interpolação de NOME do contato nos textos dos passos de um fluxo de follow-up.
 *
 * Fix bug observado em prod 2026-06-29 (caso Jussara): o materializer copiava o
 * texto do passo VERBATIM → o lead recebia "Oi, [nome]?" com o placeholder CRU.
 * A tool add_step JÁ instrui o LLM a escrever "[nome]" pra personalizar (ver a
 * description do param message_text), mas a SUBSTITUIÇÃO nunca existiu — era
 * "Fora do MVP" no H41. Aqui ela passa a existir, no ponto de materialização
 * (1 sequência por contato) e como defesa no envio (followup-runner).
 *
 * Escopo cirúrgico: só troca tokens de NOME ([nome], {nome}, {first_name},
 * {primeiro_nome}, [name]...). NUNCA toca em {tags[0]}, {custom.slug},
 * {opportunity.stage_name} etc. de outros motores (bulk) — esses não batem o
 * padrão. Idempotente: texto já interpolado (sem placeholder) volta inalterado.
 */

// Tokens reconhecidos como "nome do contato" (case-insensitive, espaço/underscore tolerados).
const NAME_TOKENS = "nome|primeiro[\\s_]?nome|first[\\s_]?name|name";
// Placeholder isolado: [nome] ou {nome}.
const NAME_PLACEHOLDER = new RegExp(`\\[\\s*(?:${NAME_TOKENS})\\s*\\]|\\{\\s*(?:${NAME_TOKENS})\\s*\\}`, "gi");
// Placeholder + pontuação/espaço à esquerda — pra limpar "Oi, [nome]?" → "Oi?" quando não há nome.
const NAME_PLACEHOLDER_WITH_LEAD = new RegExp(
  `[,\\s]*(?:\\[\\s*(?:${NAME_TOKENS})\\s*\\]|\\{\\s*(?:${NAME_TOKENS})\\s*\\})`,
  "gi",
);

/** Primeiro nome a partir do nome completo do contato ("Matheus Albuquerque" → "Matheus"). */
export function firstNameOf(contactName: string | null | undefined): string {
  const full = (contactName || "").trim();
  if (!full) return "";
  return full.split(/\s+/)[0];
}

/**
 * Substitui os placeholders de nome pelo primeiro nome do contato. Sem nome
 * disponível, REMOVE o placeholder e limpa a pontuação órfã (nunca manda "[nome]"
 * cru pro lead). Texto sem placeholder volta inalterado (idempotente).
 */
export function interpolateContactName(
  text: string,
  contactName: string | null | undefined,
): string {
  if (!text) return text;
  const first = firstNameOf(contactName);
  if (first) {
    return text.replace(NAME_PLACEHOLDER, first);
  }
  // Sem nome: remove o placeholder (com a vírgula/espaço que o precede) e arruma
  // pontuação que ficou solta ("Oi,  ?" → "Oi?"). Se zerar o texto, mantém o original.
  const stripped = text
    .replace(NAME_PLACEHOLDER_WITH_LEAD, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([?!.,:;])/g, "$1")
    .trim();
  return stripped || text;
}

/** true se o texto ainda contém um placeholder de nome não-substituído (pra testes/guards). */
export function hasNamePlaceholder(text: string): boolean {
  NAME_PLACEHOLDER.lastIndex = 0;
  const has = NAME_PLACEHOLDER.test(text || "");
  NAME_PLACEHOLDER.lastIndex = 0;
  return has;
}
