/**
 * Tools de Contatos. CRUD + busca + acessórios (notes/tasks/appointments do contato).
 */

import type { ToolEntry } from "./types";
import { validateGhlId, ghlErrorToResult, getRepGhlUserId } from "./types";
import {
  getContact as ghlGetContact,
  createContact as ghlCreateContact,
  updateContact as ghlUpdateContact,
  deleteContact as ghlDeleteContact,
  getContactAppointments as ghlGetContactAppointments,
  listNotesOnContact,
  listTasksOnContact,
} from "@/lib/ghl/operations";
import { executeContactsFilter, type FilterExpression } from "../filter-engine";
import { normalizePhone, resolveLocationDefaultCountry } from "../identity";
// F5/F6 (contact-resolution 2026-06): resolver fuzzy + telefone + score (substitui o GET cru).
import { resolveContact } from "../contact-resolver";
// H47-F1 (2026-07-10): alimenta o desempate por recência do resolver (param existia e nunca era passado).
import { readRecentContacts } from "../contact-resolver/active-contact";
import { phoneDigits } from "../contact-resolver/normalize";

const searchContacts: ToolEntry = {
  def: {
    name: "search_contacts",
    description:
      "Busca CONTATOS por critério único simples (query / tag / assigned_to_me). Wrapper retrocompat do Filter Engine — use esta pra 90% dos casos de lookup rápido (achar contato por nome antes de criar nota, etc).\n\n" +
      "⚠️ PARA FILTROS COMPLEXOS (múltiplos critérios, AND/OR, custom fields, opportunity joins, aniversariantes, etc) use a tool `get_contacts_filtered` — ela suporta FEL completo.\n\n" +
      "DICAS: (1) query precisa ≥ 2 chars; phone em dígitos puros (5511987654321) ou E.164 (+5511987654321). " +
      "(2) tag aceita partial: 'boca' encontra 'mora perto de boca raton'. " +
      "(3) Retorna 'complete: true' se exauriu fonte; 'false' se hit cap → SEMPRE avise rep que há mais.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Nome, email ou phone (parcial)." },
        tag: { type: "string", description: "Filtra por tag (case-insensitive, partial match)." },
        assigned_to_me: { type: "boolean", description: "Se true, só contatos atribuídos ao rep." },
        limit: { type: "number", description: "Soft cap total após paginação. Default 1000, max 5000.", default: 1000 },
      },
    },
  },
  handler: async (ctx, args) => {
    const query = args.query ? String(args.query).trim() : undefined;
    const tag = args.tag ? String(args.tag).trim() : undefined;
    const assignedToMe = args.assigned_to_me === true;
    const cap = Math.min(Math.max(Number(args.limit) || 1000, 1), 5000);

    if (!query && !tag && !assignedToMe) {
      return { status: "error", message: "Passe pelo menos um filtro: query, tag ou assigned_to_me", retryable: false };
    }

    // F5/F6 (contact-resolution 2026-06): busca simples (só query) passa pelo RESOLVER —
    // escada de variantes de nome (completo→primeiro→último) + telefone normalizado +
    // ranking fuzzy por score/recência. Substitui o GET single-term cru que falhava em
    // "Fernanda Lira" (caso âncora: contato existe como "fernanada lira", typo no cadastro).
    // Devolve match_score + best_match + confidence pra o bot decidir (auto-confirma/lista),
    // em vez do "não achei" terminal. Ver _planning/sparkbot-contact-resolution-2026-06/.
    if (query && !tag && !assignedToMe) {
      try {
        const defaultCountry = await resolveLocationDefaultCountry(ctx.locationId);
        // H47-F1 (2026-07-10): o ring buffer F10 agora ALIMENTA o desempate por
        // recência do resolver (o param recentContactIds existia desde o H45 e
        // nunca era passado — desempate implementado e morto).
        const recentIds = new Set(readRecentContacts(ctx.rep.profile).map((c) => c.id));
        const result = await resolveContact(ctx.ghlClient, ctx.locationId, query, {
          defaultCountry,
          recentContactIds: recentIds.size > 0 ? recentIds : undefined,
          limit: Math.min(cap, 50),
        });
        if (!result.best || result.alternatives.length === 0) {
          return { status: "not_found", message: `Nenhum contato encontrado pra "${query}" (tentei variações de nome e de telefone).` };
        }
        // H47-F1 (2026-07-10, caso Thais F Garrett × Thaís Gerdt): DUPLICATA do mesmo
        // contato (mesmo telefone/email normalizado do best) NÃO é ambiguidade — antes,
        // 2 cadastros do mesmo cliente (score ~1.0/1.0, gap 0) viravam "ambiguous" e o
        // bot mandava o rep escolher entre iguais. Detecta, tira do cálculo de gap e
        // AVISA que há cadastro duplicado.
        const bestPhone = result.best.phone ? phoneDigits(result.best.phone) : "";
        const bestEmail = (result.best.email || "").trim().toLowerCase();
        const bestId = result.best.id;
        const duplicatesOfBest = result.alternatives.filter((c) => {
          if (c.id === bestId) return false;
          const p = c.phone ? phoneDigits(c.phone) : "";
          const e = (c.email || "").trim().toLowerCase();
          return (!!bestPhone && p === bestPhone) || (!!bestEmail && e === bestEmail);
        });
        const dupIds = new Set(duplicatesOfBest.map((c) => c.id));
        // alternatives vêm ordenadas (best primeiro) — recalcula gap/sole SEM as duplicatas.
        const nonDup = result.alternatives.filter((c) => c.id === bestId || !dupIds.has(c.id));
        const effGap = nonDup.length >= 2 ? Number((nonDup[0].score - nonDup[1].score).toFixed(3)) : 0;
        const effSole = nonDup.length === 1;

        // F7 (hardening pós-review): score = similaridade PURA; gap só vale com ≥2 candidatos
        // (sole → gap=0). 'high' = dominante OU único-forte (bot confirma inline + segue);
        // 'needs_confirm' = 1 decente mas não certíssimo (bot pergunta "é a Fulana?" antes);
        // 'ambiguous' = 2+ colados (lista); 'low' = fraco (trata como não-achei).
        const confidence =
          nonDup.length >= 2 && effGap < 0.12 && result.score >= 0.6
            ? "ambiguous"
            : result.score >= 0.9 && (effSole || effGap >= 0.15)
              ? "high"
              : result.score >= 0.7
                ? "needs_confirm"
                : "low";
        return {
          status: "ok",
          data: {
            contacts: result.alternatives.map((c) => ({
              id: c.id,
              name: c.name,
              email: c.email,
              phone: c.phone,
              tags: c.tags,
              last_activity: c.last_activity,
              match_score: c.score,
            })),
            best_match: { id: result.best.id, name: result.best.name, score: result.score, gap: effGap },
            confidence,
            // Duplicatas do best (mesmo fone/email com OUTRO id). O bot deve usar o
            // best_match e AVISAR o rep ("existem 2 cadastros desse contato: X e Y —
            // vou usar o mais recente"), nunca pedir pra escolher entre iguais.
            duplicates_of_best: duplicatesOfBest.length > 0
              ? duplicatesOfBest.map((c) => ({ id: c.id, name: c.name }))
              : undefined,
            complete: true,
            total_returned: result.alternatives.length,
            method: `resolver (${result.method})`,
          },
        };
      } catch (err) {
        return ghlErrorToResult(err, "busca de contatos");
      }
    }

    // H27 (review 2026-05-15): wraps Filter Engine pra critério múltiplo.
    // Constrói FEL a partir dos args legacy.
    const repUserId = getRepGhlUserId(ctx);
    const conditions: FilterExpression[] = [];
    if (query) {
      // Query string ambígua (pode ser nome, email ou phone) — usa fullName client-side
      // Mas se chegou aqui é porque tem outro filter — usa contains em fullName via engine.
      // Limitação: engine não tem fullName server-side. Será client-side filter.
      // (Como fallback razoável)
      conditions.push({ field: "fullName", op: "contains", value: query });
    }
    if (tag) conditions.push({ field: "tags", op: "contains", value: tag });
    if (assignedToMe && repUserId) {
      conditions.push({ field: "assignedTo", op: "eq", value: repUserId });
    }

    const filter: FilterExpression = conditions.length === 1 ? conditions[0] : { all: conditions };
    const result = await executeContactsFilter(
      filter,
      {
        rep_id: ctx.rep.id,
        rep_phone: ctx.rep.phone,
        location_id: ctx.locationId,
        company_id: ctx.companyId,
        ghl_client: ctx.ghlClient,
        consumer_tool: "search_contacts",
        rep_aliases: {
          ...(ctx.rep.profile?.aliases || {}),
          ...(repUserId ? { __self_user_id: repUserId } : {}),
        },
      },
      { limit: cap },
    );

    if (result.status !== "ok") {
      return { status: "error", message: result.message || "erro", retryable: result.retryable || false };
    }
    if (!result.items || result.items.length === 0) {
      return {
        status: "not_found",
        message: `Nenhum contato${tag ? ` com tag "${tag}"` : ""}${query ? ` matching "${query}"` : ""}${assignedToMe ? " atribuído a você" : ""}.`,
      };
    }
    return {
      status: "ok",
      data: {
        contacts: result.items.map((c) => ({
          id: c.id,
          name: c.name || "(sem nome)",
          email: c.email,
          phone: c.phone,
          tags: c.tags,
          assigned_to: c.assignedTo,
          last_activity: c.lastActivity,
        })),
        complete: result.complete,
        total_returned: result.total_returned,
        pages_fetched: result.pages_fetched,
        total_reported_by_ghl: result.total_reported_by_ghl,
        method: "Filter Engine",
      },
    };
  },
};

const getContact: ToolEntry = {
  def: {
    name: "get_contact",
    description: "Detalhes completos de um contato (tags, custom fields, datas).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      const res = await ghlGetContact(ctx.ghlClient, contactId) as {
        contact: {
          id: string;
          firstName?: string; lastName?: string; name?: string;
          email?: string; phone?: string; tags?: string[];
          customFields?: Array<{ id: string; value: string; fieldKey?: string }>;
          dateAdded?: string; lastActivity?: string;
          address1?: string; city?: string; state?: string; postalCode?: string; country?: string;
          companyName?: string; dateOfBirth?: string;
        };
      };

      if (!res.contact) return { status: "not_found", message: `Contato ${contactId} não existe` };
      const c = res.contact;
      return {
        status: "ok",
        data: {
          id: c.id,
          name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
          email: c.email,
          phone: c.phone,
          tags: c.tags || [],
          address: { line1: c.address1, city: c.city, state: c.state, postalCode: c.postalCode, country: c.country },
          company: c.companyName,
          date_of_birth: c.dateOfBirth,
          custom_fields: (c.customFields || []).map((f) => ({ key: f.fieldKey || f.id, value: f.value })),
          created_at: c.dateAdded,
          last_activity: c.lastActivity,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "consulta de contato");
    }
  },
};

const createContact: ToolEntry = {
  def: {
    name: "create_contact",
    description:
      "Cria contato novo na location ativa. Spark Leads faz dedup automático por email/phone. Use quando o rep pedir 'cria um novo lead/cliente'. ⚠️ ANTES de criar, SEMPRE rode search_contacts por telefone/email pra ver se já existe — evita duplicata.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string", description: "Email do contato (recomendado)." },
        phone: { type: "string", description: "Phone E.164 (ex: +5511987654321)." },
        company_name: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
        source: { type: "string", description: "Onde o lead veio (ex: 'WhatsApp inbound')." },
        assigned_to: {
          type: "string",
          description:
            "User ID do Spark Leads pra dono/owner. Se o rep pedir 'me coloca como owner', " +
            "use o ghl_user_id dele na location ativa.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const firstName = args.first_name ? String(args.first_name).trim() : undefined;
    const lastName = args.last_name ? String(args.last_name).trim() : undefined;
    const email = args.email ? String(args.email).trim() : undefined;
    const phoneRaw = args.phone ? String(args.phone).trim() : undefined;
    if (!firstName && !lastName && !email && !phoneRaw) {
      return { status: "error", message: "Pelo menos um de: first_name, last_name, email, phone", retryable: false };
    }

    // Normaliza phone BR-aware (paridade c/ import tabular): operação é US mas
    // mercado é BR — número BR de 10/11 dígitos sem `+` default-a pra +1 no GHL,
    // gerando phone errado, falha de dedup e outbound (SMS/WhatsApp) que não
    // entrega silenciosamente. normalizePhone preserva quem já veio em E.164.
    const phone = phoneRaw
      ? normalizePhone(phoneRaw, await resolveLocationDefaultCountry(ctx.locationId))
      : undefined;

    try {
      const body: Record<string, unknown> = { locationId: ctx.locationId };
      if (firstName) body.firstName = firstName;
      if (lastName) body.lastName = lastName;
      if (email) body.email = email;
      if (phone) body.phone = phone;
      if (args.company_name) body.companyName = String(args.company_name);
      if (Array.isArray(args.tags)) body.tags = args.tags;
      if (args.source) body.source = String(args.source);
      if (args.assigned_to) body.assignedTo = String(args.assigned_to);

      const res = await ghlCreateContact(ctx.ghlClient, body);
      return { status: "ok", data: { contact_id: res.contact?.id } };
    } catch (err) {
      return ghlErrorToResult(err, "criação de contato");
    }
  },
};

const updateContact: ToolEntry = {
  def: {
    name: "update_contact",
    description:
      "Atualiza um ou mais campos do contato. Aceita standard fields (firstName, lastName, email, phone, address1, city, state, postalCode, country, companyName, dateOfBirth), owner via assigned_to (Spark Leads user ID), ou custom fields via custom_fields[].",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        first_name: { type: "string" },
        last_name: { type: "string" },
        email: { type: "string" },
        phone: { type: "string" },
        company_name: { type: "string" },
        address: {
          type: "object",
          properties: {
            line1: { type: "string" }, city: { type: "string" }, state: { type: "string" },
            postal_code: { type: "string" }, country: { type: "string" },
          },
        },
        date_of_birth: { type: "string", description: "ISO date YYYY-MM-DD" },
        assigned_to: {
          type: "string",
          description:
            "User ID do Spark Leads pra dono/owner do contato (campo `assignedTo` na API). " +
            "Se o rep pedir 'me coloca como owner', use ctx.rep.ghl_users[active].ghl_user_id.",
        },
        custom_fields: {
          type: "array",
          description: "[{ key: 'field_id_or_key', value: '...' }]",
          items: {
            type: "object",
            properties: { key: { type: "string" }, value: { type: "string" } },
            required: ["key", "value"],
          },
        },
      },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    const body: Record<string, unknown> = {};
    if (args.first_name) body.firstName = String(args.first_name);
    if (args.last_name) body.lastName = String(args.last_name);
    if (args.email) body.email = String(args.email);
    // Normaliza phone BR-aware só quando veio no update (parcial). Mesmo motivo
    // do create_contact: número BR sem `+` viraria +1 errado; E.164 é preservado.
    if (args.phone) {
      const defaultCountry = await resolveLocationDefaultCountry(ctx.locationId);
      body.phone = normalizePhone(String(args.phone).trim(), defaultCountry);
    }
    if (args.company_name) body.companyName = String(args.company_name);
    if (args.date_of_birth) body.dateOfBirth = String(args.date_of_birth);
    if (args.assigned_to) body.assignedTo = String(args.assigned_to);
    if (args.address && typeof args.address === "object") {
      const a = args.address as Record<string, unknown>;
      if (a.line1) body.address1 = String(a.line1);
      if (a.city) body.city = String(a.city);
      if (a.state) body.state = String(a.state);
      if (a.postal_code) body.postalCode = String(a.postal_code);
      if (a.country) body.country = String(a.country);
    }
    if (Array.isArray(args.custom_fields)) {
      // Fix CRITICAL stress test 2026-05-03: GHL aceita { id: UUID } OU
      // { key: slug } — antes hardcodávamos `id: cf.key` e custom fields
      // referenciados por slug (vindo de list_custom_fields) eram silenciosamente
      // descartados pelo GHL. Agora detecta formato e mapeia correto.
      // GHL IDs são alfanuméricos ~20+ chars. Slugs costumam ter underscore ou
      // chars não-alfanuméricos.
      body.customFields = (args.custom_fields as Array<{ key: string; value: string }>).map(
        (cf) => {
          const looksLikeGhlId = /^[A-Za-z0-9]{18,}$/.test(cf.key);
          return looksLikeGhlId
            ? { id: cf.key, value: cf.value }
            : { key: cf.key, value: cf.value };
        },
      );
    }
    if (Object.keys(body).length === 0) {
      return { status: "error", message: "Nenhum campo pra atualizar", retryable: false };
    }

    try {
      await ghlUpdateContact(ctx.ghlClient, contactId, body);
      return { status: "ok", data: { updated: Object.keys(body) } };
    } catch (err) {
      return ghlErrorToResult(err, "atualização de contato");
    }
  },
};

const deleteContact: ToolEntry = {
  def: {
    name: "delete_contact",
    description:
      "⚠️ AÇÃO IRREVERSÍVEL: Apaga o contato e TODOS os dados associados (notas, tasks, appointments, oportunidades). Use só com confirmação explícita do rep.",
    risk: "high",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      await ghlDeleteContact(ctx.ghlClient, contactId);
      return { status: "ok", data: { deleted: contactId } };
    } catch (err) {
      return ghlErrorToResult(err, "deleção de contato");
    }
  },
};

const getContactNotes: ToolEntry = {
  def: {
    name: "get_contact_notes",
    description:
      "Lista as notas mais recentes de um contato (até 50). Se rep precisa de notas mais antigas, peça pra ele abrir no Spark Leads diretamente.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        limit: { type: "number", description: "Max notas (default 30, max 50).", default: 30 },
      },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    // Fix Track 3 HIGH-5 (review 2026-05-05): adicionado limit configurável
    // + meta `truncated` pro LLM saber se há mais notas.
    const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 50);

    try {
      const res = await listNotesOnContact(ctx.ghlClient, contactId);
      const allNotes = res.notes || [];
      if (allNotes.length === 0) {
        return { status: "not_found", message: "Contato sem notas ainda." };
      }
      const notes = allNotes.slice(0, limit);
      return {
        status: "ok",
        data: {
          notes: notes.map((n) => ({
            id: n.id,
            body: n.body,
            author_id: n.userId,
            created_at: n.dateAdded,
          })),
          truncated: allNotes.length > limit,
          total_in_crm: allNotes.length,
          returned: notes.length,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de notas");
    }
  },
};

const getContactTasks: ToolEntry = {
  def: {
    name: "get_contact_tasks",
    description:
      "Lista as tasks de um contato (pendentes e completas, mais recentes primeiro). Default: 30 mais recentes (max 100).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        limit: { type: "number", description: "Default 30, max 100." },
        include_completed: { type: "boolean", description: "Default true. False filtra só pendentes." },
      },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    // Fix Track 3 #12 (review 2026-05-05): limit + meta truncated.
    const limit = Math.min(Math.max(Number(args.limit) || 30, 1), 100);
    const includeCompleted = args.include_completed !== false;

    try {
      const res = await listTasksOnContact(ctx.ghlClient, contactId);
      let allTasks = res.tasks || [];
      if (!includeCompleted) {
        allTasks = allTasks.filter((t) => !t.completed);
      }
      if (allTasks.length === 0) {
        return {
          status: "not_found",
          message: includeCompleted ? "Contato sem tasks." : "Contato sem tasks pendentes.",
        };
      }
      const tasks = allTasks.slice(0, limit);
      return {
        status: "ok",
        data: {
          tasks: tasks.map((t) => ({
            id: t.id,
            title: t.title,
            body: t.body,
            completed: t.completed,
            due_at: t.dueDate,
            assigned_to: t.assignedTo,
          })),
          truncated: allTasks.length > limit,
          total_in_crm: allTasks.length,
          returned: tasks.length,
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de tasks");
    }
  },
};

const getContactAppointments: ToolEntry = {
  def: {
    name: "get_contact_appointments",
    description: "Lista appointments associados a um contato (passados e futuros).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { contact_id: { type: "string" } },
      required: ["contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    try {
      const res = await ghlGetContactAppointments(ctx.ghlClient, contactId);
      return {
        status: "ok",
        data: (res.events || []).map((e) => ({
          id: e.id, title: e.title || "(sem título)",
          start: e.startTime, end: e.endTime,
          status: e.appointmentStatus || "scheduled",
          assigned_to: e.assignedUserId,
          calendar_id: e.calendarId,
        })),
      };
    } catch (err) {
      return ghlErrorToResult(err, "listagem de appointments do contato");
    }
  },
};

// ============================================================
// BIRTHDAYS LOOKUP
// ============================================================
// Pedro 2026-05-06: bot precisa lookup contatos com dateOfBirth = hoje
// (ou janela 'this_week' / 'next_7_days') pra cumprimentar / lembrar rep.
//
// Implementação: POST /contacts/search (V2 — schema oficial vazio, mas
// API aceita filters array). Filter operator 'contains' no campo
// dateOfBirth pra match MM-DD ignorando ano.
// Caso GHL retorne error/0 resultados, NÃO faz fallback expensivo
// (fetch all + filter client-side estoura org grande). Aí bot oferece
// workaround manual ("filtre no Spark Leads por Date of Birth").

const listBirthdaysToday: ToolEntry = {
  def: {
    name: "list_birthdays_today",
    description:
      "Lista contatos com aniversário HOJE (ou janela 'this_week' = próximos 7 dias). Use quando rep pergunta 'quem faz aniversário hoje?', 'aniversariantes da semana', 'quem tá fazendo birthday?'.\n\nPra uso recorrente ('todo dia 8h me manda aniversariantes'), combine com `schedule_message_to_contact` ou (futuro) `create_proactive_rule`.\n\nLimitação: filter é best-effort via Spark Leads search V2 — orgs muito grandes (10k+ contatos) podem ter results parciais. Se a tool retornar warning de truncated, sugira ao rep filtrar manual no Spark Leads (Contacts > Filter > Date of Birth).",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        when: {
          type: "string",
          enum: ["today", "tomorrow", "this_week", "next_7_days"],
          description: "Janela. Default 'today'.",
        },
        limit: {
          type: "number",
          description: "Default 20, max 50.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const when = String(args.when || "today");
    const limit = Math.min(Math.max(Number(args.limit) || 50, 1), 500);

    // Resolve dias-alvo no tz do rep (NY default)
    const repTz =
      (ctx.rep as { timezone?: string | null }).timezone || "America/New_York";
    const fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: repTz,
      month: "2-digit",
      day: "2-digit",
    });
    const todayMMDD = fmt.format(new Date());

    const daysToCheck: string[] = [];
    if (when === "today") {
      daysToCheck.push(todayMMDD);
    } else if (when === "tomorrow") {
      const tomorrow = new Date(Date.now() + 24 * 60 * 60_000);
      daysToCheck.push(fmt.format(tomorrow));
    } else {
      // this_week / next_7_days: próximos 7 dias incluindo hoje
      for (let i = 0; i < 7; i++) {
        const d = new Date(Date.now() + i * 24 * 60 * 60_000);
        daysToCheck.push(fmt.format(d));
      }
    }

    // H27 (review 2026-05-15): refactor pra usar Filter Engine.
    // GHL NÃO suporta filter server-side em dateOfBirth, mas a engine
    // detecta isso via capability matrix e faz pull all + client-side
    // filter automaticamente. Aniversariantes = field 'dateOfBirth' op
    // 'month_day_eq' value 'MM-DD'.
    const repUserId = getRepGhlUserId(ctx);
    const filter: FilterExpression =
      daysToCheck.length === 1
        ? { field: "dateOfBirth", op: "month_day_eq", value: daysToCheck[0] }
        : {
            any: daysToCheck.map((d) => ({
              field: "dateOfBirth" as const,
              op: "month_day_eq" as const,
              value: d,
            })),
          };

    const result = await executeContactsFilter(
      filter,
      {
        rep_id: ctx.rep.id,
        rep_phone: ctx.rep.phone,
        location_id: ctx.locationId,
        company_id: ctx.companyId,
        ghl_client: ctx.ghlClient,
        consumer_tool: "list_birthdays_today",
        rep_aliases: {
          ...(ctx.rep.profile?.aliases || {}),
          ...(repUserId ? { __self_user_id: repUserId } : {}),
        },
      },
      { limit },
    );

    if (result.status !== "ok") {
      return {
        status: "error",
        message: result.message || "erro buscando aniversariantes",
        retryable: result.retryable || false,
      };
    }

    const items = result.items || [];
    if (items.length === 0) {
      return {
        status: "ok",
        data: {
          when,
          days_checked: daysToCheck,
          total: 0,
          contacts: [],
          ...(result.hit_safety_cap
            ? {
                warning:
                  `Cap defensivo atingido (${result.pages_fetched} páginas × 100). Pode haver mais aniversariantes além do scan. ` +
                  `Sugira ao rep filtrar manual no Spark Leads ou usar período menor.`,
              }
            : {}),
        },
      };
    }

    return {
      status: "ok",
      data: {
        when,
        days_checked: daysToCheck,
        total: items.length,
        contacts: items.map((c) => ({
          id: c.id,
          name: c.name,
          phone: c.phone,
          email: c.email,
          date_of_birth: c.dateOfBirth,
          tags: c.tags,
        })),
        complete: result.complete,
        pages_fetched: result.pages_fetched,
        ...(result.hit_safety_cap
          ? { warning: `Scan parou em ${result.pages_fetched} páginas — pode haver mais aniversariantes.` }
          : {}),
      },
    };
  },
};

export const CONTACTS_TOOLS: ToolEntry[] = [
  searchContacts,
  getContact,
  createContact,
  updateContact,
  deleteContact,
  getContactNotes,
  getContactTasks,
  getContactAppointments,
  listBirthdaysToday,
];
