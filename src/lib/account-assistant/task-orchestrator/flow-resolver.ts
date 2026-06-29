/**
 * Resolver da Biblioteca de Fluxos Salvos (Pedro 2026-06-29).
 * Estudo: _planning/jussara-sparkbot/ESTUDO-fluxos-salvos.md
 *
 * Acha um fluxo salvo do rep por NOME, tolerante a typo/acento/ordem de tokens.
 * REUSA o scorer fuzzy do H45 (contact-resolver/normalize.ts `nameScore`) — zero
 * lógica nova de scoring — e devolve uma `confidence` no mesmo espírito do
 * search_contacts (o bot decide: aplica / confirma / lista / não-achei).
 *
 * Anti-alucinação: mesmo no `high`, o prompt manda CONFIRMAR o nome antes de
 * disparar (nunca aplica por id cego). `ambiguous` → lista; `low` → não achei.
 */
import { nameScore } from "../contact-resolver/normalize";
import { listSavedFlows, type SavedFlowRow } from "@/lib/repositories/task-drafts.repo";

export type FlowConfidence = "high" | "needs_confirm" | "ambiguous" | "low";

export interface FlowCandidate {
  draft_id: string;
  title: string;
  step_count: number;
  score: number;
}

export interface FlowResolveResult {
  best: FlowCandidate | null;
  candidates: FlowCandidate[];
  confidence: FlowConfidence;
}

/** Piso de plausibilidade (espelha o 0.34 do contact-resolver). */
const FLOOR = 0.34;

/**
 * PURA (testável sem DB): ranqueia os fluxos salvos contra a query e classifica a
 * confiança. `flows` = títulos + contagem de passos da biblioteca do rep.
 */
export function rankSavedFlows(query: string, flows: SavedFlowRow[]): FlowResolveResult {
  const q = (query || "").trim();
  const scored: FlowCandidate[] = flows
    .map((f) => ({
      draft_id: f.draft_id,
      title: f.title ?? "",
      step_count: f.step_count,
      score: Number(nameScore(q, f.title ?? "").toFixed(3)),
    }))
    .filter((s) => s.score >= FLOOR)
    .sort((a, b) => b.score - a.score);

  const best = scored[0] ?? null;
  let confidence: FlowConfidence = "low";
  if (best) {
    const second = scored[1]?.score ?? 0;
    // gap só é dominância quando há 2º colocado; com 1 só, gap máximo.
    const gap = scored.length >= 2 ? best.score - second : 1;
    const ambiguous = scored.length >= 2 && second >= 0.45 && best.score - second < 0.15;
    if (ambiguous) confidence = "ambiguous";
    else if (best.score >= 0.55 && gap >= 0.18) confidence = "high";
    else if (best.score >= 0.45) confidence = "needs_confirm";
    else confidence = "low";
  }
  return { best, candidates: scored.slice(0, 5), confidence };
}

/** Carrega a biblioteca salva do rep e resolve por nome. */
export async function resolveFlow(repId: string, query: string): Promise<FlowResolveResult> {
  const flows = await listSavedFlows(repId);
  return rankSavedFlows(query, flows);
}
