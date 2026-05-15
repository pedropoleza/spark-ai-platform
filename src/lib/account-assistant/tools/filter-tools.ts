/**
 * Filter Engine — tools expostas ao LLM.
 *
 * 4 tools que consomem a engine universal (`src/lib/account-assistant/filter-engine`):
 *
 *   - get_contacts_filtered     — lista contatos via FEL com paginação completa
 *   - get_opportunities_filtered — idem pra opps
 *   - count_filtered             — só conta (1 chamada GHL, barato)
 *   - describe_filter_capabilities — descoberta de fields/ops disponíveis
 *
 * H27 (review 2026-05-15) — _planning/filter-engine-and-bulk-v2.md.
 *
 * Princípio: LLM gera FEL em JSON; engine compila + executa + audita.
 * Tools antigas (search_contacts, list_opportunities) viram wrappers
 * destas pra retrocompat.
 */

import type { ToolEntry, ToolContext } from "./types";
import type {
  FilterExpression,
  FilterExecutionContext,
} from "../filter-engine";
import {
  executeContactsFilter,
  executeOpportunitiesFilter,
  countFilter,
  listKnownFields,
  getPipelines,
  getCustomFields,
} from "../filter-engine";
import { getRepGhlUserId } from "./types";

// =====================================================================
// Helper — converte ToolContext em FilterExecutionContext
// =====================================================================

function toEngineCtx(
  ctx: ToolContext,
  consumer: string,
): FilterExecutionContext {
  const repUserId = getRepGhlUserId(ctx);
  return {
    rep_id: ctx.rep.id,
    rep_phone: ctx.rep.phone,
    location_id: ctx.locationId,
    company_id: ctx.companyId,
    ghl_client: ctx.ghlClient,
    consumer_tool: consumer,
    rep_aliases: {
      ...(ctx.rep.profile?.aliases || {}),
      ...(repUserId ? { __self_user_id: repUserId } : {}),
    },
  };
}

// =====================================================================
// FEL schema documentation — vai em description de cada tool
// =====================================================================

const FEL_DOCS = `FILTER (FEL) — formato JSON:
  Folha: { "field": "X", "op": "Y", "value": Z }
  AND  : { "all": [filter1, filter2, ...] }
  OR   : { "any": [filter1, filter2, ...] }
  NOT  : { "not": filter1 }

FIELDS comuns: firstName, lastName, email, phone, tags, dateOfBirth, dateAdded, dateUpdated, lastActivity, address1, city, state, postalCode, country, companyName, source, assignedTo, dnd, opportunity.pipelineId, opportunity.stageId, opportunity.stageName (alias auto), opportunity.status, opportunity.monetaryValue, opportunity.assignedTo, customField.{slug-ou-id}

OPS comuns: eq, neq, gt, gte, lt, lte, contains, not_contains, starts_with, ends_with, in, not_in, exists, not_exists, between, before, after, date_eq, month_day_eq

EXEMPLOS:
1. Contatos com tag 'cliente':
   { "field": "tags", "op": "contains", "value": "cliente" }
2. Contatos do M0 que moram em FL:
   { "all": [
     { "field": "opportunity.stageName", "op": "eq", "value": "M0" },
     { "field": "state", "op": "eq", "value": "FL" }
   ]}
3. Leads NOVOS (sem atividade) OU contactos com tag 'frio':
   { "any": [
     { "field": "lastActivity", "op": "not_exists", "value": null },
     { "field": "tags", "op": "contains", "value": "frio" }
   ]}
4. Aniversariantes hoje (MM-DD):
   { "field": "dateOfBirth", "op": "month_day_eq", "value": "05-15" }
5. Opps abertas > $20k atribuídas ao rep:
   { "all": [
     { "field": "opportunity.status", "op": "eq", "value": "open" },
     { "field": "opportunity.monetaryValue", "op": "gt", "value": 20000 },
     { "field": "opportunity.assignedTo", "op": "eq", "value": "self" }
   ]}
`;

// =====================================================================
// 1. get_contacts_filtered
// =====================================================================

const getContactsFiltered: ToolEntry = {
  def: {
    name: "get_contacts_filtered",
    description:
      "Lista contatos via FEL (Filter Expression Language) — sistema unificado de filtros do Spark Leads. Aceita AND/OR/NOT aninhados, aliases automáticos (stageName 'M3' → ID), custom fields por slug ou UUID, paginação ILIMITADA até cap defensivo (5000). Use SEMPRE que rep pede mais de 1 critério (ex: 'M0 + boca raton', 'leads sem atividade no FL', 'aniversariantes hoje'). NÃO use search_contacts pra critérios múltiplos — use esta.\n\n" +
      FEL_DOCS +
      "\n\nRetorno inclui `complete: true/false`, `total_returned`, `total_reported_by_ghl` (ground truth), `plan` (debug) e `applied_aliases`. ⚠️ Se `complete: false`, há mais — AVISE rep.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          description:
            "FEL — ver FILTER docs acima. Sempre passe pelo menos 1 condição.",
        },
        limit: {
          type: "number",
          description: "Soft cap total após paginação. Default 5000. Use 50-100 pra amostra rápida.",
        },
        include_opportunity: {
          type: "boolean",
          description:
            "Se true, joina dados da opp ativa de cada contato (útil pra ver stage no resultado). Default false.",
        },
        fields: {
          type: "array",
          items: { type: "string" },
          description:
            "Subset de fields a retornar (ex: ['id','name','phone']). Default: todos básicos.",
        },
      },
      required: ["filter"],
    },
  },
  handler: async (ctx, args) => {
    const filter = args.filter as FilterExpression | undefined;
    if (!filter || typeof filter !== "object") {
      return {
        status: "error",
        message: "Param 'filter' (FEL) obrigatório.",
        retryable: false,
      };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 5000, 1), 5000);
    const include_opportunity = args.include_opportunity === true;

    const result = await executeContactsFilter(
      filter,
      toEngineCtx(ctx, "get_contacts_filtered"),
      { limit, include_opportunity },
    );

    if (result.status !== "ok") {
      return {
        status: "error",
        message: result.message || "Filter Engine erro",
        retryable: result.retryable || false,
      };
    }

    if (!result.items || result.items.length === 0) {
      return {
        status: "not_found",
        message: `Nenhum contato bate o filter. Total reportado pelo GHL: ${result.total_reported_by_ghl ?? 0}.`,
      };
    }

    // Opcionalmente filtra fields no return pra economizar tokens do LLM
    const fields = Array.isArray(args.fields) ? (args.fields as string[]) : null;
    const contacts = result.items.map((c) => {
      if (!fields) {
        return {
          id: c.id,
          name: c.name,
          email: c.email,
          phone: c.phone,
          tags: c.tags,
          date_of_birth: c.dateOfBirth,
          last_activity: c.lastActivity,
          assigned_to: c.assignedTo,
        };
      }
      const out: Record<string, unknown> = {};
      for (const f of fields) {
        out[f] = (c as unknown as Record<string, unknown>)[f];
      }
      return out;
    });

    return {
      status: "ok",
      data: {
        contacts,
        complete: result.complete,
        total_returned: result.total_returned,
        total_reported_by_ghl: result.total_reported_by_ghl,
        pages_fetched: result.pages_fetched,
        hit_safety_cap: result.hit_safety_cap,
        applied_aliases: result.applied_aliases,
        duration_ms: result.duration_ms,
      },
    };
  },
};

// =====================================================================
// 2. get_opportunities_filtered
// =====================================================================

const getOpportunitiesFiltered: ToolEntry = {
  def: {
    name: "get_opportunities_filtered",
    description:
      "Lista oportunidades via FEL. Mesma DSL de get_contacts_filtered, mas retorna opps com pipeline/stage/monetaryValue. Use pra: 'opps no M3', 'deals abertos > 20k', 'opps esfriando há 30 dias' (lastStageChangeAt before X). Paginação completa.\n\n" +
      FEL_DOCS +
      "\n\nDIFERENÇA: aqui FEL deve focar em fields `opportunity.*`. Fields de contato (firstName, etc) são filtrados via join — mais lento. Pra filtro híbrido prefira get_contacts_filtered com include_opportunity.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        filter: {
          type: "object",
          description: "FEL — ver docs.",
        },
        limit: { type: "number", description: "Soft cap (default 5000)." },
      },
      required: ["filter"],
    },
  },
  handler: async (ctx, args) => {
    const filter = args.filter as FilterExpression | undefined;
    if (!filter || typeof filter !== "object") {
      return {
        status: "error",
        message: "Param 'filter' (FEL) obrigatório.",
        retryable: false,
      };
    }
    const limit = Math.min(Math.max(Number(args.limit) || 5000, 1), 5000);

    const result = await executeOpportunitiesFilter(
      filter,
      toEngineCtx(ctx, "get_opportunities_filtered"),
      { limit },
    );

    if (result.status !== "ok") {
      return {
        status: "error",
        message: result.message || "Filter Engine erro",
        retryable: result.retryable || false,
      };
    }
    if (!result.items || result.items.length === 0) {
      return {
        status: "not_found",
        message: `Nenhuma opp bate o filter. Total GHL: ${result.total_reported_by_ghl ?? 0}.`,
      };
    }

    return {
      status: "ok",
      data: {
        opportunities: result.items.map((o) => ({
          id: o.id,
          name: o.name,
          value: o.monetaryValue,
          status: o.status,
          pipeline_id: o.pipelineId,
          stage_id: o.stageId,
          contact_id: o.contactId,
          contact_name: o.contactName,
          assigned_to: o.assignedTo,
          updated_at: o.updatedAt,
        })),
        complete: result.complete,
        total_returned: result.total_returned,
        total_reported_by_ghl: result.total_reported_by_ghl,
        pages_fetched: result.pages_fetched,
        hit_safety_cap: result.hit_safety_cap,
        applied_aliases: result.applied_aliases,
      },
    };
  },
};

// =====================================================================
// 3. count_filtered
// =====================================================================

const countFiltered: ToolEntry = {
  def: {
    name: "count_filtered",
    description:
      "Conta contatos ou opps que batem um FEL SEM puxar os dados. 1 chamada GHL otimizada (pageLimit:1, lê meta.total). Use ANTES de bulk message pra preview ('quantos do M0 vão receber? 23') OU quando rep só quer número ('quantos clientes no FL?').\n\n" +
      FEL_DOCS,
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        entity: {
          type: "string",
          enum: ["contacts", "opportunities"],
          description: "O que contar. Default 'contacts'.",
        },
        filter: { type: "object", description: "FEL — ver docs." },
      },
      required: ["filter"],
    },
  },
  handler: async (ctx, args) => {
    const entity = (args.entity === "opportunities" ? "opportunities" : "contacts") as
      | "contacts"
      | "opportunities";
    const filter = args.filter as FilterExpression | undefined;
    if (!filter || typeof filter !== "object") {
      return {
        status: "error",
        message: "Param 'filter' (FEL) obrigatório.",
        retryable: false,
      };
    }

    try {
      const result = await countFilter(
        entity,
        filter,
        toEngineCtx(ctx, "count_filtered"),
      );
      return {
        status: "ok",
        data: {
          count: result.count,
          complete: result.complete,
          applied_aliases: result.applied_aliases,
          entity,
        },
      };
    } catch (err) {
      return {
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        retryable: false,
      };
    }
  },
};

// =====================================================================
// 4. describe_filter_capabilities
// =====================================================================

const describeFilterCapabilities: ToolEntry = {
  def: {
    name: "describe_filter_capabilities",
    description:
      "Retorna catálogo completo de fields/ops que o Filter Engine suporta NESTA location. Use quando rep pergunta 'dá pra filtrar por X?' OU quando bot quer validar uma FEL ANTES de chamar get_contacts_filtered. Lista pipelines + stages (resolve stageName), custom fields (resolve customField.slug), e capability matrix (quais ops são server-side vs client-side).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        include_pipelines: {
          type: "boolean",
          description: "Default true. False = só fields/ops sem pipelines.",
        },
        include_custom_fields: {
          type: "boolean",
          description: "Default true.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const include_pipelines = args.include_pipelines !== false;
    const include_custom_fields = args.include_custom_fields !== false;

    const fields = listKnownFields();

    const result: Record<string, unknown> = {
      fields,
      total_fields: fields.length,
    };

    if (include_pipelines) {
      try {
        const pipes = await getPipelines(ctx.ghlClient, ctx.locationId);
        result.pipelines = pipes.map((p) => ({
          id: p.id,
          name: p.name,
          stages: p.stages.map((s) => ({ id: s.id, name: s.name })),
        }));
      } catch (err) {
        result.pipelines_error = err instanceof Error ? err.message : String(err);
      }
    }

    if (include_custom_fields) {
      try {
        const cfs = await getCustomFields(ctx.ghlClient, ctx.locationId);
        result.custom_fields = cfs.map((cf) => ({
          id: cf.id,
          field_key: cf.fieldKey,
          name: cf.name,
          data_type: cf.dataType,
          // Mostra slug usável em FEL
          fel_reference: cf.fieldKey
            ? `customField.${cf.fieldKey}`
            : `customField.${cf.id}`,
        }));
      } catch (err) {
        result.custom_fields_error = err instanceof Error ? err.message : String(err);
      }
    }

    return { status: "ok", data: result };
  },
};

// =====================================================================
// Export
// =====================================================================

export const FILTER_ENGINE_TOOLS: ToolEntry[] = [
  getContactsFiltered,
  getOpportunitiesFiltered,
  countFiltered,
  describeFilterCapabilities,
];
