/**
 * Turn Context Layer — memória de entidades dentro do turn (H29.2).
 *
 * Pedro 2026-05-15: bot perguntava "qual contato?" depois de ter
 * achado o contato na tool call anterior do MESMO turn. Esse módulo
 * registra entidades resolvidas conforme tools executam e expõe pro
 * LLM como contexto fresco.
 *
 * Fluxo:
 *   1. Processor cria TurnContextState no início do turn
 *   2. Cada tool handler pode ler/escrever via helpers
 *   3. Após cada tool_result, processor atualiza contexto
 *   4. Próxima iteração LLM vê contexto refrescado no system prompt
 *
 * Slots cobertos: contact, opportunity, stage, appointment, job, task,
 * note, calendar. Cada slot guarda apenas o MAIS RECENTE.
 */

export interface ResolvedEntity {
  id: string;
  label?: string;     // human readable (nome do contato, label do segment, etc)
  via_tool: string;   // qual tool resolveu
  resolved_at: string; // ISO
}

export interface TurnContextState {
  /** Entidades resolvidas neste turn — chave por tipo */
  resolved: {
    contact?: ResolvedEntity;
    opportunity?: ResolvedEntity;
    stage?: ResolvedEntity;
    appointment?: ResolvedEntity;
    job?: ResolvedEntity;
    task?: ResolvedEntity;
    note?: ResolvedEntity;
    calendar?: ResolvedEntity;
  };
  /** Última busca executada — pra "esse [tipo]" referência */
  last_search?: {
    tool: string;
    entity_type: string;
    count_returned: number;
    top_result_id?: string;
    top_result_label?: string;
    timestamp: string;
  };
  /** Último write executado — pra "desfaz" (futuro) e recap */
  last_write?: {
    tool: string;
    entity_type: string;
    entity_id: string;
    label?: string;
    timestamp: string;
  };
}

/**
 * Cria estado vazio no início do turn.
 */
export function createTurnContext(): TurnContextState {
  return {
    resolved: {},
  };
}

/**
 * Registra uma entidade resolvida (ex: search_contacts retornou 1 → registra).
 */
export function registerEntity(
  state: TurnContextState,
  type: keyof TurnContextState["resolved"],
  entity: { id: string; label?: string; via_tool: string },
): void {
  state.resolved[type] = {
    id: entity.id,
    label: entity.label,
    via_tool: entity.via_tool,
    resolved_at: new Date().toISOString(),
  };
}

/**
 * Registra última busca (independente de quantos resultados).
 */
export function registerSearch(
  state: TurnContextState,
  search: {
    tool: string;
    entity_type: string;
    count_returned: number;
    top_result_id?: string;
    top_result_label?: string;
  },
): void {
  state.last_search = {
    ...search,
    timestamp: new Date().toISOString(),
  };
  // Se single result, também marca como entity resolvida
  if (search.count_returned === 1 && search.top_result_id) {
    const type = search.entity_type as keyof TurnContextState["resolved"];
    if (type in state.resolved) {
      registerEntity(state, type, {
        id: search.top_result_id,
        label: search.top_result_label,
        via_tool: search.tool,
      });
    }
  }
}

/**
 * Registra último write (após tool com status=ok).
 */
export function registerWrite(
  state: TurnContextState,
  write: {
    tool: string;
    entity_type: string;
    entity_id: string;
    label?: string;
  },
): void {
  state.last_write = {
    ...write,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Auto-registra entidades a partir de um tool_result genérico.
 * Heurístico: inspeciona o data retornado por tool conhecida e infere.
 * Chamado pelo processor APÓS cada tool execution.
 */
export function autoRegisterFromToolResult(
  state: TurnContextState,
  toolName: string,
  resultData: unknown,
): void {
  if (!resultData || typeof resultData !== "object") return;
  const data = resultData as Record<string, unknown>;

  // === SEARCH-LIKE tools ===
  if (
    toolName === "search_contacts" ||
    toolName === "get_contacts_filtered"
  ) {
    const contacts = data.contacts as Array<{ id: string; name?: string }> | undefined;
    if (Array.isArray(contacts) && contacts.length > 0) {
      registerSearch(state, {
        tool: toolName,
        entity_type: "contact",
        count_returned: contacts.length,
        top_result_id: contacts[0].id,
        top_result_label: contacts[0].name,
      });
    }
    return;
  }
  if (toolName === "get_contact") {
    if (data.id && typeof data.id === "string") {
      registerEntity(state, "contact", {
        id: data.id,
        label: typeof data.name === "string" ? data.name : undefined,
        via_tool: toolName,
      });
    }
    return;
  }
  if (
    toolName === "list_opportunities" ||
    toolName === "get_opportunities_filtered"
  ) {
    const opps = data.opportunities as Array<{ id: string; name?: string }> | undefined;
    if (Array.isArray(opps) && opps.length > 0) {
      registerSearch(state, {
        tool: toolName,
        entity_type: "opportunity",
        count_returned: opps.length,
        top_result_id: opps[0].id,
        top_result_label: opps[0].name,
      });
    }
    return;
  }
  if (toolName === "get_opportunity") {
    if (data.id && typeof data.id === "string") {
      registerEntity(state, "opportunity", {
        id: data.id,
        label: typeof data.name === "string" ? data.name : undefined,
        via_tool: toolName,
      });
    }
    return;
  }
  if (toolName === "list_appointments" || toolName === "get_appointment") {
    if (data.id && typeof data.id === "string") {
      registerEntity(state, "appointment", {
        id: data.id,
        via_tool: toolName,
      });
    }
    return;
  }
  if (toolName === "list_bulk_jobs") {
    // Array — pega top
    const jobs = data as unknown as Array<{ job_id: string }>;
    if (Array.isArray(jobs) && jobs.length > 0) {
      registerSearch(state, {
        tool: toolName,
        entity_type: "job",
        count_returned: jobs.length,
        top_result_id: jobs[0].job_id,
      });
    }
    return;
  }

  // === WRITE tools ===
  const writeToolMap: Record<string, string> = {
    create_contact: "contact",
    update_contact: "contact",
    create_note: "note",
    update_note: "note",
    create_task: "task",
    update_task: "task",
    complete_task: "task",
    create_opportunity: "opportunity",
    update_opportunity: "opportunity",
    update_opportunity_status: "opportunity",
    create_appointment: "appointment",
    update_appointment: "appointment",
    schedule_reminder: "note",  // tipo dummy
    schedule_bulk_message_v2: "job",
    schedule_bulk_message: "job",
  };
  const entityType = writeToolMap[toolName];
  if (entityType) {
    const id =
      (typeof data.id === "string" ? data.id : undefined) ||
      (typeof data.contact_id === "string" ? data.contact_id : undefined) ||
      (typeof data.appointment_id === "string" ? data.appointment_id : undefined) ||
      (typeof data.task_id === "string" ? data.task_id : undefined) ||
      (typeof data.note_id === "string" ? data.note_id : undefined) ||
      (typeof data.opportunity_id === "string" ? data.opportunity_id : undefined) ||
      (typeof data.job_id === "string" ? data.job_id : undefined);
    if (id) {
      registerWrite(state, {
        tool: toolName,
        entity_type: entityType,
        entity_id: id,
        label: typeof data.name === "string" ? data.name : undefined,
      });
    }
  }
}

/**
 * Renderiza TurnContext como bloco pro system prompt do LLM.
 * Só inclui se há algo a mostrar (evita poluir prompt vazio).
 */
export function renderTurnContextForPrompt(state: TurnContextState): string {
  const lines: string[] = [];
  const resolved = state.resolved;
  const hasResolved = Object.keys(resolved).some((k) => resolved[k as keyof typeof resolved]);

  if (!hasResolved && !state.last_search && !state.last_write) return "";

  lines.push("# CONTEXTO FRESCO DO TURN (entidades já resolvidas — NÃO re-pergunte)");

  if (hasResolved) {
    lines.push("");
    lines.push("**Entidades resolvidas:**");
    for (const [type, entity] of Object.entries(resolved)) {
      if (!entity) continue;
      lines.push(`  • ${type}: ${entity.label || "(sem label)"} (id: ${entity.id.slice(0, 8)}...) via ${entity.via_tool}`);
    }
  }

  if (state.last_search) {
    lines.push("");
    lines.push(
      `**Última busca:** ${state.last_search.tool} → ${state.last_search.count_returned} ${state.last_search.entity_type}(s)` +
        (state.last_search.top_result_label
          ? `. Top: ${state.last_search.top_result_label} (${state.last_search.top_result_id?.slice(0, 8)}...)`
          : ""),
    );
  }

  if (state.last_write) {
    lines.push("");
    lines.push(
      `**Última write:** ${state.last_write.tool} → ${state.last_write.entity_type} ${state.last_write.entity_id.slice(0, 8)}...` +
        (state.last_write.label ? ` (${state.last_write.label})` : ""),
    );
  }

  lines.push("");
  lines.push(
    "REGRA: se rep diz 'esse contato', 'essa opp', 'esse', etc, USA o id resolvido acima. NÃO chame search/list de novo.",
  );

  return lines.join("\n");
}
