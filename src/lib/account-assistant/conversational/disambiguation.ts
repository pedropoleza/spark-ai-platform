/**
 * Disambiguation by Elimination (H30.2, Pedro 2026-05-15).
 *
 * Quando bot encontra múltiplos candidatos (3 Joãos, 4 stages "M"),
 * ranqueia por probabilidade + auto-escolhe se score TOP > 0.7 E gap
 * vs 2º > 0.2. Senão, mostra top 3 com contexto.
 *
 * Reduz "Qual João?" em ~70% dos casos sem sacrificar safety.
 */

export interface RankableCandidate {
  id: string;
  name?: string;
  /** Tags ou labels (pra ranking) */
  tags?: string[];
  /** Última atividade — ISO. Mais recente = score maior */
  last_activity?: string | null;
  /** Mencionado em turn anterior (lookup via TurnContext) */
  mentioned_in_turn?: boolean;
  /** Extra hint (ex: phone match, email match) */
  exact_field_match?: boolean;
}

export interface RankedCandidate<T extends RankableCandidate> {
  candidate: T;
  score: number;
  reasons: string[];
}

/**
 * Score 0-1. Pesos:
 *   - exact_field_match (phone/email exato): +0.5
 *   - mentioned_in_turn (turn-context): +0.3
 *   - last_activity recente (<7d): +0.2 (<30d: +0.1)
 *   - tag "cliente"/"active"/"lead" recente: +0.1
 *   - sem dados: 0 baseline
 */
export function rankCandidates<T extends RankableCandidate>(
  candidates: T[],
): RankedCandidate<T>[] {
  const now = Date.now();
  return candidates
    .map((c) => {
      let score = 0;
      const reasons: string[] = [];

      if (c.exact_field_match) {
        score += 0.5;
        reasons.push("match exato");
      }
      if (c.mentioned_in_turn) {
        score += 0.3;
        reasons.push("mencionado no turn");
      }
      if (c.last_activity) {
        const daysAgo = (now - new Date(c.last_activity).getTime()) / (1000 * 60 * 60 * 24);
        if (daysAgo < 7) {
          score += 0.2;
          reasons.push(`conv ${Math.floor(daysAgo)}d`);
        } else if (daysAgo < 30) {
          score += 0.1;
          reasons.push(`conv ${Math.floor(daysAgo)}d`);
        }
      }
      if (c.tags?.some((t) => /cliente|client|active|lead/i.test(t))) {
        score += 0.1;
        reasons.push("tag relevante");
      }

      return { candidate: c, score, reasons };
    })
    .sort((a, b) => b.score - a.score);
}

export interface DisambiguationResult<T extends RankableCandidate> {
  /** Pode auto-escolher? (top score > 0.7 E gap > 0.2) */
  can_auto_pick: boolean;
  top: RankedCandidate<T>;
  /** Top 3 pra mostrar se ambíguo */
  top_3: RankedCandidate<T>[];
}

/**
 * Avalia se dá pra auto-pick OU precisa mostrar opções.
 */
export function disambiguate<T extends RankableCandidate>(
  candidates: T[],
): DisambiguationResult<T> | null {
  if (candidates.length === 0) return null;
  if (candidates.length === 1) {
    const single = { candidate: candidates[0], score: 1, reasons: ["único candidato"] };
    return { can_auto_pick: true, top: single, top_3: [single] };
  }

  const ranked = rankCandidates(candidates);
  const top = ranked[0];
  const second = ranked[1];
  const gap = top.score - (second?.score || 0);

  return {
    can_auto_pick: top.score > 0.7 && gap > 0.2,
    top,
    top_3: ranked.slice(0, 3),
  };
}

/**
 * Renderiza opções pro bot apresentar quando ambíguo.
 */
export function renderDisambiguationOptions<T extends RankableCandidate>(
  result: DisambiguationResult<T>,
  formatLabel: (c: T) => string,
): string {
  if (result.can_auto_pick) {
    const reasons = result.top.reasons.join(", ");
    return `Achei *${formatLabel(result.top.candidate)}* (${reasons || "único match"}). Confirma?`;
  }
  const lines = [
    `Tem ${result.top_3.length} candidatos. Qual:`,
    "",
    ...result.top_3.map((r, i) => {
      const reasons = r.reasons.join(", ");
      return `*${i + 1}.* ${formatLabel(r.candidate)}${reasons ? ` — ${reasons}` : ""}`;
    }),
  ];
  return lines.join("\n");
}
