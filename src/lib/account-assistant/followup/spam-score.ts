/**
 * Spam score / conversation health (Pedro 2026-05-18).
 *
 * Híbrido: regras determinísticas → LLM Haiku refinamento se score 40-70.
 *
 * Returns: SpamScoreResult com risk + recomendação + flags humanos.
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ContextSignals } from "./context-resolver";
import type { SpamScoreResult, SpamRisk } from "./types";

const HAIKU_MODEL = "claude-haiku-4-5-20250929";

interface RuleInput {
  signals: ContextSignals;
  contact_tags: string[];
  is_active_client: boolean;
  has_recent_appointment: boolean;
  existing_active_sequences: number;
  planned_sequence_length: number;
}

/**
 * Camada 1: regras determinísticas.
 * Score começa em 100, penaliza por sinais ruins, bonifica por sinais bons.
 */
function computeBaseScore(input: RuleInput): { score: number; flags: string[] } {
  const { signals, contact_tags, is_active_client, has_recent_appointment, existing_active_sequences } = input;
  const flags: string[] = [];
  let score = 100;

  // Opt-out tag → zera
  if (contact_tags.some((t) => /^(dnc|do_not_contact|opt[_-]?out|stop|unsubscribed|n[ãa]o[_ ]?enviar)$/i.test(t.trim()))) {
    flags.push("contato tem tag de opt-out");
    return { score: 0, flags };
  }

  // Penalty: msgs sem resposta
  if (signals.unanswered_outbound_count > 0) {
    const penalty = signals.unanswered_outbound_count * 12;
    score -= penalty;
    flags.push(`${signals.unanswered_outbound_count} msg(s) sem resposta`);
  }

  // Penalty: dias desde última inbound
  if (signals.days_since_last_inbound !== null) {
    const days = Math.min(signals.days_since_last_inbound, 30);
    score -= days * 1.5;
    if (signals.days_since_last_inbound >= 7) {
      flags.push(`última resposta há ${signals.days_since_last_inbound}d`);
    }
  } else if (signals.message_count > 0) {
    // Tem mensagens mas nunca houve inbound — contato nunca respondeu
    score -= 25;
    flags.push("contato nunca respondeu");
  }

  // Penalty: sequência ativa já existe
  if (existing_active_sequences > 0) {
    score -= existing_active_sequences * 20;
    flags.push(`${existing_active_sequences} sequence(s) já ativa(s)`);
  }

  // Bonus: ratio saudável
  if (signals.inbound_outbound_ratio >= 0.5) {
    score += 15;
    flags.push("conversa balanceada");
  }

  // Bonus: cliente ativo
  if (is_active_client) {
    score += 15;
    flags.push("cliente ativo");
  }

  // Bonus: appointment recente
  if (has_recent_appointment) {
    score += 10;
    flags.push("appointment recente");
  }

  // Penalty: sequence longa demais quando histórico já pesado
  if (input.planned_sequence_length >= 3 && signals.unanswered_outbound_count >= 1) {
    score -= 10;
    flags.push("sequência longa com histórico pesado");
  }

  return { score: Math.max(0, Math.min(100, Math.round(score))), flags };
}

function thresholdRisk(score: number): SpamRisk {
  if (score >= 70) return "low";
  if (score >= 40) return "medium";
  return "high";
}

function recommendation(risk: SpamRisk): "auto_schedule" | "request_approval" | "internal_reminder_only" {
  if (risk === "low") return "auto_schedule";
  if (risk === "medium") return "request_approval";
  return "internal_reminder_only";
}

function maxSuggestedMessages(risk: SpamRisk): number {
  if (risk === "low") return 3;
  if (risk === "medium") return 2;
  return 1;
}

/**
 * Camada 2: LLM refinamento (só pra medium / amibíguo).
 * Lê últimas 5 msgs + score base e retorna adjusted_score + rationale.
 */
async function refineWithLLM(
  signals: ContextSignals,
  baseScore: number,
): Promise<{ adjusted_score: number; rationale: string } | null> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const recent = signals.messages.slice(-5);
  if (recent.length === 0) return null;

  const transcript = recent
    .map((m) => `[${m.direction.toUpperCase()}] ${m.body.slice(0, 200)}`)
    .join("\n");

  const prompt = `Você é um analisador de saúde de conversas comerciais.

Score base (regras determinísticas): ${baseScore}/100

Últimas mensagens:
${transcript}

Considere:
- O contato está engajado ou frio?
- Pediu mais tempo (legítimo) ou demonstrou desinteresse?
- Tom da última resposta dele?

Retorne JSON com 2 campos:
{ "adjusted_score": <0-100>, "rationale": "<até 80 caracteres explicando>" }

APENAS o JSON, sem markdown ou texto extra.`;

  try {
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 150,
      messages: [{ role: "user", content: prompt }],
    });
    const text = resp.content
      .map((c) => (c.type === "text" ? c.text : ""))
      .join("")
      .trim();
    const parsed = JSON.parse(text) as { adjusted_score?: number; rationale?: string };
    if (typeof parsed.adjusted_score === "number") {
      return {
        adjusted_score: Math.max(0, Math.min(100, Math.round(parsed.adjusted_score))),
        rationale: parsed.rationale?.slice(0, 150) || "",
      };
    }
  } catch (err) {
    console.warn(
      "[followup-spam-score] LLM refine falhou:",
      err instanceof Error ? err.message.slice(0, 150) : err,
    );
  }
  return null;
}

/**
 * Calcula spam score final (regras + LLM ambíguo).
 */
export async function computeSpamScore(input: RuleInput): Promise<SpamScoreResult> {
  const { score: baseScore, flags } = computeBaseScore(input);
  const baseRisk = thresholdRisk(baseScore);

  // Só refina com LLM se medium (zona cinza)
  let finalScore = baseScore;
  let rationale: string | undefined;
  let usedLLM = false;

  if (baseRisk === "medium" && input.signals.has_conversation) {
    const refined = await refineWithLLM(input.signals, baseScore);
    if (refined) {
      finalScore = refined.adjusted_score;
      rationale = refined.rationale;
      usedLLM = true;
    }
  }

  const risk = thresholdRisk(finalScore);
  return {
    score: finalScore,
    risk,
    flags,
    recommendation: recommendation(risk),
    max_suggested_messages: maxSuggestedMessages(risk),
    rationale,
    used_llm_refinement: usedLLM,
  };
}
