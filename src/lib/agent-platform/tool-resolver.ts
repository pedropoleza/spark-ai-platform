/**
 * Tool Resolver — a outra metade do motor unificado (Plataforma Modular, Fase 1).
 *
 * As tools que um agente expõe ao LLM = UNIÃO das `allowed_tools` dos módulos
 * que ele liga (menos os disabled). É o equivalente, no eixo de tools, do que o
 * assembler faz no eixo de prompt.
 *
 * ESTADO (Fase 1): função PURA + testada, AINDA NÃO ligada no processor. O
 * SparkBot continua usando o registry completo de tools de hoje (delega — sem
 * mudança de comportamento). Quem CONSOME isto são os agentes lead-facing
 * (venda/recrut/custom) na Fase 2, que compõem só os módulos deles → só as tools
 * deles. Por isso é pura e sem efeitos colaterais: dá pra montar/testar a regra
 * antes de plugar no runtime (supervisionado).
 *
 * Plano: _planning/plataforma-modular/PLANO.md.
 */

export interface ResolveToolsInput {
  /** Módulos ligados do agente, cada um com suas tools liberadas. */
  moduleInstances: Array<{ moduleKey: string; enabled: boolean; allowedTools: string[] }>;
  /** Tools desligadas explicitamente pro agente (ex: admin tirou). */
  disabledTools?: string[];
  /**
   * Tools sempre disponíveis independente de módulo (ex: básicos de conversa).
   * Default vazio. Útil pra um "core" que todo agente tem.
   */
  baseTools?: string[];
}

/**
 * Calcula o conjunto (ordenado, deduplicado) de tool keys de um agente a partir
 * dos módulos ligados. Determinístico e puro.
 */
export function resolveModuleToolKeys(input: ResolveToolsInput): string[] {
  const disabled = new Set(input.disabledTools || []);
  const set = new Set<string>();

  for (const t of input.baseTools || []) {
    if (!disabled.has(t)) set.add(t);
  }
  for (const m of input.moduleInstances) {
    if (!m.enabled) continue;
    for (const t of m.allowedTools) {
      if (!disabled.has(t)) set.add(t);
    }
  }
  return [...set].sort();
}
