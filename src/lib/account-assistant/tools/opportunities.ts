/**
 * Tools de Opportunities. CRUD + status (move stage) + listagem de pipelines.
 */

import type { ToolEntry } from "./types";
import { validateGhlId, getRepGhlUserId, ghlErrorToResult } from "./types";

const listOpportunities: ToolEntry = {
  def: {
    name: "list_opportunities",
    description: "Lista opportunities do rep, com filtros opcionais.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["open", "won", "lost", "abandoned", "all"], default: "open" },
        min_value: { type: "number", description: "Valor mínimo." },
        pipeline_id: { type: "string" },
        all_users: { type: "boolean", description: "Se true, lista da location toda. Default false (só do rep)." },
        limit: { type: "number", default: 20 },
      },
    },
  },
  handler: async (ctx, args) => {
    const status = String(args.status || "open");
    const minValue = typeof args.min_value === "number" ? args.min_value : 0;
    const pipelineId = args.pipeline_id ? String(args.pipeline_id) : undefined;
    const limit = Math.min(Number(args.limit) || 20, 100);
    const allUsers = args.all_users === true;
    const repUserId = getRepGhlUserId(ctx);

    // GHL aceita query param `monetary_value_greater_than` em /opportunities/search.
    // Passar pra GHL evita filtrar 100 opps mais recentes e perder grandes opps
    // fora dessa janela (bug do ultra review).
    const params: Record<string, string> = {
      location_id: ctx.locationId,
      limit: String(limit),
      ...(status !== "all" ? { status } : {}),
      ...(pipelineId ? { pipeline_id: pipelineId } : {}),
      ...(allUsers || !repUserId ? {} : { assigned_to: repUserId }),
      ...(minValue > 0 ? { monetary_value_greater_than: String(minValue) } : {}),
    };

    try {
      const res = await ctx.ghlClient.get<{
        opportunities?: Array<{
          id: string; name?: string; monetaryValue?: number;
          status?: string; pipelineId?: string; pipelineStageId?: string;
          contactId?: string; assignedTo?: string;
          updatedAt?: string; createdAt?: string;
          contact?: { id: string; name: string; email?: string; phone?: string };
        }>;
      }>("/opportunities/search", params);
      // Client-side filter mantido como segurança (caso GHL devolva opps fora
      // do range por algum motivo). Mas com monetary_value_greater_than no
      // server, essa filtragem deve ser no-op.
      const opps = (res.opportunities || []).filter((o) => (o.monetaryValue || 0) >= minValue);
      return {
        status: "ok",
        data: opps.map((o) => ({
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
