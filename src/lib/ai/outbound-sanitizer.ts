/**
 * Sanitizador determinístico da saída lead-facing (caso Marina, 2026-07-01).
 *
 * A cliente (Marina) exige TOLERÂNCIA ZERO a citar o nome da seguradora
 * (National Life / Five Rings) ou "empresa com X anos de mercado" — implicaria
 * que a agência trabalha PARA a seguradora (risco de compliance). O ban no prompt
 * derrubou ~99% (71 msgs/pré-fix → 1/pós-fix em 290), mas o LLM ainda vaza ~0.3%.
 * A Marina pediu explicitamente uma "palavra proibida" — ou seja, garantia
 * determinística, não confiar no modelo. Este filtro roda no ÚLTIMO passo antes
 * de enviar (e de logar), redigindo cirurgicamente sem confiar no LLM.
 *
 * Config: `agent_configs.forbidden_terms` (string[]). Vazio/ausente = no-op
 * (paridade total pros outros agentes). Reusado no action-executor + follow-up.
 */

// Texto de reposição quando a mensagem inteira era só o conteúdo proibido —
// exatamente o que a Marina disse que basta: "profissão licenciada e regulamentada".
const SAFE_FALLBACK = "é uma profissão licenciada e regulamentada 🙂";

// Code-map por agente enquanto a coluna agent_configs.forbidden_terms não é
// aplicável daqui (sem conexão DDL; migration 00117 fica pra aplicar depois). O
// valor do DB tem PRECEDÊNCIA quando existir; senão cai neste mapa. Mesmo padrão
// do meeting-links.ts. Marina (áudio 2026-07-01): nunca citar a seguradora.
const FORBIDDEN_BY_AGENT: Record<string, string[]> = {
  "3976b4b6-0345-4f25-b964-138bb7960058": ["National Life Group", "National Life", "Five Rings Financial", "Five Rings"], // Marina Couto
};

/** Resolve os termos proibidos de um agente: config do DB > code-map > vazio. */
export function resolveForbiddenTerms(agentId?: string, configTerms?: string[] | null): string[] {
  if (configTerms && configTerms.length) return configTerms;
  return (agentId && FORBIDDEN_BY_AGENT[agentId]) || [];
}

function escapeRegex(t: string): string {
  return t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Redige uma única mensagem. Retorna null se sobrar vazio (o chamador decide). */
function sanitizeOne(msg: string, terms: string[]): { out: string | null; hits: string[] } {
  let s = msg;
  const hits: string[] = [];

  // Termos mais longos primeiro (evita deixar "Group" órfão ao remover "National Life").
  const ordered = [...terms].filter((t) => t.trim()).sort((a, b) => b.length - a.length);
  for (const t of ordered) {
    const te = escapeRegex(t.trim());
    const before = s;
    // "trabalhando/em parceria/associado com a <empresa>" — remove a cláusula inteira
    s = s.replace(new RegExp(`,?\\s*(trabalhando|em parceria|parceir[ao]|associad[ao]|represent(a|ando| o|amos))\\s+(com\\s+a?\\s*|a\\s+)?${te}`, "gi"), "");
    // "com a/da/na <empresa>" — remove o conector + nome
    s = s.replace(new RegExp(`\\b(com\\s+a|com|d[ao]s?|na|no)\\s+${te}\\b`, "gi"), "");
    // catch-all: qualquer ocorrência nua vira genérico sem nome
    s = s.replace(new RegExp(`\\b${te}\\b`, "gi"), "uma seguradora parceira");
    if (s !== before) hits.push(t.trim());
  }

  // Claims de longevidade centenária ("empresa com mais de 100 anos de mercado", "desde 1848")
  const b2 = s;
  s = s.replace(/,?\s*empresa\s+(com\s+)?(mais de\s+)?\d+\s+anos( de mercado)?( nos eua)?/gi, "");
  s = s.replace(/,?\s*(com\s+)?(mais de\s+)?\d+\s+anos de mercado( nos eua)?/gi, "");
  s = s.replace(/\bdesde\s+18\d\d\b/gi, "");
  if (s !== b2) hits.push("centenária/anos-de-mercado");

  if (!hits.length) return { out: msg, hits };

  // Limpeza de pontuação/espaços órfãos deixados pela remoção
  s = s
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .replace(/,\s*,/g, ",")
    .replace(/,\s*\./g, ".")
    .replace(/\(\s*\)/g, "")
    .replace(/^[\s,;:.-]+|[\s,]+$/g, "")
    .trim();

  // Sobrou vazio ou quase nada (só emoji/pontuação) → o chamador usa o fallback
  const meaningful = s.replace(/[\s\p{Emoji}\p{P}]/gu, "");
  return { out: meaningful.length < 3 ? null : s, hits };
}

export interface SanitizeResult {
  messages: string[];
  redacted: boolean;
  hits: string[]; // termos/regras que dispararam (pra log/audit)
}

/**
 * Sanitiza um array de bolhas. Bolhas que ficam vazias são descartadas; se TODAS
 * ficarem vazias, devolve 1 bolha com o fallback seguro.
 */
export function sanitizeOutbound(messages: string[], forbiddenTerms?: string[] | null): SanitizeResult {
  const terms = (forbiddenTerms || []).filter((t) => typeof t === "string" && t.trim());
  if (!terms.length) return { messages, redacted: false, hits: [] };

  const outBubbles: string[] = [];
  const allHits = new Set<string>();
  let anyRedaction = false;

  for (const m of messages) {
    const { out, hits } = sanitizeOne(m, terms);
    if (hits.length) { anyRedaction = true; hits.forEach((h) => allHits.add(h)); }
    if (out !== null) outBubbles.push(out);
  }

  if (outBubbles.length === 0) outBubbles.push(SAFE_FALLBACK);
  return { messages: outBubbles, redacted: anyRedaction, hits: [...allHits] };
}
