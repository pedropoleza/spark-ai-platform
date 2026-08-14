/**
 * Resumos de reunião (Fathom) — ponte de leitura com o Spark OS (H77, 2026-08-14).
 *
 * Caso Guilherme (review 30/07–13/08): o rep pedia "põe o resumo do Fathom nas
 * notas" e o bot NEGAVA a integração — que existia e tinha entregue nota naquele
 * mesmo dia. O que faltava era VISIBILIDADE: a nota entregue o bot acha via
 * get_contact_notes, mas o resumo preso em 'review' (reunião que o pipeline não
 * conseguiu casar com um contato — decisão deliberada de nunca chutar) era
 * invisível de fora. Estas tools falam com as portas /api/ingest/meetings/* do
 * Spark OS (bearer da fonte 'sparkbot', mesmo contrato do transporte H57).
 */

import type { ToolEntry } from "./types";
import { validateGhlId } from "./types";

const TIMEOUT_MS = 12_000;

/** Deriva a base do OS da mesma env do transporte (SPARK_OS_WA_URL é a URL
 *  completa da porta de envio; o origin é o mesmo pras portas de meetings). */
function osEndpoint(path: string): { url: string; token: string } | null {
  const sendUrl = process.env.SPARK_OS_WA_URL?.trim();
  const token = process.env.SPARK_OS_WA_TOKEN?.trim();
  if (!sendUrl || !token) return null;
  try {
    return { url: `${new URL(sendUrl).origin}${path}`, token };
  } catch {
    return null;
  }
}

async function postOs(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> } | { configError: string }> {
  const ep = osEndpoint(path);
  if (!ep) {
    return { configError: "Ponte com o Spark OS não configurada (SPARK_OS_WA_URL/SPARK_OS_WA_TOKEN)." };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(ep.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${ep.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

const getMeetingSummaries: ToolEntry = {
  def: {
    name: "get_meeting_summaries",
    description:
      "Lista os resumos de reunião do Fathom que chegaram pra esta conta (últimos dias), com o " +
      "status de cada um: `delivered` = o resumo JÁ virou nota no contato indicado (não precisa " +
      "salvar de novo); `review` = o resumo CHEGOU mas o sistema não conseguiu identificar de " +
      "qual contato era a reunião (pending_reason explica) — ofereça salvar com " +
      "attach_meeting_summary depois de confirmar o contato com o rep. USE quando o rep " +
      "perguntar 'o Fathom pegou a reunião?', 'cadê o resumo da call de ontem?', 'o resumo não " +
      "apareceu nas notas'. Se vier lista vazia, esta conta provavelmente não tem a integração " +
      "ligada — aí sim diga isso (nunca negue sem checar). Filtre por contact_id só quando o rep " +
      "nomear o contato E você já tiver o id validado.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        days: {
          type: "number",
          description: "Janela de busca em dias (1-30, default 7).",
        },
        contact_id: {
          type: "string",
          description: "OPCIONAL: filtra resumos já entregues a este contato (id do Spark Leads).",
        },
      },
      required: [],
    },
  },
  handler: async (ctx, args) => {
    const days = Math.min(30, Math.max(1, Number(args.days) || 7));
    const contactId = args.contact_id ? String(args.contact_id).trim() : null;
    if (contactId) {
      const invalid = validateGhlId(contactId, "contact");
      if (invalid) return invalid;
    }

    const res = await postOs("/api/ingest/meetings/summaries", {
      location_id: ctx.locationId,
      days,
      ...(contactId ? { contact_id: contactId } : {}),
    }).catch((err) => ({ configError: err instanceof Error ? err.message : String(err) }));

    if ("configError" in res) {
      return { status: "error", message: res.configError, retryable: false };
    }
    if (!res.ok) {
      return {
        status: "error",
        message: `Consulta de resumos falhou (${res.status}): ${String(res.data.error ?? "erro no Spark OS")}`,
        retryable: res.status >= 500,
      };
    }

    const summaries = Array.isArray(res.data.summaries) ? res.data.summaries : [];
    const entregues = summaries.filter((s) => (s as { status?: string }).status === "delivered").length;
    const pendentes = summaries.filter((s) => (s as { status?: string }).status === "review").length;
    return {
      status: "ok",
      data: {
        days,
        total: summaries.length,
        delivered: entregues,
        in_review: pendentes,
        summaries,
        note:
          summaries.length === 0
            ? "Nenhum resumo do Fathom nesta janela. Ou não houve reunião gravada, ou a integração não está ligada nesta conta."
            : "delivered = já está nas notas do contato (contact_name/note_id). review = chegou sem contato identificado — confirme com o rep de quem era a reunião e use attach_meeting_summary.",
      },
    };
  },
};

const attachMeetingSummary: ToolEntry = {
  def: {
    name: "attach_meeting_summary",
    description:
      "Salva um resumo do Fathom que está pendente (status `review` no get_meeting_summaries) " +
      "como nota no contato indicado. ANTES de chamar: (1) resolva o contato via search_contacts " +
      "e (2) confirme com o rep nome + reunião ('salvo o resumo de \"<título>\" no contato " +
      "<nome>?') — nota no contato errado não dá pra desfazer daqui. Idempotente: repetir com o " +
      "mesmo contato não duplica a nota. Se o resumo já foi entregue a OUTRO contato, retorna " +
      "erro (não sobrescreve).",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        summary_id: {
          type: "string",
          description: "id do resumo (campo `id` retornado por get_meeting_summaries).",
        },
        contact_id: {
          type: "string",
          description: "Contato do Spark Leads que vai receber a nota (id já validado via search_contacts/get_contact).",
        },
      },
      required: ["summary_id", "contact_id"],
    },
  },
  handler: async (ctx, args) => {
    const summaryId = String(args.summary_id || "").trim();
    const contactId = String(args.contact_id || "").trim();
    if (!summaryId) return { status: "error", message: "summary_id obrigatório", retryable: false };
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;

    const res = await postOs("/api/ingest/meetings/attach", {
      location_id: ctx.locationId,
      event_id: summaryId,
      contact_id: contactId,
    }).catch((err) => ({ configError: err instanceof Error ? err.message : String(err) }));

    if ("configError" in res) {
      return { status: "error", message: res.configError, retryable: false };
    }
    if (!res.ok) {
      const msg = String(res.data.error ?? "erro no Spark OS");
      return {
        status: "error",
        message:
          res.status === 409
            ? `Esse resumo já foi salvo em outro contato: ${msg}. Não sobrescrevo — confira com o rep.`
            : `Attach falhou (${res.status}): ${msg}`,
        retryable: res.status >= 500,
      };
    }

    return {
      status: "ok",
      data: {
        note_id: res.data.note_id ?? null,
        contact_name: res.data.contact_name ?? null,
        already_saved: res.data.already === true,
        message:
          res.data.already === true
            ? "Esse resumo já estava salvo nesse contato — nada a refazer."
            : "Resumo salvo como nota no contato. Narre a partir de contact_name.",
      },
    };
  },
};

export const MEETING_SUMMARY_TOOLS: ToolEntry[] = [getMeetingSummaries, attachMeetingSummary];
