/**
 * Lead History Loader — F37 (Pedro 2026-05-29).
 *
 * Antes do queue-processor chamar o LLM, busca o histórico completo do
 * contato no Spark Leads/GHL — msgs anteriores, notas, opportunities, tags.
 * Esse contexto vira input do prompt-builder (buildLeadHistorySection) pro
 * agente saber em que ponto a conversa parou e não perguntar coisas que
 * já foram respondidas.
 *
 * Performance:
 *  - Faz fetches em paralelo via Promise.all
 *  - Cache in-memory 5min por contactId (invalidado quando webhook
 *    recebe novo inbound do mesmo contato)
 *  - Cap defensivo nas listas (notes 5, opps 5, msgs N config) e truncate
 *    body em 300 chars cada
 *
 * Fail-soft: erro de fetch GHL = retorna LeadContext vazio em vez de quebrar
 * o turn do bot. Bot apenas perde o awareness, mas responde.
 */
import { GHLClient } from "@/lib/ghl/client";
import type { LeadContext, LeadHistoryConfig } from "@/types/agent";

const CACHE_TTL_MS = 5 * 60 * 1000;
type CacheEntry = { value: LeadContext; expiresAt: number };
const cache = new Map<string, CacheEntry>();

/** Invalidate cache pra um contato (chamar quando novo inbound chegar). */
export function invalidateLeadHistoryCache(contactId: string): void {
  for (const k of cache.keys()) {
    if (k.includes(`:${contactId}:`)) cache.delete(k);
  }
}

interface GhlContactResp {
  contact?: {
    id?: string;
    firstName?: string;
    lastName?: string;
    name?: string;
    phone?: string;
    email?: string;
    tags?: Array<string | { name?: string }>;
    customFields?: Array<{ id?: string; key?: string; fieldKey?: string; value?: unknown }>;
    customField?: Array<{ id?: string; key?: string; fieldKey?: string; value?: unknown }>;
    assignedTo?: string;
  };
}

interface GhlConversation {
  id: string;
  type?: string;
  lastMessageDate?: string;
}

interface GhlConvSearchResp {
  conversations?: GhlConversation[];
}

interface GhlMessageResp {
  messages?: {
    messages?: Array<{
      id?: string;
      body?: string;
      direction?: string;
      type?: string | number;
      messageType?: string;
      dateAdded?: string;
      source?: string;
    }>;
  };
}

interface GhlNote {
  id?: string;
  body?: string;
  dateAdded?: string;
  userId?: string;
}

interface GhlNotesResp {
  notes?: GhlNote[];
}

interface GhlOppResp {
  opportunities?: Array<{
    id?: string;
    name?: string;
    pipelineId?: string;
    pipelineStageId?: string;
    status?: string;
    monetaryValue?: number;
    assignedTo?: string;
  }>;
}

interface GhlPipeline {
  id?: string;
  name?: string;
  stages?: Array<{ id?: string; name?: string }>;
}

interface GhlPipelinesResp {
  pipelines?: GhlPipeline[];
}

function extractTags(contact: GhlContactResp["contact"] | undefined): string[] {
  if (!contact?.tags) return [];
  return contact.tags
    .map((t) => (typeof t === "string" ? t : t?.name || ""))
    .filter((s): s is string => !!s);
}

function extractCustomFields(contact: GhlContactResp["contact"] | undefined): Array<{ key: string; value: string }> {
  const arr = contact?.customFields || contact?.customField || [];
  if (!Array.isArray(arr)) return [];
  return arr
    .map((f) => ({
      key: String(f?.key || f?.fieldKey || f?.id || ""),
      value: f?.value != null ? String(f.value).slice(0, 200) : "",
    }))
    .filter((f) => f.key && f.value);
}

const EMPTY_CONTEXT = (contactId: string, fetchMs: number): LeadContext => ({
  contact: { id: contactId, name: "", tags: [], customFields: [] },
  recent_messages: [],
  notes: [],
  opportunities: [],
  last_human_outbound_at: null,
  last_inbound_at: null,
  has_closed_opp: false,
  fetch_ms: fetchMs,
});

/**
 * Carrega o histórico do lead do Spark Leads/GHL. Cacheado 5min por
 * (location, contact, config-hash).
 */
export async function loadLeadHistory(
  contactId: string,
  companyId: string,
  locationId: string,
  config: LeadHistoryConfig,
): Promise<LeadContext> {
  if (!contactId || !companyId || !locationId) {
    return EMPTY_CONTEXT(contactId || "", 0);
  }
  // include_tags entra na chave (fix review 2026-06-05): sem ele, um load com
  // tags=true e outro com tags=false colidiam → perda silenciosa de tags (ou
  // tags fantasma). Agora cada combinação de flags tem cache próprio.
  const cacheKey = `${locationId}:${contactId}:${config.messages_count}:${config.include_notes ? 1 : 0}:${config.include_opportunities ? 1 : 0}:${config.include_tags ? 1 : 0}`;
  const hit = cache.get(cacheKey);
  if (hit && hit.expiresAt > Date.now()) return hit.value;

  const start = Date.now();
  const client = new GHLClient(companyId, locationId);
  const msgsCount = Math.max(5, Math.min(50, config.messages_count));

  try {
    // Paralelo: contato + conversations
    const [contactRes, convRes] = await Promise.all([
      client.get<GhlContactResp>(`/contacts/${contactId}`).catch(() => null),
      client
        .get<GhlConvSearchResp>(`/conversations/search?locationId=${locationId}&contactId=${contactId}&limit=5`)
        .catch(() => null),
    ]);

    const contact = contactRes?.contact || {};
    const conversations = convRes?.conversations || [];

    // Conversação principal: a mais recente
    const mainConv = conversations[0];
    const messagesPromise = mainConv
      ? client
          .get<GhlMessageResp>(`/conversations/${mainConv.id}/messages?limit=${msgsCount}`)
          .catch(() => null)
      : Promise.resolve(null);

    // Notas (opt)
    const notesPromise = config.include_notes
      ? client.get<GhlNotesResp>(`/contacts/${contactId}/notes?limit=5`).catch(() => null)
      : Promise.resolve(null);

    // Opps (opt) + pipelines pra resolver nome do stage
    const oppsPromise = config.include_opportunities
      ? client
          .get<GhlOppResp>(`/opportunities/search?location_id=${locationId}&contact_id=${contactId}&limit=5`)
          .catch(() => null)
      : Promise.resolve(null);
    const pipelinesPromise = config.include_opportunities
      ? client
          .get<GhlPipelinesResp>(`/opportunities/pipelines?locationId=${locationId}`)
          .catch(() => null)
      : Promise.resolve(null);

    const [messagesRes, notesRes, oppsRes, pipelinesRes] = await Promise.all([
      messagesPromise,
      notesPromise,
      oppsPromise,
      pipelinesPromise,
    ]);

    const allMsgs = messagesRes?.messages?.messages || [];
    // Normaliza msgs + ordena (GHL retorna desc; mantemos desc → invertemos pro prompt)
    const recent_messages = allMsgs.slice(0, msgsCount).map((m) => ({
      direction: (m.direction === "inbound" ? "inbound" : "outbound") as "inbound" | "outbound",
      body: String(m.body || "").slice(0, 300),
      dateAdded: String(m.dateAdded || ""),
      source: m.source,
      messageType: typeof m.messageType === "string" ? m.messageType : undefined,
    }));

    // Última msg outbound humana (source != "api" significa não foi o nosso bot)
    const lastHumanOutbound = recent_messages.find(
      (m) => m.direction === "outbound" && m.source && m.source !== "api",
    );
    const lastInbound = recent_messages.find((m) => m.direction === "inbound");

    // Notas
    const notes = config.include_notes
      ? (notesRes?.notes || []).slice(0, 5).map((n) => ({
          body: String(n.body || "").slice(0, 500),
          dateAdded: String(n.dateAdded || ""),
          userId: n.userId,
        }))
      : [];

    // Opps com resolução de nome de stage via pipelines
    const pipelinesMap = new Map<string, { name: string; stages: Map<string, string> }>();
    for (const p of pipelinesRes?.pipelines || []) {
      if (!p.id) continue;
      const stages = new Map<string, string>();
      for (const s of p.stages || []) {
        if (s.id) stages.set(s.id, s.name || s.id);
      }
      pipelinesMap.set(p.id, { name: p.name || p.id, stages });
    }
    const opps = (config.include_opportunities ? (oppsRes?.opportunities || []) : []).slice(0, 5).map((o) => {
      const p = o.pipelineId ? pipelinesMap.get(o.pipelineId) : null;
      const stageName = o.pipelineStageId && p ? p.stages.get(o.pipelineStageId) : undefined;
      return {
        id: String(o.id || ""),
        name: o.name,
        pipelineId: o.pipelineId,
        pipelineStageId: o.pipelineStageId,
        pipelineName: p?.name,
        stageName,
        status: o.status,
        monetaryValue: o.monetaryValue,
        assignedTo: o.assignedTo,
      };
    });

    const has_closed_opp = opps.some((o) =>
      ["won", "lost", "abandoned"].includes((o.status || "").toLowerCase()),
    );

    const fullName = contact.name || `${contact.firstName || ""} ${contact.lastName || ""}`.trim();

    const result: LeadContext = {
      contact: {
        id: contactId,
        name: fullName || "",
        phone: contact.phone,
        email: contact.email,
        tags: config.include_tags ? extractTags(contact) : [],
        customFields: extractCustomFields(contact),
        assignedUserId: contact.assignedTo,
      },
      recent_messages,
      notes,
      opportunities: opps,
      last_human_outbound_at: lastHumanOutbound?.dateAdded || null,
      last_inbound_at: lastInbound?.dateAdded || null,
      has_closed_opp,
      fetch_ms: Date.now() - start,
    };

    cache.set(cacheKey, { value: result, expiresAt: Date.now() + CACHE_TTL_MS });
    return result;
  } catch (err) {
    console.warn(
      `[lead-history] fetch falhou (fail-open): ${err instanceof Error ? err.message.slice(0, 200) : err}`,
    );
    return EMPTY_CONTEXT(contactId, Date.now() - start);
  }
}
