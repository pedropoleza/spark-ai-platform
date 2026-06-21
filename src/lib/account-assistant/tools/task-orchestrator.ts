/**
 * Tools do Motor de Orquestração de Tarefas (Pedro 2026-06-20).
 * Plano: _planning/jussara-sparkbot/EXECUCAO.md (F1).
 *
 * Wrappers FINOS sobre task-orchestrator/core.ts. O bot MONTA um fluxo de N passos
 * num rascunho PERSISTENTE (não "lembra"): a cada turno relê via show_draft e edita
 * via os mutators, que devolvem o ESTADO REAL. Registradas atrás de
 * isTaskOrchestratorEnabled() em tools/index.ts (default OFF).
 *
 * REGRA pro LLM (reforçada nas descriptions): afirme ao rep SÓ o que vier no
 * snapshot retornado. Nunca diga "adicionei/o passo X é Y" de cabeça.
 */
import { type ToolEntry, type ToolContext, validateGhlId, ghlErrorToResult } from "./types";
import type { ToolResult } from "@/types/account-assistant";
import { sendMediaToContact, type GhlChannel } from "@/lib/ghl/operations";
import {
  startDraft,
  showDraft,
  addStep,
  editStep,
  removeStep,
  setMeta,
  resolveDraft,
  resolveDraftAny,
  buildSnapshot,
  type DraftSnapshot,
} from "../task-orchestrator/core";
import { materializeDraft, getDraftProgress, applyFlowToContacts, type ContactTarget } from "../task-orchestrator/materializer";
import { generateAndUploadFlowPdf } from "../task-orchestrator/flow-pdf";
import type { TaskKind } from "../task-orchestrator/config";

function ok(snapshot: DraftSnapshot, extra?: Record<string, unknown>): ToolResult {
  return { status: "ok", data: { ...snapshot, ...(extra || {}) } };
}
function err(message: string): ToolResult {
  return { status: "error", message, retryable: false };
}
function asInt(v: unknown): number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : undefined;
}
function asStr(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s.length ? s : undefined;
}

const startTaskDraft: ToolEntry = {
  def: {
    name: "start_task_draft",
    description:
      "Inicia (ou RETOMA) um rascunho persistente de uma tarefa de múltiplos passos — ex: um FLUXO DE FOLLOW-UP " +
      "de N dias pra um contato. O rascunho fica salvo no banco e sobrevive à conversa: você monta aos poucos, " +
      "ao longo de vários turnos, SEM perder o início. Use quando o rep disser 'monta um fluxo', 'sequência de " +
      "follow-up', 'cria um fluxo de no-show', etc. Se já existe um rascunho ativo do mesmo tipo, ele é retomado " +
      "(não duplica). Depois use add_step pra cada mensagem. SEMPRE trabalhe a partir do snapshot retornado.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        kind: { type: "string", enum: ["followup_sequence", "file_export", "campaign"], description: "Tipo da tarefa. Default 'followup_sequence'." },
        title: { type: "string", description: "Rótulo humano (ex 'Fluxo no-show seguro de vida')." },
        contact_name: { type: "string", description: "Nome do contato alvo, se já souber." },
        contact_id: { type: "string", description: "ID do contato no Spark Leads, se já resolvido." },
        contact_phone: { type: "string", description: "Telefone do contato alvo, se souber." },
      },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const res = await startDraft(ctx.rep.id, ctx.locationId, null, {
      kind: asStr(args.kind) as TaskKind | undefined,
      title: asStr(args.title) ?? null,
      target: {
        contact_id: asStr(args.contact_id),
        contact_name: asStr(args.contact_name),
        contact_phone: asStr(args.contact_phone),
      },
    });
    return res.ok ? ok(res.snapshot, res.note ? { note: res.note } : undefined) : err(res.error);
  },
};

const showDraftTool: ToolEntry = {
  def: {
    name: "show_draft",
    description:
      "Mostra o estado REAL do rascunho de tarefa ativo (todos os passos numerados, o alvo, o status e o que " +
      "ainda falta). CHAME ISTO no INÍCIO de cada turno em que for mexer no fluxo, pra reancorar no que está " +
      "salvo — não confie na sua memória da conversa. É read-only.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { draft_id: { type: "string", description: "Opcional. Se omitido, usa o rascunho ativo do rep." } },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const res = await showDraft(ctx.rep.id, asStr(args.draft_id));
    return res.ok ? ok(res.snapshot) : err(res.error);
  },
};

const addStepTool: ToolEntry = {
  def: {
    name: "add_step",
    description:
      "Adiciona UMA mensagem (passo) ao rascunho de fluxo ativo. Cada passo tem: offset_days (em quantos dias do " +
      "início ela sai — Dia 0 = imediato), send_time opcional ('HH:MM'), o texto, e mídia opcional (link de " +
      "vídeo/imagem). O passo precisa ter texto OU mídia. A ORDEM do fluxo é dada pelo offset_days (não pela ordem " +
      "de criação). Devolve o fluxo recomputado — confirme ao rep a partir DELE.",
    risk: "medium",
    parameters: {
      type: "object",
      required: ["offset_days"],
      properties: {
        offset_days: { type: "integer", description: "Dias a partir do início (0 = imediato, 2 = daqui 2 dias)." },
        message_text: { type: "string", description: "Texto da mensagem (pode usar [nome] pra personalizar)." },
        send_time: { type: "string", description: "Hora local 'HH:MM' (opcional; default da conta)." },
        media_url: { type: "string", description: "Link de vídeo/imagem a anexar (opcional)." },
        media_type: { type: "string", description: "'image' | 'video' | 'application/pdf' (opcional)." },
        intra_day_delay_s: { type: "integer", description: "Segundos após a 1a msg do mesmo dia (multi-msg/dia; default 0)." },
        send_condition: { type: "string", description: "Condição opcional (ex 'se não respondeu'). MVP usa pause-on-reply global." },
        draft_id: { type: "string", description: "Opcional; usa o rascunho ativo se omitido." },
      },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const res = await addStep(ctx.rep.id, asStr(args.draft_id), {
      offset_days: asInt(args.offset_days),
      message_text: asStr(args.message_text) ?? "",
      send_time: asStr(args.send_time) ?? null,
      media_url: asStr(args.media_url) ?? null,
      media_type: asStr(args.media_type) ?? null,
      intra_day_delay_s: asInt(args.intra_day_delay_s),
      send_condition: asStr(args.send_condition) ?? null,
    });
    return res.ok ? ok(res.snapshot) : err(res.error);
  },
};

const editStepTool: ToolEntry = {
  def: {
    name: "edit_step",
    description:
      "Edita um passo do fluxo pelo NÚMERO dele (o 'n' que aparece no snapshot). Passe só os campos que mudam " +
      "(texto, offset_days, send_time, mídia...). 'Move o dia 5 pro 6' = edit_step com novo offset_days. Devolve " +
      "o fluxo recomputado.",
    risk: "medium",
    parameters: {
      type: "object",
      required: ["step_number"],
      properties: {
        step_number: { type: "integer", description: "Número do passo no snapshot (1-based)." },
        message_text: { type: "string" },
        offset_days: { type: "integer" },
        send_time: { type: "string" },
        media_url: { type: "string" },
        media_type: { type: "string" },
        intra_day_delay_s: { type: "integer" },
        send_condition: { type: "string" },
        draft_id: { type: "string" },
      },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const n = asInt(args.step_number);
    if (n === undefined) return err("step_number obrigatório (o número do passo no snapshot).");
    const patch: Record<string, unknown> = {};
    if (args.message_text !== undefined) patch.message_text = asStr(args.message_text) ?? "";
    if (args.offset_days !== undefined) patch.offset_days = asInt(args.offset_days);
    if (args.send_time !== undefined) patch.send_time = asStr(args.send_time) ?? null;
    if (args.media_url !== undefined) patch.media_url = asStr(args.media_url) ?? null;
    if (args.media_type !== undefined) patch.media_type = asStr(args.media_type) ?? null;
    if (args.intra_day_delay_s !== undefined) patch.intra_day_delay_s = asInt(args.intra_day_delay_s);
    if (args.send_condition !== undefined) patch.send_condition = asStr(args.send_condition) ?? null;
    const res = await editStep(ctx.rep.id, asStr(args.draft_id), n, patch);
    return res.ok ? ok(res.snapshot) : err(res.error);
  },
};

const removeStepTool: ToolEntry = {
  def: {
    name: "remove_step",
    description: "Remove um passo do fluxo pelo NÚMERO (n do snapshot). Devolve o fluxo recomputado.",
    risk: "medium",
    parameters: {
      type: "object",
      required: ["step_number"],
      properties: {
        step_number: { type: "integer", description: "Número do passo no snapshot (1-based)." },
        draft_id: { type: "string" },
      },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const n = asInt(args.step_number);
    if (n === undefined) return err("step_number obrigatório.");
    const res = await removeStep(ctx.rep.id, asStr(args.draft_id), n);
    return res.ok ? ok(res.snapshot) : err(res.error);
  },
};

const setTaskMetaTool: ToolEntry = {
  def: {
    name: "set_task_meta",
    description:
      "Define os dados do fluxo: o ALVO (contato ou tag) e/ou o título, e pode marcar o fluxo como 'pronto pra " +
      "revisão' (mark_ready) quando o rep terminar de montar. Devolve o fluxo recomputado.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        title: { type: "string" },
        contact_id: { type: "string" },
        contact_name: { type: "string" },
        contact_phone: { type: "string" },
        tag: { type: "string", description: "Tag alvo (ex 'no-show') — pra aplicar o fluxo a quem tiver a tag (fase futura)." },
        mark_ready: { type: "boolean", description: "true quando o rep terminar de montar (marca ready_for_review)." },
        draft_id: { type: "string" },
      },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const res = await setMeta(ctx.rep.id, asStr(args.draft_id), {
      title: asStr(args.title),
      target: {
        contact_id: asStr(args.contact_id),
        contact_name: asStr(args.contact_name),
        contact_phone: asStr(args.contact_phone),
        tag: asStr(args.tag),
      },
      mark_ready: args.mark_ready === true,
    });
    return res.ok ? ok(res.snapshot) : err(res.error);
  },
};

const commitDraftTool: ToolEntry = {
  def: {
    name: "commit_draft",
    description:
      "DISPARA o fluxo: agenda DE VERDADE todas as mensagens do rascunho pro contato alvo. Só chame quando o rep " +
      "CONFIRMAR (a tool é de risco alto e exige confirmação). Depois de chamar, afirme ao rep SOMENTE o número " +
      "que vier em 'count' (ex: 'agendei 8 mensagens') — NUNCA invente que agendou; se count vier 0 ou erro, diga " +
      "que NÃO saiu. O fluxo precisa ter pelo menos 1 passo e um contato alvo (set_task_meta).",
    risk: "high",
    parameters: {
      type: "object",
      properties: { draft_id: { type: "string", description: "Opcional; usa o rascunho ativo se omitido." } },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const dws = await resolveDraft(ctx.rep.id, asStr(args.draft_id));
    if (!dws) return err("Nenhum rascunho ativo pra disparar.");
    const res = await materializeDraft(ctx.rep.id, dws.draft.id, ctx.rep.timezone ?? null);
    if (!res.ok) return err(res.error);
    return {
      status: "ok",
      data: {
        materialized: true,
        count: res.count,
        sequence_id: res.sequence_id,
        first_at: res.first_at,
        last_at: res.last_at,
        // Frase honesta pronta — o bot deve refletir ESTE count.
        confirmation: `Agendei ${res.count} mensagem(ns) pro contato. A 1ª sai ${res.first_at}; a última ${res.last_at}.`,
      },
    };
  },
};

const getTaskProgressTool: ToolEntry = {
  def: {
    name: "get_task_progress",
    description:
      "Mostra o progresso REAL de um fluxo JÁ disparado (quantas mensagens já saíram, quantas faltam, quantas " +
      "foram puladas porque o lead respondeu). Use quando o rep perguntar 'foram todas?', 'quantas já saíram?'. " +
      "A resposta vem do banco — afirme só esses números.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: { draft_id: { type: "string", description: "Opcional; usa o rascunho ativo se omitido." } },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const dws = await resolveDraftAny(ctx.rep.id, asStr(args.draft_id));
    if (!dws) return err("Nenhum fluxo encontrado.");
    const res = await getDraftProgress(dws.draft.id);
    if (!res.ok) return err(res.error);
    return { status: "ok", data: res };
  },
};

const generateFlowPdfTool: ToolEntry = {
  def: {
    name: "generate_flow_pdf",
    description:
      "Gera um PDF do fluxo (organizado por dia, com os textos e links de cada mensagem) e devolve a URL REAL do " +
      "arquivo pra mandar/baixar. Use quando o rep pedir 'me manda em PDF', 'exporta o fluxo', 'manda um documento'. " +
      "Afirme ao rep SOMENTE a URL que vier em 'pdf_url' — se vier erro, diga que não consegui gerar. Funciona com o " +
      "fluxo em construção OU já disparado.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: { draft_id: { type: "string", description: "Opcional; usa o fluxo ativo/recente se omitido." } },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const dws = await resolveDraftAny(ctx.rep.id, asStr(args.draft_id));
    if (!dws) return err("Nenhum fluxo encontrado pra gerar o PDF.");
    const res = await generateAndUploadFlowPdf(buildSnapshot(dws), ctx.locationId, ctx.rep.id);
    if (!res.ok) return err(res.error);
    return {
      status: "ok",
      data: {
        pdf_url: res.signed_url,
        expires_in_seconds: res.expires_in,
        bytes: res.bytes,
        note: "Link assinado válido por 1h. Mande este link pro rep baixar o PDF.",
      },
    };
  },
};

const sendMediaToContactTool: ToolEntry = {
  def: {
    name: "send_media_to_contact",
    description:
      "Envia um ARQUIVO/MÍDIA (PDF, imagem, vídeo) pra um CONTATO (lead) no Spark Leads — ex: mandar o PDF do fluxo, " +
      "um vídeo, uma imagem. Passe o contact_id do lead e a media_url (link público/assinado, ex: o pdf_url do " +
      "generate_flow_pdf). É risco alto: confirme com o rep antes. O link sempre vai junto no texto (fallback caso " +
      "o WhatsApp não mostre como anexo nativo).",
    risk: "high",
    parameters: {
      type: "object",
      required: ["contact_id", "media_url"],
      properties: {
        contact_id: { type: "string", description: "ID do contato (lead) no Spark Leads." },
        media_url: { type: "string", description: "URL http(s) do arquivo (ex: pdf_url do generate_flow_pdf)." },
        caption: { type: "string", description: "Texto que acompanha o arquivo (opcional)." },
        channel: { type: "string", enum: ["SMS", "WhatsApp"], description: "Canal (default SMS → Stevo/WhatsApp)." },
      },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const contactId = asStr(args.contact_id);
    if (!contactId) return err("contact_id obrigatório (use search_contacts pra achar o lead).");
    const idErr = validateGhlId(contactId, "contact");
    if (idErr) return idErr;
    const mediaUrl = asStr(args.media_url);
    if (!mediaUrl || !/^https?:\/\//.test(mediaUrl)) return err("media_url precisa ser uma URL http(s) válida.");
    const caption = asStr(args.caption) ?? "";
    const finalCaption = caption ? `${caption}\n${mediaUrl}` : mediaUrl; // link sempre junto (fallback)
    const channel = ((asStr(args.channel) as GhlChannel) || "SMS") as GhlChannel;
    try {
      const r = await sendMediaToContact(ctx.ghlClient, contactId, mediaUrl, finalCaption, channel);
      return {
        status: "ok",
        data: {
          sent: true,
          message_id: r.messageId ?? null,
          note: "Enviado via attachments. Se o WhatsApp não exibir como arquivo nativo, o link no texto é o fallback.",
        },
      };
    } catch (e) {
      return ghlErrorToResult(e, "enviar mídia ao contato");
    }
  },
};

const applyFlowToContactsTool: ToolEntry = {
  def: {
    name: "apply_flow_to_contacts",
    description:
      "Aplica o MESMO fluxo (template) a VÁRIOS contatos de uma vez — cria uma sequência por contato. Use quando o " +
      "rep disser 'manda esse fluxo pra esses contatos' / 'aplica nesses números' / 'pra todos com a tag X' (nesse " +
      "caso, primeiro use get_contacts_filtered pra achar os contatos da tag, depois chame isto com os IDs). É risco " +
      "alto: confirme antes. NÃO consome o fluxo (continua reusável). Reporte ao rep o 'succeeded' e os counts REAIS " +
      "por contato que vierem no retorno — nunca invente.",
    risk: "high",
    parameters: {
      type: "object",
      required: ["contacts"],
      properties: {
        contacts: {
          type: "array",
          description: "Contatos alvo (cada um com contact_id; nome/telefone opcionais).",
          items: {
            type: "object",
            required: ["contact_id"],
            properties: {
              contact_id: { type: "string" },
              contact_name: { type: "string" },
              contact_phone: { type: "string" },
            },
          },
        },
        draft_id: { type: "string", description: "Opcional; usa o fluxo ativo/recente se omitido." },
      },
    },
  },
  handler: async (ctx: ToolContext, args: Record<string, unknown>): Promise<ToolResult> => {
    const dws = await resolveDraftAny(ctx.rep.id, asStr(args.draft_id));
    if (!dws) return err("Nenhum fluxo encontrado pra aplicar.");
    const raw = Array.isArray(args.contacts) ? args.contacts : [];
    const contacts: ContactTarget[] = [];
    for (const c of raw) {
      const o = (c || {}) as Record<string, unknown>;
      const id = asStr(o.contact_id);
      if (id) contacts.push({ contact_id: id, contact_name: asStr(o.contact_name) ?? null, contact_phone: asStr(o.contact_phone) ?? null });
    }
    if (contacts.length === 0) return err("Passe pelo menos 1 contato com contact_id (use search_contacts).");
    const res = await applyFlowToContacts(ctx.rep.id, dws.draft.id, contacts, ctx.rep.timezone ?? null);
    if ("error" in res) return err(res.error);
    return {
      status: "ok",
      data: {
        applied: true,
        total_contacts: res.total_contacts,
        succeeded: res.succeeded,
        total_messages: res.total_messages,
        per_contact: res.per_contact,
        confirmation: `Apliquei o fluxo a ${res.succeeded}/${res.total_contacts} contato(s), ${res.total_messages} mensagem(ns) agendadas no total.`,
      },
    };
  },
};

/** Montagem (F1) + materialização (F2) + progresso + PDF (F4) + envio (F5) + template N-contatos (F6). */
export const TASK_ORCHESTRATOR_TOOLS: ToolEntry[] = [
  startTaskDraft,
  showDraftTool,
  addStepTool,
  editStepTool,
  removeStepTool,
  setTaskMetaTool,
  commitDraftTool,
  getTaskProgressTool,
  generateFlowPdfTool,
  sendMediaToContactTool,
  applyFlowToContactsTool,
];
