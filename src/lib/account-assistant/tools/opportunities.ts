/**
 * Tools de Opportunities. CRUD + status (move stage) + listagem de pipelines.
 */

import type { ToolEntry } from "./types";
import { validateGhlId, getRepGhlUserId, ghlErrorToResult } from "./types";

const listOpportunities: ToolEntry = {
  def: {
    name: "list_opportunities",
    description:
      "Lista opportunities do rep com auto-paginação. Filtros: status, stage_id/stage_name (auto-resolve), pipeline_id, min_value. Retorna 'complete: true/false'.\n\n" +
      "⚠️ PARA CRITÉRIOS MÚLTIPLOS (stage + valor + último update, AND/OR, custom fields) use `get_opportunities_filtered` — suporta FEL completo via Filter Engine (H27). Esta tool é wrapper retrocompat pra filtros simples.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"], default: "open" },
        min_value: { type: "number", description: "Valor mínimo monetário (server-side)." },
        pipeline_id: { type: "string" },
        stage_id: { type: "string", description: "UUID do stage. Mais preciso/rápido que stage_name." },
        stage_name: {
          type: "string",
          description: "Nome do stage (case-insensitive, partial match). Ex: 'M3' encontra 'Inscrito M3'. Se ambíguo (várias matches), retorna erro com lista — passe stage_id direto.",
        },
        all_users: { type: "boolean", description: "Se true, lista da location toda. Default false (só do rep)." },
        limit: { type: "number", description: "Soft cap total de resultados após paginação. Default 5000 = puxa praticamente tudo. Use limit menor (ex 50) só pra amostra rápida.", default: 5000 },
      },
    },
  },
  handler: async (ctx, args) => {
    const status = String(args.status || "open");
    const minValue = typeof args.min_value === "number" ? args.min_value : 0;
    const pipelineId = args.pipeline_id ? String(args.pipeline_id) : undefined;
    let stageId = args.stage_id ? String(args.stage_id) : undefined;
    const stageNameQuery = args.stage_name ? String(args.stage_name).trim() : undefined;
    const cap = Math.min(Math.max(Number(args.limit) || 5000, 1), 5000);
    const allUsers = args.all_users === true;
    const repUserId = getRepGhlUserId(ctx);

    // Resolve stage_name → stage_id automaticamente (fix Gustavo 2026-05-14).
    // Antes o bot precisava chamar list_pipelines manualmente e copiar UUID;
    // virava ping-pong de tool calls + bot alucinava IDs.
    let stageResolved: string | undefined;
    if (stageNameQuery && !stageId) {
      try {
        const pipesRes = await ctx.ghlClient.get<{
          pipelines?: Array<{
            id: string; name?: string;
            stages?: Array<{ id: string; name?: string }>;
          }>;
        }>("/opportunities/pipelines", { locationId: ctx.locationId });
        const pipes = pipesRes.pipelines || [];
        const q = stageNameQuery.toLowerCase();
        const exact: Array<{ pipelineName: string; stageId: string; stageName: string }> = [];
        const partial: typeof exact = [];
        for (const p of pipes) {
          for (const s of p.stages || []) {
            const sn = (s.name || "").toLowerCase().trim();
            if (!sn) continue;
            if (sn === q) {
              exact.push({
                pipelineName: p.name || "(pipeline)",
                stageId: s.id,
                stageName: s.name || "(stage)",
              });
            } else if (sn.includes(q) || q.includes(sn)) {
              partial.push({
                pipelineName: p.name || "(pipeline)",
                stageId: s.id,
                stageName: s.name || "(stage)",
              });
            }
          }
        }
        // Exact match tem precedência. Só cai pra partial se zero exact.
        const matches = exact.length > 0 ? exact : partial;
        if (matches.length === 0) {
          return {
            status: "not_found",
            message: `Stage '${stageNameQuery}' não encontrado em nenhum pipeline. Chame list_pipelines pra ver opções.`,
          };
        }
        if (matches.length > 1) {
          const list = matches
            .slice(0, 8)
            .map((m) => `${m.pipelineName} → ${m.stageName} (id: ${m.stageId})`)
            .join("; ");
          return {
            status: "error",
            message: `Stage '${stageNameQuery}' tem ${matches.length} matches: ${list}. Passe stage_id direto pra ser preciso.`,
            retryable: false,
          };
        }
        stageId = matches[0].stageId;
        stageResolved = `${matches[0].pipelineName} → ${matches[0].stageName}`;
      } catch (err) {
        return ghlErrorToResult(err, "resolução de stage_name");
      }
    }

    // Base params (per-page = 100 = max do GHL). Filtros server-side reduzem
    // dados em trânsito e respeitam paginação correta.
    const baseParams: Record<string, string> = {
      location_id: ctx.locationId,
      limit: "100",
      ...(status !== "all" ? { status } : {}),
      ...(pipelineId ? { pipeline_id: pipelineId } : {}),
      ...(stageId ? { pipeline_stage_id: stageId } : {}),
      ...(allUsers || !repUserId ? {} : { assigned_to: repUserId }),
      ...(minValue > 0 ? { monetary_value_greater_than: String(minValue) } : {}),
    };

    type OppItem = {
      id: string; name?: string; monetaryValue?: number;
      status?: string; pipelineId?: string; pipelineStageId?: string;
      contactId?: string; assignedTo?: string;
      updatedAt?: string; createdAt?: string;
      contact?: { id: string; name: string; email?: string; phone?: string };
    };
    type OppsResp = {
      opportunities?: OppItem[];
      meta?: {
        total?: number;
        startAfterId?: string;
        startAfter?: number;
        nextPageUrl?: string;
      };
    };

    const allOpps: OppItem[] = [];
    let pagesFetched = 0;
    let cursor: { startAfterId?: string; startAfter?: number } = {};
    let totalReported: number | undefined;
    let complete = false;
    const MAX_PAGES = Math.ceil(cap / 100); // 5000 cap → 50 pages

    try {
      while (pagesFetched < MAX_PAGES) {
        const params: Record<string, string> = { ...baseParams };
        if (cursor.startAfterId) params.startAfterId = cursor.startAfterId;
        if (cursor.startAfter !== undefined) params.startAfter = String(cursor.startAfter);

        const res = await ctx.ghlClient.get<OppsResp>("/opportunities/search", params);
        pagesFetched++;

        // Captura total reportado pelo GHL na 1ª resposta (ground truth)
        if (totalReported === undefined && typeof res.meta?.total === "number") {
          totalReported = res.meta.total;
        }

        // Defesa: client-side filter de min_value (já enviado server-side, mas
        // mantém como safety net se GHL devolver algo fora do filtro). Também
        // aplica stage_id client-side se server não respeitar.
        const page = (res.opportunities || []).filter((o) => {
          if ((o.monetaryValue || 0) < minValue) return false;
          if (stageId && o.pipelineStageId !== stageId) return false;
          return true;
        });

        if (page.length === 0 && (res.opportunities || []).length === 0) {
          // Página vazia real = fim natural
          complete = true;
          break;
        }
        allOpps.push(...page);

        // Sem cursor de próxima página = fim natural
        const nextCursor = res.meta?.startAfterId;
        if (!nextCursor) {
          complete = true;
          break;
        }
        // Anti loop-infinito: cursor idêntico
        if (nextCursor === cursor.startAfterId) {
          complete = true;
          break;
        }
        cursor = {
          startAfterId: nextCursor,
          startAfter: res.meta?.startAfter,
        };

        // Hit cap
        if (allOpps.length >= cap) break;
      }

      if (allOpps.length === 0) {
        return {
          status: "not_found",
          message: `Nenhuma opportunity com filtros (status=${status}${stageResolved ? `, stage=${stageResolved}` : ""}${minValue > 0 ? `, min_value=${minValue}` : ""}).`,
        };
      }

      const trimmed = allOpps.slice(0, cap);
      // Se trimmou abaixo de allOpps.length, ainda pode haver mais → not complete
      if (trimmed.length < allOpps.length) complete = false;

      return {
        status: "ok",
        data: {
          opportunities: trimmed.map((o) => ({
            id: o.id,
            name: o.name,
            value: o.monetaryValue || 0,
            status: o.status,
            pipeline_id: o.pipelineId,
            stage_id: o.pipelineStageId,
            contact_id: o.contactId,
            contact_name: o.contact?.name,
            assigned_to: o.assignedTo,
            updated_at: o.updatedAt,
            created_at: o.createdAt,
          })),
          complete,
          total_returned: trimmed.length,
          pages_fetched: pagesFetched,
          ...(stageResolved ? { stage_resolved: stageResolved } : {}),
          ...(typeof totalReported === "number" ? { total_reported_by_ghl: totalReported } : {}),
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de opportunities");
    }
  },
};

const getOpportunity: ToolEntry = {
  def: {
    name: "get_opportunity",
    description: "Detalhes completos de uma opportunity.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { opportunity_id: { type: "string" } },
      required: ["opportunity_id"],
    },
  },
  handler: async (ctx, args) => {
    const oppId = String(args.opportunity_id || "");
    const invalid = validateGhlId(oppId, "opportunity");
    if (invalid) return invalid;

    try {
      const res = await ctx.ghlClient.get<{
        opportunity?: {
          id: string; name?: string; monetaryValue?: number;
          status?: string; pipelineId?: string; pipelineStageId?: string;
          contactId?: string; assignedTo?: string;
          source?: string; lastStatusChangeAt?: string; lastStageChangeAt?: string;
          updatedAt?: string; createdAt?: string;
        };
      }>(`/opportunities/${oppId}`);
      if (!res.opportunity) return { status: "not_found", message: "Opportunity não encontrada" };
      const o = res.opportunity;
      return {
        status: "ok",
        data: {
          id: o.id,
          name: o.name,
          value: o.monetaryValue,
          status: o.status,
          pipeline_id: o.pipelineId,
          stage_id: o.pipelineStageId,
          contact_id: o.contactId,
          assigned_to: o.assignedTo,
          source: o.source,
          last_stage_change_at: o.lastStageChangeAt,
          updated_at: o.updatedAt,
          created_at: o.createdAt,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de opportunity");
    }
  },
};

const createOpportunity: ToolEntry = {
  def: {
    name: "create_opportunity",
    description: "Cria uma nova opportunity associada a um contato.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        pipeline_id: { type: "string", description: "Use list_pipelines pra obter." },
        stage_id: { type: "string" },
        name: { type: "string", description: "Nome da oportunidade." },
        monetary_value: { type: "number" },
        status: { type: "string", enum: ["open", "won", "lost", "abandoned"], default: "open" },
      },
      required: ["contact_id", "pipeline_id", "name"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const pipelineId = String(args.pipeline_id || "");
    const invalid = validateGhlId(contactId, "contact") || validateGhlId(pipelineId, "pipeline");
    if (invalid) return invalid;
    const name = String(args.name || "").trim();
    if (!name) return { status: "error", message: "name obrigatório", retryable: false };

    try {
      const body: Record<string, unknown> = {
        locationId: ctx.locationId,
        contactId,
        pipelineId,
        name,
        status: String(args.status || "open"),
      };
      if (args.stage_id) body.pipelineStageId = String(args.stage_id);
      if (typeof args.monetary_value === "number") body.monetaryValue = args.monetary_value;
      const repUser = getRepGhlUserId(ctx);
      if (repUser) body.assignedTo = repUser;

      const res = await ctx.ghlClient.post<{ opportunity?: { id: string } }>("/opportunities/", body);
      return { status: "ok", data: { opportunity_id: res.opportunity?.id } };
    } catch (err) {
      return ghlErrorToResult(err, "criação de opportunity");
    }
  },
};

const updateOpportunity: ToolEntry = {
  def: {
    name: "update_opportunity",
    description: "Edita campos de uma opportunity (nome, valor, atribuir, mover stage). Pra mudar só status use update_opportunity_status.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        opportunity_id: { type: "string" },
        name: { type: "string" },
        monetary_value: { type: "number" },
        pipeline_id: { type: "string" },
        stage_id: { type: "string" },
        assigned_to: { type: "string", description: "ghl_user_id." },
      },
      required: ["opportunity_id"],
    },
  },
  handler: async (ctx, args) => {
    const oppId = String(args.opportunity_id || "");
    const invalid = validateGhlId(oppId, "opportunity");
    if (invalid) return invalid;

    const body: Record<string, unknown> = {};
    if (args.name) body.name = String(args.name);
    if (typeof args.monetary_value === "number") body.monetaryValue = args.monetary_value;
    if (args.pipeline_id) body.pipelineId = String(args.pipeline_id);
    if (args.stage_id) body.pipelineStageId = String(args.stage_id);
    if (args.assigned_to) body.assignedTo = String(args.assigned_to);
    if (Object.keys(body).length === 0) {
      return { status: "error", message: "Nenhum campo pra atualizar", retryable: false };
    }

    try {
      await ctx.ghlClient.put(`/opportunities/${oppId}`, body);
      return { status: "ok", data: { opportunity_id: oppId, updated: Object.keys(body) } };
    } catch (err) {
      return ghlErrorToResult(err, "atualização de opportunity");
    }
  },
};

const updateOpportunityStatus: ToolEntry = {
  def: {
    name: "update_opportunity_status",
    description: "Muda só o status (open/won/lost/abandoned) de uma opportunity.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        opportunity_id: { type: "string" },
        status: { type: "string", enum: ["open", "won", "lost", "abandoned"] },
      },
      required: ["opportunity_id", "status"],
    },
  },
  handler: async (ctx, args) => {
    const oppId = String(args.opportunity_id || "");
    const invalid = validateGhlId(oppId, "opportunity");
    if (invalid) return invalid;
    const status = String(args.status || "");
    if (!["open", "won", "lost", "abandoned"].includes(status)) {
      return { status: "error", message: "status inválido", retryable: false };
    }

    try {
      await ctx.ghlClient.put(`/opportunities/${oppId}/status`, { status });
      return { status: "ok", data: { opportunity_id: oppId, status } };
    } catch (err) {
      return ghlErrorToResult(err, "mudança de status da opportunity");
    }
  },
};

const deleteOpportunity: ToolEntry = {
  def: {
    name: "delete_opportunity",
    description: "⚠️ AÇÃO IRREVERSÍVEL: Apaga a opportunity.",
    risk: "high",
    parameters: {
      type: "object",
      properties: { opportunity_id: { type: "string" } },
      required: ["opportunity_id"],
    },
  },
  handler: async (ctx, args) => {
    const oppId = String(args.opportunity_id || "");
    const invalid = validateGhlId(oppId, "opportunity");
    if (invalid) return invalid;

    try {
      await ctx.ghlClient.delete(`/opportunities/${oppId}`);
      return { status: "ok", data: { deleted: oppId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de opportunity");
    }
  },
};

const listPipelines: ToolEntry = {
  def: {
    name: "list_pipelines",
    description: "Lista pipelines disponíveis na location (com seus stages). Use antes de create_opportunity ou pra mover stage.",
    risk: "safe",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    try {
      const res = await ctx.ghlClient.get<{
        pipelines?: Array<{
          id: string; name?: string;
          stages?: Array<{ id: string; name?: string; position?: number }>;
        }>;
      }>("/opportunities/pipelines", { locationId: ctx.locationId });
      return {
        status: "ok",
        data: (res.pipelines || []).map((p) => ({
          id: p.id, name: p.name,
          stages: (p.stages || []).map((s) => ({ id: s.id, name: s.name, position: s.position })),
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de pipelines");
    }
  },
};

export const OPPORTUNITIES_TOOLS: ToolEntry[] = [
  listOpportunities,
  getOpportunity,
  createOpportunity,
  updateOpportunity,
  updateOpportunityStatus,
  deleteOpportunity,
  listPipelines,
];
