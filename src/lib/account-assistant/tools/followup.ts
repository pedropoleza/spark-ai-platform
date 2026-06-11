/**
 * Tools do chat pra Follow-up Feature (Pedro 2026-05-18).
 *
 * 8 tools:
 *   - create_followup_request (medium) — entry point
 *   - approve_followup (high) — aprova draft pra schedule
 *   - edit_followup (medium) — edita msg/horário de draft/pending
 *   - cancel_followup (high) — cancela sequence
 *   - pause_followup (medium)
 *   - resume_followup (medium)
 *   - list_my_followups (safe)
 *   - get_followup_progress (safe)
 *
 * Todas delegam pro core.ts (followup/core.ts) — chat e webhook futuro
 * compartilham mesma lógica.
 */

import type { ToolEntry } from "./types";
import { validateIso8601 } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePrimaryHub, getEnvHubLocationId } from "@/lib/account-assistant/hub-resolver";
import {
  createFollowupRequest,
  approveSequence,
  cancelSequence,
  pauseSequence,
  resumeSequence,
  editSequence,
} from "../followup/core";
import type {
  FollowupInput,
  FollowupResult,
  SequenceType,
  SequenceSnapshot,
  MessageSnapshot,
} from "../followup/types";

// =====================================================================
// 1. create_followup_request
// =====================================================================
const createFollowupTool: ToolEntry = {
  def: {
    name: "create_followup_request",
    description:
      "🔄 Cria pedido de FOLLOW-UP (mensagem agendada ou sequência de até 3 msgs pra um contato). " +
      "Use SEMPRE que rep falar:\n" +
      "  • 'cria follow-up com X em N dias' / 'me lembra de falar com X sexta'\n" +
      "  • 'manda mensagem pro X amanhã sobre Y'\n" +
      "  • 'faz uma sequência leve pra Y'\n" +
      "  • 'agenda 2-3 follow-ups pro Z'\n" +
      "  • 'follow-up com Ana, ela ia falar com marido'\n\n" +
      "Bot resolve contato (disambiguation se múltiplos), calcula spam_risk, gera mensagens, decide flow:\n" +
      "  → auto_scheduled (risk low + adaptive config) ✅\n" +
      "  → approval_required (risk medium) → MOSTRA preview + pergunta 'Confirma?' → rep responde, AÍ chama approve_followup\n" +
      "  → blocked_high_risk (risk high) → bot sugere internal_reminder\n\n" +
      "Se rep não disser se quer usar conversa pra contexto, tool retorna needs_user_decision — PERGUNTE ao rep, depois RECHAME passando use_conversation_context.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_query: {
          type: "string",
          description: "Nome/phone/id do contato. Resolve com disambiguation se múltiplos.",
        },
        contact_id: {
          type: "string",
          description: "Atalho — se já sabe o id (ex: vindo de turn-context). Tem prioridade sobre contact_query.",
        },
        goal: {
          type: "string",
          description: "O que rep quer alcançar (ex: 'retomar conversa sobre proposta', 'lembrar do encontro M3').",
        },
        manual_context: {
          type: "string",
          description: "Contexto direto fornecido pelo rep (ex: 'ela ia falar com marido', 'fizemos call de qualificação ontem').",
        },
        use_conversation_context: {
          type: "boolean",
          description: "Se true, bot busca + resume últimas conversas. Se false, ignora histórico. OMITA se rep não disse — tool vai retornar needs_user_decision pedindo decisão.",
        },
        requested_at: {
          type: "string",
          description: "Quando primeira msg sai. Aceita ISO 8601 OU 'tomorrow 10:00' OU 'in 3 days' OU 'daqui 2 dias'. Default: agora + 48h.",
        },
        sequence_length: {
          type: "number",
          description: "1-3. Default 2. 1 = simples. 2-3 = sequência.",
        },
        tone: {
          type: "string",
          description: "Opcional. Ex: 'leve', 'direto', 'casual', 'consultivo'.",
        },
        sequence_type: {
          type: "string",
          enum: ["sales", "service", "reschedule", "pos_sale", "internal_reminder", "custom"],
          description: "Default 'sales'. Use 'internal_reminder' SE rep só quer lembrete interno (não manda msg pro contato).",
        },
      },
      required: [],
    },
  },
  handler: async (ctx, args) => {
    const input: FollowupInput = {
      source: "chat",
      rep_id: ctx.rep.id,
      location_id: ctx.locationId,
      agent_id: await resolveAgentId(ctx.locationId),
      contact_id: typeof args.contact_id === "string" ? args.contact_id : undefined,
      contact_query: typeof args.contact_query === "string" ? args.contact_query : undefined,
      goal: typeof args.goal === "string" ? args.goal : undefined,
      manual_context: typeof args.manual_context === "string" ? args.manual_context : undefined,
      use_conversation_context:
        typeof args.use_conversation_context === "boolean" ? args.use_conversation_context : undefined,
      requested_at: typeof args.requested_at === "string" ? args.requested_at : undefined,
      sequence_length: typeof args.sequence_length === "number" ? args.sequence_length : undefined,
      tone: typeof args.tone === "string" ? args.tone : undefined,
      sequence_type: (typeof args.sequence_type === "string" ? args.sequence_type : "sales") as SequenceType,
    };

    const result: FollowupResult = await createFollowupRequest(input, ctx.ghlClient);

    if (!result.ok) {
      if (result.needs_user_decision) {
        return {
          status: "ok",
          data: {
            needs_user_decision: result.needs_user_decision,
            ai_action: "ASK_USER_AND_RETRY",
          },
        };
      }
      if (result.error?.kind === "contact_ambiguous" && result.error.candidates) {
        return {
          status: "ok",
          data: {
            ambiguous_contacts: result.error.candidates,
            ai_action: "ASK_USER_PICK_CONTACT",
          },
        };
      }
      return { status: "error", message: result.error?.message || "erro desconhecido", retryable: false };
    }

    return { status: "ok", data: result };
  },
};

// =====================================================================
// 2. approve_followup
// =====================================================================
const approveFollowupTool: ToolEntry = {
  def: {
    name: "approve_followup",
    description:
      "✅ Aprova um follow-up sequence que estava em draft (pending_approval). Marca status=scheduled — runner pega e envia. " +
      "Use APENAS após rep dizer claramente 'sim' / 'confirma' / 'pode' / 'aprovado' em resposta ao preview retornado por create_followup_request.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        sequence_id: { type: "string", description: "ID da sequence retornado por create_followup_request." },
      },
      required: ["sequence_id"],
    },
  },
  handler: async (ctx, args) => {
    const id = String(args.sequence_id || "");
    if (!id) return { status: "error", message: "sequence_id obrigatório", retryable: false };
    const ok = await verifyOwnership(id, ctx.rep.id, ctx.locationId);
    if (!ok) return { status: "not_found", message: "Sequence não encontrada ou não pertence a você." };
    const r = await approveSequence(id);
    if (!r.ok) return { status: "error", message: r.error || "approve falhou", retryable: false };
    return { status: "ok", data: { sequence_id: id, status: "scheduled" } };
  },
};

// =====================================================================
// 3. cancel_followup
// =====================================================================
const cancelFollowupTool: ToolEntry = {
  def: {
    name: "cancel_followup",
    description:
      "❌ Cancela sequence (draft, scheduled, running ou paused). Recipients pending NÃO serão enviados. " +
      "Use quando rep falar 'cancela o follow-up com X', 'tira o agendamento', 'esquece esse follow-up'.",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        sequence_id: { type: "string" },
        contact_query: {
          type: "string",
          description: "Alternativa ao sequence_id — busca sequence ativa pelo nome/phone do contato.",
        },
        reason: { type: "string", description: "Motivo opcional (vai pro audit)." },
      },
    },
  },
  handler: async (ctx, args) => {
    const seqId = await resolveSeqIdFromArgs(args, ctx.rep.id, ctx.locationId);
    if (!seqId) return { status: "not_found", message: "Sequence não encontrada." };
    const r = await cancelSequence(seqId, String(args.reason || "rep_cancelled"));
    if (!r.ok) return { status: "error", message: r.error || "cancel falhou", retryable: false };
    return { status: "ok", data: { sequence_id: seqId, status: "cancelled" } };
  },
};

// =====================================================================
// 4. pause_followup
// =====================================================================
const pauseFollowupTool: ToolEntry = {
  def: {
    name: "pause_followup",
    description:
      "⏸ Pausa sequence (scheduled/running). Msgs pending NÃO saem até resume_followup. Use quando rep falar 'pausa o follow-up com X', 'segura por enquanto'.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        sequence_id: { type: "string" },
        contact_query: { type: "string" },
      },
    },
  },
  handler: async (ctx, args) => {
    const seqId = await resolveSeqIdFromArgs(args, ctx.rep.id, ctx.locationId);
    if (!seqId) return { status: "not_found", message: "Sequence não encontrada." };
    const r = await pauseSequence(seqId);
    if (!r.ok) return { status: "error", message: r.error || "pause falhou", retryable: false };
    return { status: "ok", data: { sequence_id: seqId, status: "paused" } };
  },
};

// =====================================================================
// 5. resume_followup
// =====================================================================
const resumeFollowupTool: ToolEntry = {
  def: {
    name: "resume_followup",
    description:
      "▶️ Retoma sequence que estava paused. Use quando rep falar 'retoma o follow-up', 'volta o agendamento'.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        sequence_id: { type: "string" },
        contact_query: { type: "string" },
      },
    },
  },
  handler: async (ctx, args) => {
    const seqId = await resolveSeqIdFromArgs(args, ctx.rep.id, ctx.locationId);
    if (!seqId) return { status: "not_found", message: "Sequence não encontrada." };
    const r = await resumeSequence(seqId);
    if (!r.ok) return { status: "error", message: r.error || "resume falhou", retryable: false };
    return { status: "ok", data: { sequence_id: seqId, status: "running" } };
  },
};

// =====================================================================
// 6. edit_followup
// =====================================================================
const editFollowupTool: ToolEntry = {
  def: {
    name: "edit_followup",
    description:
      "✏️ Edita msgs pending de uma sequence. Pode mudar texto ou horário de msg específica (por position). " +
      "Use quando rep falar 'troca o texto da msg 1', 'muda a segunda pra quarta 9h', 'deixa só a primeira'.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        sequence_id: { type: "string" },
        edits: {
          type: "array",
          description: "Lista de edits por position",
          items: {
            type: "object",
            properties: {
              position: { type: "number" },
              new_text: { type: "string" },
              new_scheduled_at: { type: "string", description: "ISO 8601" },
            },
            required: ["position"],
          },
        },
      },
      required: ["sequence_id", "edits"],
    },
  },
  handler: async (ctx, args) => {
    const id = String(args.sequence_id || "");
    if (!id) return { status: "error", message: "sequence_id obrigatório", retryable: false };
    const ok = await verifyOwnership(id, ctx.rep.id, ctx.locationId);
    if (!ok) return { status: "not_found", message: "Sequence não encontrada ou não pertence a você." };
    const edits = Array.isArray(args.edits) ? (args.edits as Array<{ position: number; new_text?: string; new_scheduled_at?: string }>) : [];

    // Paridade c/ schedule_message_to_contact (messages.ts): valida ISO + rejeita
    // passado + normaliza ANTES de gravar. editSequence escrevia new_scheduled_at
    // cru → data inválida ou no passado virava no-op silencioso no followup-runner.
    // Sem upper-bound: igual ao tool irmão.
    for (const edit of edits) {
      if (typeof edit.new_scheduled_at !== "string" || edit.new_scheduled_at === "") continue;
      const dateInvalid = validateIso8601(edit.new_scheduled_at, `horário da msg ${edit.position}`);
      if (dateInvalid) return dateInvalid;
      const iso = new Date(edit.new_scheduled_at).toISOString();
      if (new Date(iso).getTime() < Date.now() - 60 * 1000) {
        return {
          status: "error",
          message: `O horário da msg ${edit.position} está no passado. Use uma data/hora futura.`,
          retryable: false,
        };
      }
      edit.new_scheduled_at = iso; // normaliza pro ISO canônico (igual isoSend no irmão)
    }

    const r = await editSequence(id, { messages: edits });
    return { status: "ok", data: { sequence_id: id, updated_messages: r.updated_messages } };
  },
};

// =====================================================================
// 7. list_my_followups
// =====================================================================
const listMyFollowupsTool: ToolEntry = {
  def: {
    name: "list_my_followups",
    description:
      "📋 Lista follow-up sequences do rep (filter por status opcional). Use quando rep falar 'meus follow-ups', 'lista os follow-ups ativos', 'que follow-ups tenho rodando?'.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        status: {
          type: "string",
          enum: ["all", "active", "draft", "completed", "cancelled"],
          description: "'active' = scheduled/running/paused. Default 'active'.",
        },
        limit: { type: "number", description: "Default 20, max 100." },
      },
    },
  },
  handler: async (ctx, args) => {
    const filter = String(args.status || "active");
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), 100);
    const supabase = createAdminClient();
    let q = supabase
      .from("followup_sequences")
      .select(
        "id, rep_id, location_id, contact_id, contact_name, contact_phone, goal, sequence_type, status, approval_status, spam_risk, spam_score, total_messages, sent_messages, failed_messages, skipped_messages, scheduled_first_at, scheduled_last_at, completed_at, cancelled_at, cancelled_reason, created_at, source",
      )
      .eq("rep_id", ctx.rep.id)
      .eq("location_id", ctx.locationId);

    if (filter === "active") {
      q = q.in("status", ["scheduled", "running", "paused"]);
    } else if (filter !== "all") {
      q = q.eq("status", filter);
    }

    const { data } = await q.order("created_at", { ascending: false }).limit(limit);
    const snapshots: SequenceSnapshot[] = (data || []).map((r) => ({
      sequence_id: r.id,
      rep_id: r.rep_id,
      location_id: r.location_id,
      contact_id: r.contact_id,
      contact_name: r.contact_name,
      contact_phone: r.contact_phone,
      goal: r.goal,
      sequence_type: r.sequence_type,
      status: r.status,
      approval_status: r.approval_status,
      spam_risk: r.spam_risk,
      spam_score: r.spam_score,
      total_messages: r.total_messages,
      sent_messages: r.sent_messages,
      failed_messages: r.failed_messages,
      skipped_messages: r.skipped_messages,
      scheduled_first_at: r.scheduled_first_at,
      scheduled_last_at: r.scheduled_last_at,
      completed_at: r.completed_at,
      cancelled_at: r.cancelled_at,
      cancelled_reason: r.cancelled_reason,
      created_at: r.created_at,
      source: r.source,
    }));

    return {
      status: "ok",
      data: {
        count: snapshots.length,
        sequences: snapshots,
      },
    };
  },
};

// =====================================================================
// 8. get_followup_progress
// =====================================================================
const getFollowupProgressTool: ToolEntry = {
  def: {
    name: "get_followup_progress",
    description:
      "📊 Detalhe completo de uma sequence: msgs (preview + status + scheduled_at), events (audit). Use quando rep falar 'como tá o follow-up com X?', 'progresso da sequência Y'.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        sequence_id: { type: "string" },
        contact_query: { type: "string" },
      },
    },
  },
  handler: async (ctx, args) => {
    const seqId = await resolveSeqIdFromArgs(args, ctx.rep.id, ctx.locationId);
    if (!seqId) return { status: "not_found", message: "Sequence não encontrada." };
    const supabase = createAdminClient();
    const [{ data: seq }, { data: msgs }, { data: events }] = await Promise.all([
      supabase.from("followup_sequences").select("*").eq("id", seqId).maybeSingle(),
      supabase
        .from("followup_messages")
        .select("id, position, message_text, scheduled_at, status, sent_at, error_message")
        .eq("sequence_id", seqId)
        .order("position"),
      supabase
        .from("followup_events")
        .select("event_type, event_data, created_at")
        .eq("sequence_id", seqId)
        .order("created_at", { ascending: false })
        .limit(20),
    ]);
    if (!seq) return { status: "not_found", message: "Sequence não encontrada." };

    const messageSnapshots: MessageSnapshot[] = (msgs || []).map((m) => ({
      id: m.id,
      position: m.position,
      text: m.message_text,
      scheduled_at: m.scheduled_at,
      status: m.status,
      sent_at: m.sent_at,
      error_message: m.error_message,
    }));

    return {
      status: "ok",
      data: {
        sequence: seq,
        messages: messageSnapshots,
        events: events || [],
      },
    };
  },
};

// =====================================================================
// Helpers
// =====================================================================
async function resolveAgentId(locationId: string): Promise<string | null> {
  const supabase = createAdminClient();
  // tenta agent na própria location
  const { data: directAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", locationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  if (directAgent?.id) return directAgent.id;
  // H29 2026-05-20: fallback via hub-resolver (DB-first) em vez de env direto
  const hubEntry = await resolvePrimaryHub();
  if (hubEntry?.agentId) return hubEntry.agentId;
  const hubLoc = hubEntry?.locationId ?? getEnvHubLocationId();
  if (hubLoc) {
    const { data: hubAgent } = await supabase
      .from("agents")
      .select("id")
      .eq("location_id", hubLoc)
      .eq("type", "account_assistant")
      .eq("status", "active")
      .maybeSingle();
    return hubAgent?.id ?? null;
  }
  return null;
}

async function verifyOwnership(
  sequenceId: string,
  repId: string,
  locationId: string,
): Promise<boolean> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("followup_sequences")
    .select("id")
    .eq("id", sequenceId)
    .eq("rep_id", repId)
    .eq("location_id", locationId)
    .maybeSingle();
  return !!data;
}

async function resolveSeqIdFromArgs(
  args: Record<string, unknown>,
  repId: string,
  locationId: string,
): Promise<string | null> {
  if (typeof args.sequence_id === "string" && args.sequence_id.length > 0) {
    const ok = await verifyOwnership(args.sequence_id, repId, locationId);
    return ok ? args.sequence_id : null;
  }
  if (typeof args.contact_query === "string" && args.contact_query.trim().length > 0) {
    // C4-P2-1 (ultra-review 2026-05-26): sanitiza chars que quebram/distorcem a
    // sintaxe do PostgREST .or() (vírgula = separador, () = grupo, % * = wildcard
    // ilike, \ = escape). NÃO é cross-tenant (eq rep_id+location_id em AND antes),
    // mas evita filtro malformado / wildcard injetado no próprio escopo do rep.
    const safeQuery = args.contact_query.replace(/[,()%*\\]/g, "").trim();
    if (!safeQuery) return null;
    const supabase = createAdminClient();
    const { data } = await supabase
      .from("followup_sequences")
      .select("id")
      .eq("rep_id", repId)
      .eq("location_id", locationId)
      .in("status", ["draft", "scheduled", "running", "paused"])
      .or(`contact_name.ilike.%${safeQuery}%,contact_phone.ilike.%${safeQuery}%`)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    return data?.id ?? null;
  }
  return null;
}

// =====================================================================
// Export
// =====================================================================
export const FOLLOWUP_TOOLS: ToolEntry[] = [
  createFollowupTool,
  approveFollowupTool,
  cancelFollowupTool,
  pauseFollowupTool,
  resumeFollowupTool,
  editFollowupTool,
  listMyFollowupsTool,
  getFollowupProgressTool,
];
