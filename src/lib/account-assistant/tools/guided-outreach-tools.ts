/**
 * Tools do Acompanhamento Guiado (outreach 1-por-vez) — FORGE-3 2026-05-21.
 *
 * Fluxo: rep quer falar com uma LISTA → start_guided_outreach (abre sessão) →
 * pra cada contato o bot rascunha + present_options [Confirmar/Editar/Pular] →
 * outreach_decision aplica (confirm dispara + avança). "manda tudo" →
 * send_all_remaining_outreach. Tudo gated por GUIDED_OUTREACH_ENABLED.
 *
 * Envio reusa o caminho TESTADO `outbound_to_contact` (assistant_scheduled_tasks
 * → runner envia ao contato). 'now' = next_run_at=agora (sai em ≤30s); 'scheduled'
 * = escalonado (+2min por contato).
 */

import type { ToolEntry, ToolContext } from "./types";
import { getRepGhlUserId } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePrimaryHub } from "../hub-resolver";
import {
  executeContactsFilter,
  type FilterExpression,
  type FilterExecutionContext,
} from "../filter-engine";
import {
  isGuidedOutreachEnabled,
  createGuidedSession,
  getActiveSession,
  getCurrentItem,
  markItem,
  completeIfDone,
  cancelActiveSession,
  getPendingItems,
  getSessionProgress,
  staggeredAt,
  type NewContact,
  type GuidedItem,
} from "../proactive/guided-outreach";

const MAX_LIST = 200;

function toEngineCtx(ctx: ToolContext, consumer: string): FilterExecutionContext {
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

const OFF_MSG = {
  status: "error" as const,
  message: "O Acompanhamento Guiado ainda não está ligado nesta conta.",
  retryable: false,
};

/** Insere um envio pro CONTATO via o caminho outbound_to_contact (runner envia). */
async function enqueueOutboundToContact(args: {
  repId: string;
  locationId: string;
  contactId: string;
  message: string;
  channel: string;
  runAtISO: string;
}): Promise<boolean> {
  const sb = createAdminClient();
  const { error } = await sb.from("assistant_scheduled_tasks").insert({
    rep_id: args.repId,
    location_id: args.locationId,
    task_type: "outbound_to_contact",
    task_payload: {
      contact_id: args.contactId,
      message: args.message,
      channel: args.channel,
      source: "guided_outreach",
      scheduled_by_rep_id: args.repId,
    },
    next_run_at: args.runAtISO,
    delivery_channel: "whatsapp",
    status: "pending",
  });
  if (error) console.warn("[guided] enqueue outbound falhou:", error.message);
  return !error;
}

function progressLine(p: { total: number; sent: number; skipped: number; pending: number }): string {
  return `${p.sent} enviados · ${p.skipped} pulados · ${p.pending} restantes (de ${p.total})`;
}

// =====================================================================
// 1. start_guided_outreach
// =====================================================================
const startGuidedOutreach: ToolEntry = {
  def: {
    name: "start_guided_outreach",
    description:
      "Abre um ACOMPANHAMENTO GUIADO: mandar mensagem pra uma LISTA de contatos UM POR VEZ (você rascunha, o rep confirma/edita/pula cada um). Use quando o rep quer 'fazer o acompanhamento da M0', 'falar com cada um da lista X', 'mandar mensagem pros leads de prova agendada' etc. Passe o `filter` (FEL, mesma DSL do get_contacts_filtered) pra resolver a lista. Depois de abrir, RASCUNHE a mensagem do PRIMEIRO contato e mostre via present_options [Confirmar ✅ / Editar ✏️ / Pular ⏭️]. NÃO tente resumir/mandar todos de uma vez — é 1 por vez (rápido, não trava).",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        filter: { type: "object", description: "FEL pra resolver a lista de contatos (mesma DSL do get_contacts_filtered)." },
        goal: { type: "string", description: "Objetivo/contexto do acompanhamento (ex: 'M0 — perguntar se agendou a prova'). Guia o rascunho das mensagens." },
        send_mode: { type: "string", enum: ["now", "scheduled"], description: "now = envia ao confirmar (sai em segundos). scheduled = agenda (precisa schedule_at). Default now." },
        schedule_at: { type: "string", description: "ISO 8601 da âncora se send_mode=scheduled (ex: amanhã 9h). Os contatos são escalonados +2min cada." },
      },
      required: ["filter"],
    },
  },
  handler: async (ctx, args) => {
    if (!isGuidedOutreachEnabled()) return OFF_MSG;

    // Já tem sessão ativa? Oferece retomar/cancelar (não abre outra).
    const existing = await getActiveSession(ctx.rep.id);
    if (existing) {
      const cur = await getCurrentItem(existing.id);
      const prog = await getSessionProgress(existing.id);
      return {
        status: "ok",
        data: {
          already_active: true,
          message: `Você já tem um acompanhamento em andamento (${progressLine(prog)}).`,
          current_contact: cur ? { contact_id: cur.contact_id, name: cur.contact_name } : null,
          hint: "Retome de onde parou, ou diga 'cancela o acompanhamento' pra começar outro.",
        },
      };
    }

    const filter = args.filter as FilterExpression | undefined;
    if (!filter || typeof filter !== "object") {
      return { status: "error", message: "Param 'filter' (FEL) obrigatório pra montar a lista.", retryable: false };
    }
    const sendMode = args.send_mode === "scheduled" ? "scheduled" : "now";
    const scheduleAt = sendMode === "scheduled" ? String(args.schedule_at || "") : null;
    if (sendMode === "scheduled" && !scheduleAt) {
      return { status: "error", message: "send_mode=scheduled precisa de schedule_at (ISO). Pergunte ao rep quando enviar.", retryable: false };
    }

    const result = await executeContactsFilter(filter, toEngineCtx(ctx, "start_guided_outreach"), { limit: MAX_LIST });
    if (result.status !== "ok") {
      return { status: "error", message: result.message || "Filter Engine erro ao montar a lista.", retryable: result.retryable || false };
    }
    const items = result.items || [];
    if (items.length === 0) {
      return { status: "not_found", message: "Nenhum contato bate esse filtro — nada pra acompanhar." };
    }

    const contacts: NewContact[] = items.slice(0, MAX_LIST).map((raw) => {
      const c = raw as unknown as Record<string, unknown>;
      return {
        contact_id: String(c.id ?? c.contact_id ?? ""),
        contact_name: ((c.name as string) || (c.firstName as string)) ?? null,
        contact_phone: (c.phone as string) ?? null,
      };
    });

    const hub = await resolvePrimaryHub();
    const agentId = hub?.agentId || "";
    if (!agentId) {
      return { status: "error", message: "Não consegui resolver o agente pra abrir o acompanhamento.", retryable: true };
    }

    const created = await createGuidedSession({
      repId: ctx.rep.id,
      locationId: ctx.locationId,
      agentId,
      goal: args.goal ? String(args.goal) : null,
      sendMode,
      scheduleAnchorAt: scheduleAt,
      contacts,
    });
    if (!created) return { status: "error", message: "Falha ao abrir o acompanhamento.", retryable: true };

    const first = created.first;
    return {
      status: "ok",
      data: {
        started: true,
        total: created.session.total,
        send_mode: sendMode,
        capped: items.length > MAX_LIST ? MAX_LIST : null,
        first_contact: first
          ? { position: first.position, contact_id: first.contact_id, name: first.contact_name, phone: first.contact_phone }
          : null,
        instruction:
          "Rascunhe a mensagem pro first_contact (curta, no objetivo) e mostre com present_options: opções 'Confirmar ✅' (id confirm), 'Editar ✏️' (id edit), 'Pular ⏭️' (id skip). Mostre o progresso [1/" + created.session.total + "].",
      },
    };
  },
};

// =====================================================================
// 2. outreach_decision (confirm | skip)
// =====================================================================
const outreachDecision: ToolEntry = {
  def: {
    name: "outreach_decision",
    description:
      "Aplica a decisão do rep no contato ATUAL do acompanhamento guiado. action='confirm' → dispara `message` pro contato e vai pro próximo. action='skip' → pula sem enviar. Editar = chame com action='confirm' e `message` = o texto que o rep reescreveu. SEMPRE passe `message` no confirm (o que você propôs ou o que o rep editou). Depois, RASCUNHE a msg do PRÓXIMO contato (vem em next_contact) e mostre o present_options de novo. Se next_contact vier null, acabou — comemore o resumo.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["confirm", "skip"], description: "confirm = envia; skip = pula." },
        message: { type: "string", description: "No confirm: a mensagem a enviar pro contato (proposta ou editada pelo rep)." },
      },
      required: ["action"],
    },
  },
  handler: async (ctx, args) => {
    if (!isGuidedOutreachEnabled()) return OFF_MSG;
    const action = args.action === "skip" ? "skip" : "confirm";

    const session = await getActiveSession(ctx.rep.id);
    if (!session) return { status: "error", message: "Não há acompanhamento ativo. Quer começar um?", retryable: false };

    const current = await getCurrentItem(session.id);
    if (!current) {
      await completeIfDone(session.id);
      const prog = await getSessionProgress(session.id);
      return { status: "ok", data: { done: true, message: `Acompanhamento concluído! ${progressLine(prog)}` } };
    }

    if (action === "confirm") {
      const message = String(args.message || "").trim();
      if (!message) {
        return { status: "error", message: "Pra confirmar preciso da mensagem (o que enviar pro contato).", retryable: false };
      }
      // Calcula horário: 'now' = agora; 'scheduled' = âncora + (já enviados)*2min.
      const prog = await getSessionProgress(session.id);
      const runAtISO =
        session.send_mode === "scheduled" && session.schedule_anchor_at
          ? staggeredAt(session.schedule_anchor_at, prog.sent, 2)
          : new Date().toISOString();
      const ok = await enqueueOutboundToContact({
        repId: ctx.rep.id,
        locationId: ctx.locationId,
        contactId: current.contact_id,
        message,
        channel: "SMS",
        runAtISO,
      });
      if (!ok) return { status: "error", message: "Falha ao enfileirar o envio. Tenta de novo?", retryable: true };
      await markItem(current.id, "sent", message);
    } else {
      await markItem(current.id, "skipped");
    }

    const next = await getCurrentItem(session.id);
    const prog = await getSessionProgress(session.id);
    if (!next) {
      await completeIfDone(session.id);
      return {
        status: "ok",
        data: {
          done: true,
          decided: action,
          message: `Pronto! Acabou o acompanhamento. ${progressLine(prog)}`,
        },
      };
    }
    return {
      status: "ok",
      data: {
        done: false,
        decided: action,
        progress: progressLine(prog),
        next_contact: { position: next.position, contact_id: next.contact_id, name: next.contact_name, phone: next.contact_phone },
        instruction: `Rascunhe a msg pro next_contact e mostre o present_options [Confirmar/Editar/Pular] com o progresso [${next.position}/${prog.total}].`,
      },
    };
  },
};

// =====================================================================
// 3. send_all_remaining_outreach (Modo B — manda tudo)
// =====================================================================
const sendAllRemainingOutreach: ToolEntry = {
  def: {
    name: "send_all_remaining_outreach",
    description:
      "Modo 'manda tudo de uma vez': dispara pro RESTANTE da lista do acompanhamento guiado, usando um template de mensagem. Use SÓ quando o rep pedir explicitamente ('manda pra todos', 'envia o resto de uma vez') e DEPOIS de confirmar com ele (present_options). `message_template` pode usar {first_name}. Os envios são escalonados.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        message_template: { type: "string", description: "Mensagem pros restantes. Pode usar {first_name} (interpola o primeiro nome do contato)." },
      },
      required: ["message_template", "confirmed_by_rep"],
    },
  },
  handler: async (ctx, args) => {
    if (!isGuidedOutreachEnabled()) return OFF_MSG;
    const session = await getActiveSession(ctx.rep.id);
    if (!session) return { status: "error", message: "Não há acompanhamento ativo.", retryable: false };
    const tpl = String(args.message_template || "").trim();
    if (!tpl) return { status: "error", message: "Preciso do message_template.", retryable: false };

    const pending = await getPendingItems(session.id);
    if (pending.length === 0) {
      await completeIfDone(session.id);
      return { status: "ok", data: { done: true, message: "Não tinha mais ninguém pendente." } };
    }

    const baseSent = (await getSessionProgress(session.id)).sent;
    let sent = 0;
    for (let i = 0; i < pending.length; i++) {
      const it: GuidedItem = pending[i];
      const firstName = (it.contact_name || "").trim().split(/\s+/)[0] || "";
      const msg = tpl.replace(/\{first_name\}/gi, firstName).replace(/\{name\}/gi, it.contact_name || firstName);
      const runAtISO =
        session.send_mode === "scheduled" && session.schedule_anchor_at
          ? staggeredAt(session.schedule_anchor_at, baseSent + sent, 2)
          : staggeredAt(new Date().toISOString(), sent, 1); // escalona 1min mesmo no 'now' pra não floodar
      const ok = await enqueueOutboundToContact({
        repId: ctx.rep.id,
        locationId: ctx.locationId,
        contactId: it.contact_id,
        message: msg,
        channel: "SMS",
        runAtISO,
      });
      if (ok) {
        await markItem(it.id, "sent", msg);
        sent++;
      }
    }
    await completeIfDone(session.id);
    const prog = await getSessionProgress(session.id);
    return { status: "ok", data: { done: true, sent_now: sent, message: `Disparado pro restante! ${progressLine(prog)}` } };
  },
};

// =====================================================================
// 4. cancel_guided_outreach
// =====================================================================
const cancelGuidedOutreach: ToolEntry = {
  def: {
    name: "cancel_guided_outreach",
    description: "Cancela o acompanhamento guiado ativo do rep (o que já foi enviado permanece; só para o fluxo). Use quando o rep diz 'cancela o acompanhamento', 'para por aqui', 'deixa pra depois'.",
    risk: "medium",
    parameters: { type: "object", properties: {} },
  },
  handler: async (ctx) => {
    if (!isGuidedOutreachEnabled()) return OFF_MSG;
    const cancelled = await cancelActiveSession(ctx.rep.id);
    if (!cancelled) return { status: "ok", data: { message: "Não havia acompanhamento ativo." } };
    const prog = await getSessionProgress(cancelled.id);
    return { status: "ok", data: { cancelled: true, message: `Acompanhamento cancelado. ${progressLine(prog)}` } };
  },
};

export const GUIDED_OUTREACH_TOOLS: ToolEntry[] = [
  startGuidedOutreach,
  outreachDecision,
  sendAllRemainingOutreach,
  cancelGuidedOutreach,
];
