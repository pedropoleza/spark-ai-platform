/**
 * Closed-opp gate — "negócio fechado → IA para sozinha" (MC-8, review Marcia
 * 2026-07-28).
 *
 * Por que existe: o único gate de opp-fechada morava no should-respond e SÓ
 * rodava com handoff_policy.enabled=true (false na frota inteira) — e, mesmo
 * ligado, era cego pra contas que marcam fechamento por ESTÁGIO de pipeline
 * (a Five Star Ricos tem 3.119 opps status='open' e ZERO won/lost — "fechou"
 * = card em "Deal Closed"/"Active Client"). Resultado: cliente com apólice
 * emitida continuava parecendo lead vivo e a IA seguia prospectando.
 *
 * Este gate é STANDALONE (não depende do handoff), roda pré-LLM no turno E no
 * runner de follow-up (o caminho de maior risco real: deal fecha por telefone,
 * nenhum inbound novo chega, e os toques pendentes disparariam num cliente).
 *
 * Regra anti-falso-positivo (ANY-closed era bug latente): só skipa quando há
 * ≥1 opp TERMINAL e NENHUMA opp ativa — lead com opp lost antiga + opp open
 * nova (re-engajou) continua sendo atendido.
 *
 * Terminal = status won/lost/abandoned (universal) OU stage/pipeline listado na
 * config do agente (agent_configs.closed_opp_gate — necessário em contas que
 * fecham por estágio). Config ausente = só status (comportamento universal
 * seguro). Fail-open obrigatório: erro de fetch → responde normal.
 *
 * Rollout: env CLOSED_OPP_GATE_LOG_ONLY=1 → audita would_skip sem silenciar
 * (48h de validação antes de morder).
 */

export interface ClosedOppGateConfig {
  /** false = opt-out explícito do gate neste agente (default: ligado). */
  enabled?: boolean;
  /** Stages que significam "fechado" nesta conta (IDs do Spark Leads). */
  terminal_stage_ids?: string[];
  /** Pipelines inteiras terminais (ex: "2- Policies"). */
  terminal_pipeline_ids?: string[];
}

export interface OppForGate {
  id?: string;
  status?: string;
  pipelineId?: string;
  pipelineStageId?: string;
}

const TERMINAL_STATUSES = new Set(["won", "lost", "abandoned"]);

export function normalizeClosedOppGate(raw: unknown): Required<ClosedOppGateConfig> {
  const cfg = (raw && typeof raw === "object" ? raw : {}) as ClosedOppGateConfig;
  return {
    enabled: cfg.enabled !== false,
    terminal_stage_ids: Array.isArray(cfg.terminal_stage_ids)
      ? cfg.terminal_stage_ids.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [],
    terminal_pipeline_ids: Array.isArray(cfg.terminal_pipeline_ids)
      ? cfg.terminal_pipeline_ids.filter((s): s is string => typeof s === "string" && s.length > 0)
      : [],
  };
}

export function isTerminalOpp(opp: OppForGate, gate: Required<ClosedOppGateConfig>): boolean {
  const status = (opp.status || "").toLowerCase();
  if (TERMINAL_STATUSES.has(status)) return true;
  if (opp.pipelineStageId && gate.terminal_stage_ids.includes(opp.pipelineStageId)) return true;
  if (opp.pipelineId && gate.terminal_pipeline_ids.includes(opp.pipelineId)) return true;
  return false;
}

export function evaluateClosedOppGate(
  opps: OppForGate[] | null | undefined,
  rawConfig: unknown,
): { skip: boolean; reason: string | null; terminal_count: number; active_count: number } {
  const gate = normalizeClosedOppGate(rawConfig);
  if (!gate.enabled) return { skip: false, reason: "gate_disabled", terminal_count: 0, active_count: 0 };
  const list = Array.isArray(opps) ? opps : [];
  if (list.length === 0) return { skip: false, reason: "no_opps", terminal_count: 0, active_count: 0 };
  let terminal = 0;
  let active = 0;
  for (const opp of list) {
    if (isTerminalOpp(opp, gate)) terminal++;
    else active++;
  }
  // Skip SSE: ≥1 terminal E 0 ativas. Opp ativa nova sempre vence (re-engajou).
  if (terminal > 0 && active === 0) {
    return { skip: true, reason: "all_opps_terminal", terminal_count: terminal, active_count: active };
  }
  return { skip: false, reason: active > 0 ? "has_active_opp" : null, terminal_count: terminal, active_count: active };
}

export function isClosedOppGateLogOnly(): boolean {
  return process.env.CLOSED_OPP_GATE_LOG_ONLY === "1";
}
