/**
 * Kernel PURO de operadores de texto (Pedro 2026-06-17).
 *
 * Fonte ÚNICA dos operadores usados no targeting de ativação POR MENSAGEM
 * (src/lib/queue/targeting.ts). O executor.ts (evalConditionClient ~L534) hoje
 * duplica essa lógica inline pros filtros de CRM — migrar pra cá num follow-up
 * (com parity test do FEL, porque o `in` do FEL é igualdade-em-conjunto e aqui
 * é contains-any; semânticas diferentes de propósito).
 *
 * Default: case-INSENSITIVE + trim nos dois lados — espelha exatamente o
 * lower+trim que o targeting já faz pra tag/custom_field. `caseSensitive:true`
 * inverte. NUNCA lança (regex inválida do rep = no-match, não derruba o gate).
 */

export type TextOp =
  | "contains"
  | "not_contains"
  | "eq"
  | "starts_with"
  | "ends_with"
  | "in" // contains-any: bate se o texto CONTÉM qualquer um dos valores
  | "matches_regex";

/** Anti-abuso/ReDoS: o pattern é do rep (não do lead), risco baixo, mas limita. */
const MAX_REGEX_LEN = 200;

function norm(s: unknown, caseSensitive: boolean): string {
  const v = typeof s === "string" ? s : String(s ?? "");
  const trimmed = v.trim();
  return caseSensitive ? trimmed : trimmed.toLowerCase();
}

/**
 * Avalia um operador de texto contra `text` (a mensagem). `value` é string
 * (operadores single) OU string[] (pro "in" contains-any). Retorna boolean.
 */
export function matchTextOp(
  op: TextOp | undefined,
  text: string,
  value: string | string[] | undefined,
  opts?: { caseSensitive?: boolean },
): boolean {
  if (!op) return false;
  const cs = opts?.caseSensitive === true;
  const t = norm(text, cs);

  // "in" = qualquer-de-uma-lista, semântica contains-any (o que o rep espera de
  // "qualquer palavra da lista"). Difere do `in` do FEL (igualdade-em-conjunto).
  if (op === "in") {
    const list = Array.isArray(value) ? value : value != null ? [value] : [];
    return list.some((v) => {
      const needle = norm(v, cs);
      return needle !== "" && t.includes(needle);
    });
  }

  if (op === "matches_regex") {
    const pattern = Array.isArray(value) ? value[0] ?? "" : value ?? "";
    if (!pattern || pattern.length > MAX_REGEX_LEN) return false;
    try {
      return new RegExp(pattern, cs ? "" : "i").test(text);
    } catch {
      return false; // regex inválida = no-match, nunca lança
    }
  }

  const raw = Array.isArray(value) ? value[0] ?? "" : value ?? "";
  const needle = norm(raw, cs);
  switch (op) {
    case "contains":
      return t.includes(needle);
    case "not_contains":
      return !t.includes(needle);
    case "eq":
      return t === needle;
    case "starts_with":
      return t.startsWith(needle);
    case "ends_with":
      return t.endsWith(needle);
    default:
      return false;
  }
}
