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
  /**
   * Loop detection (4.1 Pedro 2026-05-16): conta quantas vezes bot fez
   * mesma pergunta semântica na sessão. Quando >=2, prompt orienta
   * "PARE de re-perguntar, assume escolha anterior". Caso Gustavo
   * 14:55+14:56: bot mostrou MESMA tela de cap 2 vezes idênticas.
   */
  repeated_questions: Record<string, number>;
  /**
   * Bulk-specific session state (4.2 Pedro 2026-05-16): registra escolhas
   * do rep durante flow de bulk pra próximas tools reusarem sem re-perguntar.
   * Quando rep escolhe "A" no menu de coexistência, ou "tudo ok" no checklist,
   * ou opção 2 (spread_days) — registra aqui.
   */
  bulk_session_state?: {
    cap_choice?: "wait" | "parallel" | "override";
    warm_status?: "warm" | "cold" | "mixed";
    delivery_choice_id?: 1 | 2 | 3;
    scheduled_at_chosen?: string;
    accepted_disclaimers?: string[];
    last_preview_job_id?: string;
    last_preview_total_contacts?: number;
  };
}

/**
 * Cria estado vazio no início do turn.
 */
export function createTurnContext(): TurnContextState {
  return {
    resolved: {},
    repeated_questions: {},
  };
}

/**
 * 4.1: registra que bot fez uma pergunta de categoria X. Incrementa counter.
 * Categorias semânticas (não strings exatas):
 *   - "warm_status" — "é quente ou fria?"
 *   - "cap_choice" — "esperar ou paralelo?"
 *   - "delivery_choice" — "menu hoje/spread/window"
 *   - "disclaimer_ack" — "confirma os disclaimers?"
 *   - "general_confirm" — "confirma?" genérico
 *   - "contact_pick" — "qual contato?"
 *   - "opp_pick" — "qual opportunity?"
 */
export function recordQuestion(state: TurnContextState, category: string): void {
  state.repeated_questions[category] = (state.repeated_questions[category] ?? 0) + 1;
}

/**
 * 4.1: lê quantas vezes pergunta X foi feita. >=2 indica loop iminente.
 */
export function questionCount(state: TurnContextState, category: string): number {
  return state.repeated_questions[category] ?? 0;
}

/**
 * 4.2: registra escolha do rep no fluxo bulk pra próximas tools reusarem.
 */
export function recordBulkChoice<K extends keyof NonNullable<TurnContextState["bulk_session_state"]>>(
  state: TurnContextState,
  key: K,
  value: NonNullable<TurnContextState["bulk_session_state"]>[K],
): void {
  if (!state.bulk_session_state) state.bulk_session_state = {};
  state.bulk_session_state[key] = value;
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
    // Fix M15 (review 2026-05-16): result.data pode ser array direto OU
    // estar dentro de outro objeto. Robusto pra ambos.
    const jobs = Array.isArray(data) ? data : (data as { data?: unknown }).data;
    if (Array.isArray(jobs) && jobs.length > 0) {
      const top = jobs[0] as { job_id?: string };
      registerSearch(state, {
        tool: toolName,
        entity_type: "job",
        count_returned: jobs.length,
        top_result_id: typeof top.job_id === "string" ? top.job_id : undefined,
      });
    }
    return;
  }
  if (toolName === "bulk_dashboard") {
    const active = (data as { active_jobs?: Array<{ job_id: string }> }).active_jobs;
    if (Array.isArray(active) && active.length > 0) {
      registerSearch(state, {
        tool: toolName,
        entity_type: "job",
        count_returned: active.length,
        top_result_id: active[0].job_id,
      });
    }
    return;
  }

  // 4.2 Pedro 2026-05-16: bulk preview/schedule registram session state
  if (toolName === "preview_bulk_message_v2") {
    const total = typeof data.total_contacts === "number" ? data.total_contacts : undefined;
    const temp = typeof data.list_temperature === "string"
      ? data.list_temperature as "warm" | "cold" | "mixed"
      : undefined;
    if (total !== undefined || temp !== undefined) {
      if (!state.bulk_session_state) state.bulk_session_state = {};
      if (total !== undefined) state.bulk_session_state.last_preview_total_contacts = total;
      if (temp === "warm" || temp === "cold" || temp === "mixed") {
        state.bulk_session_state.warm_status = temp;
      }
    }
  }
  if (toolName === "schedule_bulk_message_v2" && typeof data.job_id === "string") {
    if (!state.bulk_session_state) state.bulk_session_state = {};
    state.bulk_session_state.last_preview_job_id = data.job_id;
    // Strategy choice persistida
    const strat = data.delivery_strategy as { type?: string } | undefined;
    if (strat?.type === "today") state.bulk_session_state.delivery_choice_id = 1;
    else if (strat?.type === "spread_days") state.bulk_session_state.delivery_choice_id = 2;
    else if (strat?.type === "custom_window") state.bulk_session_state.delivery_choice_id = 3;
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
  const hasBulkState = state.bulk_session_state && Object.keys(state.bulk_session_state).length > 0;
  const repeatedAny = Object.entries(state.repeated_questions).some(([, c]) => c >= 2);

  if (!hasResolved && !state.last_search && !state.last_write && !hasBulkState && !repeatedAny) {
    return "";
  }

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

  // 4.2: bulk session state
  if (hasBulkState && state.bulk_session_state) {
    const bs = state.bulk_session_state;
    lines.push("");
    lines.push("**Bulk session state (escolhas do rep já feitas):**");
    if (bs.warm_status) lines.push(`  • Lista: ${bs.warm_status} (NÃO re-pergunte)`);
    if (bs.cap_choice) lines.push(`  • Coexistência: ${bs.cap_choice}`);
    if (bs.delivery_choice_id) lines.push(`  • Delivery: opção ${bs.delivery_choice_id}`);
    if (bs.scheduled_at_chosen) lines.push(`  • Start_at: ${bs.scheduled_at_chosen}`);
    if (bs.accepted_disclaimers && bs.accepted_disclaimers.length > 0) {
      lines.push(`  • Disclaimers OK: ${bs.accepted_disclaimers.join(", ")}`);
    }
    if (bs.last_preview_job_id) lines.push(`  • Último job criado: ${bs.last_preview_job_id.slice(0, 8)}`);
    if (bs.last_preview_total_contacts) lines.push(`  • Último preview: ${bs.last_preview_total_contacts} contatos`);
  }

  // 4.1: loop detection
  if (repeatedAny) {
    lines.push("");
    lines.push("⚠️ **ALERTAS DE LOOP — você já fez essas perguntas várias vezes:**");
    for (const [cat, count] of Object.entries(state.repeated_questions)) {
      if (count >= 2) {
        lines.push(`  • '${cat}' já perguntado ${count}x — PARE de re-perguntar.`);
      }
    }
    lines.push(
      "Se rep não respondeu CLARAMENTE ainda, ASSUMA escolha mais segura (esperar, lista quente, opção 1) " +
      "OU pergunte UMA VEZ DIFERENTE ('me passa um 'sim' ou 'não'?'). NUNCA repita pergunta igual.",
    );
  }

  lines.push("");
  lines.push(
    "REGRA: se rep diz 'esse contato', 'essa opp', 'esse', etc, USA o id resolvido acima. NÃO chame search/list de novo.",
  );

  return lines.join("\n");
}
