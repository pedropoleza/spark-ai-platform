/**
 * Primitivas de normalização e similaridade pra resolução de contato (H45, 2026-06-26).
 * Determinístico, sem deps. Usado pelo resolver (F5/F6), pelo filter-engine (F9) e pelo
 * "contato em foco" (F3). Foco: tolerar acento, typo, nome completo×primeiro, ordem de tokens.
 */

/** F9: strip-diacritics (NFD) + lowercase + trim. "Bárbara"→"barbara", "João"→"joao". */
export function deburr(s: unknown): string {
  const v = typeof s === "string" ? s : String(s ?? "");
  return v.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase().trim();
}

/** Tokens de nome (deburr + split por não-letra/dígito), descartando vazios e ruído curto. */
export function nameTokens(s: unknown): string[] {
  return deburr(s)
    .split(/[^a-z0-9]+/u)
    .filter((t) => t.length >= 2);
}

/** Bigramas de caracteres pra Dice coefficient. */
function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

/**
 * Dice coefficient sobre bigramas (0..1). Robusto a typo de 1-2 chars:
 * dice("fernanda","fernanada") ≈ 0.86. Igualdade exata = 1.
 */
export function dice(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const A = bigrams(a);
  const Bm = new Map<string, number>();
  for (const g of bigrams(b)) Bm.set(g, (Bm.get(g) || 0) + 1);
  let inter = 0;
  for (const g of A) {
    const c = Bm.get(g);
    if (c) { inter++; Bm.set(g, c - 1); }
  }
  return (2 * inter) / (A.length + bigrams(b).length);
}

/**
 * Score de nome 0..1: pra cada token da QUERY, pega o melhor token do CANDIDATO (Dice) e
 * faz a média (recall sobre os tokens pedidos). Tolera ordem trocada (token-set) e typo.
 * Ex: "Fernanda Lira" vs "fernanada lira" → (0.86 + 1.0)/2 ≈ 0.93.
 * Penalidade leve se o candidato tem MUITO mais tokens que a query (anti "silvana amiga da fernanda").
 */
export function nameScore(query: string, candidate: string): number {
  const qt = nameTokens(query);
  const ct = nameTokens(candidate);
  if (!qt.length || !ct.length) return 0;
  let sum = 0;
  for (const q of qt) {
    let best = 0;
    for (const c of ct) best = Math.max(best, dice(q, c));
    sum += best;
  }
  const recall = sum / qt.length;
  // Penalidade de "diluição": candidato com muitos tokens extras é menos provável.
  const extra = Math.max(0, ct.length - qt.length);
  const dilution = 1 - Math.min(0.15, extra * 0.05); // no máx -0.15
  return recall * dilution;
}

/** Só dígitos. */
export function phoneDigits(s: unknown): string {
  return String(s ?? "").replace(/\D/g, "");
}

/**
 * Match de telefone por SUFIXO dos últimos N dígitos (default 8) — robusto a formato/DDI.
 * Ex: "+1 732 978 2721" vs "7329782721" vs "(732) 978-2721" → todos batem.
 * Score: 1.0 se sufixo de 10 bate, 0.9 se 8, 0 se < 7 dígitos comuns.
 */
export function phoneSuffixScore(a: unknown, b: unknown): number {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (da.length < 7 || db.length < 7) return 0;
  const n = Math.min(da.length, db.length, 10);
  for (let len = n; len >= 7; len--) {
    if (da.slice(-len) === db.slice(-len)) return len >= 10 ? 1 : len >= 8 ? 0.9 : 0.8;
  }
  return 0;
}

/** Heurística: a entrada parece um telefone? (maioria dígitos, ≥7). */
export function looksLikePhone(s: string): boolean {
  const digits = phoneDigits(s);
  return digits.length >= 7 && digits.length / Math.max(1, s.replace(/\s/g, "").length) >= 0.6;
}
