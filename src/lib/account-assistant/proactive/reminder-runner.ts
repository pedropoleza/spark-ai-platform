/**
 * Runner de scheduled_tasks (lembretes do rep agendados via schedule_reminder).
 *
 * Roda dentro do cron principal (/api/cron/sparkbot-proactive). A cada 5min:
 *   1. Busca tasks com status='pending' AND next_run_at <= now() (limite 50)
 *   2. Pra cada task, atomic claim via update status='running' (anti-race)
 *   3. Dispara: insere agent_test_messages (se test_session_id) ou WhatsApp (V3)
 *   4. Update final:
 *        - one-shot: status='completed', last_run_at=now
 *        - recurring: calcula próximo next_run_at do cron, volta status='pending'
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { reportError } from "@/lib/admin-signals/report-error";
import { shouldFireCron } from "./cron-evaluator";
import { normalizeForRepeat } from "../core/repeat-guard";
import { loadSilenceDecision, recordProactiveSent, appendSilenceNote } from "./silence-gate";
import { resolvePrimaryHub, getEnvHubLocationId } from "@/lib/account-assistant/hub-resolver";
import {
  findRepPhoneById,
  findRepFieldsById,
  findLastInboundHubLocation,
  findActiveSparkbotAgent,
  insertSparkbotMessage,
} from "@/lib/repositories";

export interface ReminderRunResult {
  fired: number;
  failed: number;
  skipped: number;
}

interface ScheduledTaskRow {
  id: string;
  rep_id: string;
  location_id: string;
  task_type: string;
  task_payload: {
    message?: string;
    title?: string;
    test_session_id?: string | null;
    // F1 (contact-resolution 2026-06): contato referenciado pelo lembrete (gravado por
    // task-reminders.ts a partir de TaskEvent.contactId). Propagado pra metadata da msg
    // proativa → o turno inbound seguinte herda de QUEM se fala, sem re-buscar do zero.
    contact_id?: string;
    contact_name?: string;
  };
  next_run_at: string;
  cron_expr: string | null;
  status: string;
  last_run_at: string | null;
  delivery_channel?: "whatsapp" | "web_ui" | "both" | null;
}

export async function fireScheduledReminders(): Promise<ReminderRunResult> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Atomic claim: marca pending → running em uma só query.
  // Fix Pedro 2026-05-06: estende pra outbound_to_contact (mensagens
  // agendadas pra CONTATO, não pro rep) — schedule_message_to_contact.
  const { data: claimed, error: claimErr } = await supabase
    .from("assistant_scheduled_tasks")
    .update({ status: "running" })
    .eq("status", "pending")
    .lte("next_run_at", nowIso)
    .in("task_type", [
      "reminder",
      "recurring_reminder",
      "outbound_to_contact",
      "outbound_to_contact_recurring",
      "ghl_task_reminder",
    ])
    .select("*")
    .order("next_run_at", { ascending: true })
    .limit(50);

  // Sweep ultra-review 2026-06-15: o claim ignorava o error (anti-pattern do
  // CLAUDE.md). Se o UPDATE falhar (drift de schema/RLS — cenário EXATO do apagão
  // do disparo), claimed=null e o tick parecia "sem trabalho" SEM erro logado →
  // lembretes paravam mudos. Agora vira signal high antes do return.
  if (claimErr) {
    reportError({
      title: "SparkBot: claim de lembretes falhou",
      feature: "reminder-runner",
      error: claimErr,
      description:
        "UPDATE de claim (pending→running) em assistant_scheduled_tasks retornou erro — tick não processou lembretes. Possível drift de schema/RLS.",
    });
    return { fired: 0, failed: 0, skipped: 0 };
  }

  if (!claimed || claimed.length === 0) {
    return { fired: 0, failed: 0, skipped: 0 };
  }

  let fired = 0;
  let failed = 0;
  let skipped = 0;

  // F58 (Fix bug observado em prod 2026-06-04 — caso Soraia): dedup do BATCH.
  // Reminders quase-idênticos pro MESMO rep vencendo no mesmo tick (ex: a bot
  // criou a mesma task GHL 7× → 7 ghl_task_reminders idênticos; ou 2 recurring
  // "Pendências diárias") spammavam o rep. Dispara só 1 por (rep + conteúdo
  // normalizado); os outros marca 'cancelled' (não re-disparam — pro recurring,
  // mata a duplicata de vez; o sobrevivente segue recorrendo normalmente).
  // Root upstream (create_task / schedule_reminder duplicando) tratado à parte.
  const seen = new Set<string>();
  const toFire: ScheduledTaskRow[] = [];
  const dupIds: string[] = [];
  for (const task of claimed as ScheduledTaskRow[]) {
    const content = (task.task_payload?.message || task.task_payload?.title || "").trim();
    const norm = content ? normalizeForRepeat(content) : "";
    const key = `${task.rep_id}::${norm}`;
    if (norm && seen.has(key)) {
      dupIds.push(task.id);
      continue;
    }
    if (norm) seen.add(key);
    toFire.push(task);
  }
  if (dupIds.length > 0) {
    await supabase
      .from("assistant_scheduled_tasks")
      .update({ status: "cancelled", last_run_at: nowIso })
      .in("id", dupIds);
    skipped += dupIds.length;
    console.warn(
      `[reminder-runner] F58 dedup: ${dupIds.length} lembrete(s) duplicado(s) cancelado(s) no batch (anti-spam pro rep)`,
    );
  }

  for (const task of toFire) {
    try {
      const result = await fireOne(task);
      if (result === "fired") fired++;
      else if (result === "skipped") skipped++;
      else failed++;
    } catch (err) {
      console.error(`[reminder-runner] task ${task.id} failed:`, err instanceof Error ? err.message : err);
      // Sweep F49 2026-06-05: fireOne crashou (erro NÃO-send; o send já reporta
      // no catch interno). Tarefa marcada failed.
      reportError({ title: "Reminder runner: fireOne crashou", feature: "proactive-reminder", severity: "medium", error: err, metadata: { taskId: task.id } });
      failed++;
      await markTaskFailed(task.id);
    }
  }

  return { fired, failed, skipped };
}

async function fireOne(task: ScheduledTaskRow): Promise<"fired" | "failed" | "skipped"> {
  const supabase = createAdminClient();

  // Branch: outbound_to_contact é fluxo separado — envia direto pro
  // CONTATO via POST /conversations/messages do GHL, não passa pelo
  // silence-gate do rep (que é pra proativos AO rep).
  if (
    task.task_type === "outbound_to_contact" ||
    task.task_type === "outbound_to_contact_recurring"
  ) {
    return await fireOutboundToContact(task);
  }

  const message = task.task_payload?.message;
  const title = task.task_payload?.title;
  const sessionId = task.task_payload?.test_session_id;

  if (!message) {
    await markTaskFailed(task.id);
    return "failed";
  }

  // Resolve canais de entrega. Default 'whatsapp' pra retrocompat com tasks
  // criadas antes da migration 00042. 'both' explode em 2 entregas.
  const explicitChannel = task.delivery_channel || "whatsapp";
  const channels: Array<"whatsapp" | "web_ui"> =
    explicitChannel === "both" ? ["whatsapp", "web_ui"] : [explicitChannel];

  // Sessão de teste é prioritária (pra rodar synthetic-test). Senão usa
  // entregas reais — Web UI (sparkbot_messages) e/ou WhatsApp (V3).
  if (sessionId) {
    const { data: sess } = await supabase
      .from("agent_test_sessions")
      .select("id")
      .eq("id", sessionId)
      .maybeSingle();
    if (sess) {
      await deliverReminderTestSession(sessionId, task, message, title);
      await advanceTask(task);
      return "fired";
    }
  }

  // Silence gate: protege contra spam/ban quando o rep some. Onda 1 (V2):
  // lembrete é proativo SOLICITADO pelo rep ("requested") — respeita a PAUSA
  // total (anti-ban), mas NÃO leva aviso de silêncio nem conta como "sem
  // resposta". O rep pediu pra ser lembrado; não faz sentido ameaçá-lo por
  // isso. Só aplica em entregas REAIS (não em test session).
  // Kind do silence-gate: lembrete pedido pelo rep ("me lembra de X") = "requested"
  // (respeita pausa, não ameaça/conta). Lembrete de TAREFA do GHL = "nudge" — é
  // bot-initiated (regra), então passa pelo gate completo (warn/pausa) pra proteger
  // contra spam/ban se o rep some (Pedro 2026-05-21). Reseta em qualquer inbound.
  const reminderKind = task.task_type === "ghl_task_reminder" ? "nudge" : "requested";

  // Fix bug observado em prod 2026-08-14 (caso Taciana): a pref task_reminder
  // só era checada no AGENDAMENTO (task-reminders.ts) — rep que desligava depois
  // ("pode parar de me mandar as tasks") continuava recebendo os já enfileirados.
  // Re-checa na ENTREGA; se desligou, cancela em vez de entregar.
  if (task.task_type === "ghl_task_reminder") {
    try {
      const { resolveProactivityPref } = await import("./preferences");
      const repRow = await findRepFieldsById<
        Pick<import("@/types/account-assistant").RepIdentity, "proactivity_prefs" | "daily_briefing_enabled">
      >(task.rep_id, "proactivity_prefs, daily_briefing_enabled");
      if (repRow) {
        const pref = resolveProactivityPref(repRow, "task_reminder");
        if (!pref.enabled) {
          await supabase
            .from("assistant_scheduled_tasks")
            .update({ status: "cancelled", last_run_at: new Date().toISOString() })
            .eq("id", task.id);
          console.log(
            `[reminder-runner] task ${task.id} cancelada na entrega — rep ${task.rep_id} desligou task_reminder`,
          );
          return "skipped";
        }
      }
    } catch (err) {
      // fail-open: erro na checagem não segura o lembrete
      console.warn(
        `[reminder-runner] re-check da pref task_reminder falhou (task ${task.id}):`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  const decision = await loadSilenceDecision(supabase, task.rep_id, reminderKind);
  if (!decision.canSend) {
    console.log(
      `[reminder-runner] task ${task.id} skipped (silence gate, reason=${decision.reason}) — ` +
      `${decision.shouldSetPaused ? "pausando rep" : "rep já pausado"}`,
    );
    await recordProactiveSent(supabase, task.rep_id, decision);
    // H68 (caso Gustavo Couto): ANTES isto chamava advanceTask, que marca o
    // one-shot como 'completed' — o lembrete do rep era DESTRUÍDO como se
    // tivesse sido entregue, sem mensagem, sem sinal, sem rastro. 19 lembretes
    // sumiram assim em 30 dias, 12 só dele (bloqueado pelo loop-guard de 23/07
    // a 03/08). Bloqueado ≠ concluído: agora o lembrete ESPERA o rep destravar.
    await deferBlockedTask(task, decision.reason || "gate");
    return "skipped";
  }

  // Recado de silêncio (2º ou 3º proativo sem resposta) vai DEPOIS do lembrete —
  // o rep lê primeiro o que pediu.
  let finalMessage = appendSilenceNote(message, decision.warningNote);
  // H68: lembrete que ficou esperando o rep destravar sai com aviso de atraso —
  // melhor chegar tarde e honesto do que chegar mudo (ou não chegar).
  const bloqueadoAntes = (task.task_payload || {}) as Record<string, unknown>;
  if (typeof bloqueadoAntes.blocked_count === "number" && bloqueadoAntes.blocked_count > 0) {
    const eraPara = typeof bloqueadoAntes.first_blocked_at === "string"
      ? new Date(bloqueadoAntes.first_blocked_at)
      : null;
    const quando = eraPara
      ? eraPara.toLocaleString("pt-BR", { timeZone: "America/New_York", day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })
      : null;
    finalMessage = `⏰ _(lembrete atrasado${quando ? ` — era pra ter chegado ${quando}` : ""})_\n${finalMessage}`;
  }

  // Web UI: insere em sparkbot_messages com channel='system' (proativa).
  // Painel web vai pegar no próximo poll e mostrar como notificação.
  if (channels.includes("web_ui")) {
    await deliverReminderWeb(task, finalMessage, title);
  }

  // WhatsApp: V3 enviaria pelo Hub real; por enquanto registra como
  // 'system' channel='whatsapp' pra histórico (e V3 envia depois).
  let deliveredWhatsapp = false;
  if (channels.includes("whatsapp")) {
    deliveredWhatsapp = await deliverReminderWhatsapp(task, finalMessage, title);
  }

  // Persiste o counter increment + warning marker.
  // Ultra-review 2026-08-03: só conta "silêncio" o que COMPROVADAMENTE saiu no
  // WhatsApp (paridade com o dispatcher) — proativa que falhou envio não é
  // ignorada; foi essa contagem cega que pausou 11 reps por silêncio FANTASMA
  // na semana do 479 (Daniely/Jussara, top-5 de uso). Fallback web não infla.
  if (deliveredWhatsapp) {
    await recordProactiveSent(supabase, task.rep_id, decision);
  }
  await advanceTask(task);
  return "fired";
}

async function deliverReminderWeb(
  task: ScheduledTaskRow,
  message: string,
  title: string | undefined,
): Promise<void> {
  // H29 2026-05-20: hub via DB-first com fallback env (multi-hub ready)
  // Prioridade: último inbound do rep → hub ativo no DB → env fallback
  const hubEntry = await resolvePrimaryHub();
  const envHubLocationId = hubEntry?.locationId ?? getEnvHubLocationId();
  const lastInboundHub = await findLastInboundHubLocation(task.rep_id);
  const hubLocationId = lastInboundHub || envHubLocationId;
  if (!hubLocationId) {
    console.warn("[reminder-runner] hub não resolvido — pulando entrega web");
    return;
  }
  // Resolve agent_id (sparkbot do Hub)
  const hubAgent = await findActiveSparkbotAgent(hubLocationId);
  if (!hubAgent) return;

  await insertSparkbotMessage({
    rep_id: task.rep_id,
    hub_location_id: hubLocationId,
    agent_id: hubAgent.id,
    active_location_id: task.location_id,
    role: "agent",
    content: `🔔 ${title || "Lembrete"}\n\n${message}`,
    channel: "system",
    metadata: {
      reminder_id: task.id,
      task_type: task.task_type,
      source: "scheduled_reminder",
      // F1 (contact-resolution 2026-06): herança de contexto — leva o contato do lembrete
      // pra metadata da msg; o "contato em foco" do inbound (F3) lê daqui.
      ...(task.task_payload?.contact_id ? { contact_id: task.task_payload.contact_id } : {}),
      ...(task.task_payload?.contact_name ? { contact_name: task.task_payload.contact_name } : {}),
    },
  });
}

async function deliverReminderWhatsapp(
  task: ScheduledTaskRow,
  message: string,
  title: string | undefined,
): Promise<boolean> {
  // Refatorado 2026-05-04: extraído pra whatsapp-delivery.ts pra reutilizar
  // entre lembretes (esta função) e regras proativas (dispatcher mode='real').
  // Comportamento e env vars iguais (WHATSAPP_DELIVERY_ENABLED, etc).
  const rep = await findRepPhoneById(task.rep_id);
  if (!rep) {
    console.warn(`[reminder-runner] rep ${task.rep_id} não encontrado — pulando entrega`);
    return false;
  }

  const formattedMessage = `🔔 ${title || "Lembrete"}\n\n${message}`;
  const { deliverProactiveMessage } = await import("./whatsapp-delivery");
  const dr = await deliverProactiveMessage(rep, formattedMessage, {
    activeLocationId: task.location_id,
    source: "scheduled_reminder",
    reminderId: task.id,
    kind: task.task_type,
    // Fix bug observado em prod 2026-08-14 (casos Milton/Raquel/Natalia): o default
    // `fonte:rep:minuto` fazia DOIS lembretes distintos do mesmo rep vencendo no
    // mesmo minuto virarem "duplicata" no SparkZap — o 2º sumia com a task marcada
    // completed (9 lembretes perdidos em 15d). task.id distingue lembretes; o
    // minuto fica pra recurring_reminder (mesmo task.id re-dispara em ticks
    // futuros) e pro retry intra-tick continuar dedupado.
    dedupeKey: `proactive:reminder:${task.id}:${Math.floor(Date.now() / 60_000)}`,
    // F1 (contact-resolution 2026-06): propaga o contato do lembrete pra metadata da msg
    // (slot extraMetadata já existe em whatsapp-delivery.ts) → herança no inbound (F3).
    extraMetadata: {
      ...(task.task_payload?.contact_id ? { contact_id: task.task_payload.contact_id } : {}),
      ...(task.task_payload?.contact_name ? { contact_name: task.task_payload.contact_name } : {}),
    },
  });
  return dr?.via === "whatsapp";
}

async function deliverReminderTestSession(
  sessionId: string,
  task: ScheduledTaskRow,
  message: string,
  title: string | undefined,
): Promise<void> {
  await deliverReminder(sessionId, task, message, title);
}

async function deliverReminder(
  sessionId: string,
  task: ScheduledTaskRow,
  message: string,
  title: string | undefined,
): Promise<void> {
  const supabase = createAdminClient();
  // Formata como msg do agente com badge especial (igual aos alertas proativos)
  const text = `🔔 ${title || "Lembrete"}\n\n${message}`;
  await supabase.from("agent_test_messages").insert({
    session_id: sessionId,
    role: "agent",
    content: text,
    metadata: {
      alert_type: task.task_type === "recurring_reminder" ? "Lembrete recorrente" : "Lembrete",
      is_proactive: true,
      reminder_id: task.id,
      source: "scheduled_reminder",
    },
  });
  await supabase
    .from("agent_test_sessions")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", sessionId);
}

/**
 * Dispara mensagem agendada pra contato (outbound_to_contact).
 * Diferente de fireOne padrão (que entrega pro rep via web/whatsapp do hub),
 * este faz POST direto pro GHL /conversations/messages do CONTATO na
 * location onde foi agendada — usa company_id da location, não do hub.
 *
 * Fix Pedro 2026-05-06: nova capability "manda pra Maria amanhã 10h".
 * Envio falho persiste como signal admin (visibility) e marca task=failed.
 * Recurring continua: failed numa execução não impede próximas (advanceTask
 * recalcula next_run_at normalmente).
 */
async function fireOutboundToContact(
  task: ScheduledTaskRow,
): Promise<"fired" | "failed" | "skipped"> {
  const supabase = createAdminClient();
  const payload = task.task_payload as {
    contact_id?: string;
    message?: string;
    channel?: string;
    subject?: string;
  };

  if (!payload.contact_id || !payload.message) {
    console.warn(
      `[reminder-runner] outbound task ${task.id} sem contact_id ou message — failed`,
    );
    await markTaskFailed(task.id);
    return "failed";
  }

  // Resolve company_id pela location do task (não do hub).
  const { data: loc } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", task.location_id)
    .maybeSingle();
  if (!loc?.company_id) {
    console.warn(
      `[reminder-runner] outbound task ${task.id} location ${task.location_id} sem company_id — failed`,
    );
    await markTaskFailed(task.id);
    return "failed";
  }

  // Opt-out gate (fix P0 review pré-launch 2026-06-10): TCPA/LGPD. Contato que
  // respondeu STOP/PARAR não pode receber envio direto agendado/recorrente. O
  // detector grava em outreach_optouts; bulk/outreach/followup já honram — este
  // path (outbound_to_contact) não honrava. Cancela a task (não só pula o tick)
  // pra a série recorrente parar de re-tentar indefinidamente.
  const { filterOutOptOutContacts } = await import("./optout-detector");
  const optedOut = await filterOutOptOutContacts(task.location_id, [payload.contact_id]);
  if (optedOut.has(payload.contact_id)) {
    console.warn(
      `[reminder-runner] outbound task ${task.id} — contato ${payload.contact_id} opted-out (STOP); cancelando task.`,
    );
    await supabase
      .from("assistant_scheduled_tasks")
      .update({ status: "cancelled", last_run_at: new Date().toISOString() })
      .eq("id", task.id);
    return "skipped";
  }

  const channel = payload.channel || "SMS";
  const body: Record<string, unknown> = {
    type: channel,
    contactId: payload.contact_id,
    message: payload.message,
    ...(channel === "Email" && payload.subject ? { subject: payload.subject } : {}),
  };

  let messageId: string | null = null;
  let sendError: string | null = null;
  let assignmentChanged = false;
  let previousAssignee: string | null = null;
  try {
    const { GHLClient } = await import("@/lib/ghl/client");
    const ghl = new GHLClient(loc.company_id, task.location_id);

    // Fix Pedro 2026-05-06: PROTOCOLO PADRÃO — antes de QUALQUER send,
    // garante que assignedTo do contato é o rep que agendou (task.rep_id).
    // Resolve ghl_user_id do rep na location da task (pode ser diferente
    // do active_location se rep tem múltiplas sub-accounts).
    // Pra contas com múltiplas instâncias WhatsApp, GHL roteia outbound
    // baseado em assignedTo. Sem switch, msg sai pelo número errado.
    try {
      const repForAssign = await findRepFieldsById<{ ghl_users: Array<{ ghl_user_id: string; location_id: string }> }>(
        task.rep_id, "ghl_users"
      );
      const repGhlUserId = (repForAssign?.ghl_users || []).find(
        (u) => u.location_id === task.location_id,
      )?.ghl_user_id;
      if (repGhlUserId) {
        const { ensureContactAssignedTo } = await import("@/lib/ghl/operations");
        const r = await ensureContactAssignedTo(
          ghl,
          payload.contact_id,
          repGhlUserId,
        );
        assignmentChanged = r.changed;
        previousAssignee = r.previousAssignedTo;
        if (r.changed) {
          console.log(
            `[reminder-runner] outbound task ${task.id} — assignedTo switched ` +
              `from ${previousAssignee || "null"} to ${repGhlUserId}`,
          );
        }
      } else {
        console.warn(
          `[reminder-runner] outbound task ${task.id} — rep ${task.rep_id} sem ` +
            `ghl_user_id em location ${task.location_id}. Skip assignment switch ` +
            `(msg pode sair pelo número errado em conta multi-WhatsApp).`,
        );
      }
    } catch (assignErr) {
      // Não fatal — segue tentando o send.
      console.warn(
        `[reminder-runner] outbound task ${task.id} — assignedTo update falhou:`,
        assignErr instanceof Error ? assignErr.message.slice(0, 100) : assignErr,
      );
    }

    // Agora SIM, send.
    // Fix Pedro 2026-05-06: fallback transparente WhatsApp API → SMS
    // quando sub-account não tem subscription (idem send_message_to_contact).
    const trySend = async (
      ch: string,
    ): Promise<{ messageId?: string; conversationId?: string }> => {
      const sendBody: Record<string, unknown> = { ...body, type: ch };
      return ghl.post<{ messageId?: string; conversationId?: string }>(
        "/conversations/messages",
        sendBody,
      );
    };
    try {
      const res = await trySend(channel);
      messageId = res.messageId || null;
    } catch (sendErr) {
      const m = sendErr instanceof Error ? sendErr.message : String(sendErr);
      if (
        channel === "WhatsApp" &&
        /no active whatsapp subscription|whatsapp.*not.*active|whatsapp.*disabled/i.test(m)
      ) {
        console.warn(
          `[reminder-runner] outbound task ${task.id} — WhatsApp API ` +
            `inativo; fallback transparente pra SMS (Stevo).`,
        );
        try {
          const fb = await trySend("SMS");
          messageId = fb.messageId || null;
        } catch (fbErr) {
          throw fbErr;
        }
      } else {
        throw sendErr;
      }
    }
  } catch (err) {
    sendError = err instanceof Error ? err.message : String(err);
    console.warn(
      `[reminder-runner] outbound task ${task.id} POST falhou: ${sendError}`,
    );
    // Sweep F49 2026-06-05: outbound AGENDADO pelo rep (ex: "lembra a Maria às
    // 15h") não saiu → rep acha que enviou. Promessa quebrada silenciosa.
    reportError({ title: "Reminder runner: envio do outbound agendado falhou", feature: "proactive-reminder", severity: "high", error: err, metadata: { taskId: task.id } });
  }

  // Audit em sparkbot_messages (mesma table que outros proativos).
  // Channel='system' = badge no painel web do rep ("manda msg pra Maria
  // enviado: ...") — rep vê histórico dos agendamentos executados.
  try {
    // H29 2026-05-20: hub via DB-first com fallback env
    const hubEntryAudit = await resolvePrimaryHub();
    const envHubLoc = hubEntryAudit?.locationId ?? getEnvHubLocationId();
    let auditAgentId = hubEntryAudit?.agentId || null;
    if (!auditAgentId && envHubLoc) {
      const hubAgentRow = await findActiveSparkbotAgent(envHubLoc);
      auditAgentId = hubAgentRow?.id ?? null;
    }
    const hubAgent = auditAgentId ? { id: auditAgentId } : null;
    if (hubAgent && envHubLoc) {
      const auditContent = sendError
        ? `⚠️ Falha ao enviar msg agendada pro contato: ${sendError.slice(0, 100)}`
        : `📤 Msg agendada enviada pro contato (${channel}): "${(payload.message || "").slice(0, 80)}${(payload.message || "").length > 80 ? "..." : ""}"`;
      await insertSparkbotMessage({
        rep_id: task.rep_id,
        hub_location_id: envHubLoc,
        agent_id: hubAgent.id,
        active_location_id: task.location_id,
        role: "agent",
        content: auditContent,
        channel: "system",
        ghl_message_id: messageId,
        read_in_web_at: sendError ? null : new Date().toISOString(),
        metadata: {
          source: "scheduled_outbound_to_contact",
          scheduled_task_id: task.id,
          contact_id: payload.contact_id,
          channel,
          ghl_message_id: messageId,
          send_error: sendError,
          delivery_status: sendError ? "failed_immediate" : "pending_confirm",
          assignment_changed: assignmentChanged,
          previous_assignee: previousAssignee,
        },
      });
    }
  } catch (err) {
    console.warn(
      `[reminder-runner] outbound task ${task.id} audit failed (não-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }

  // Se falhou no send, auto-signal admin (igual delivery-status-poller faz
  // pra proativos do rep). Pedro vê em /admin/signals.
  if (sendError) {
    try {
      const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
      recordSignalAsync({
        type: "failure",
        title: `Mensagem agendada pra contato falhou: ${sendError.slice(0, 80)}`,
        description:
          `Task ${task.id} (rep ${task.rep_id}) falhou ao enviar pra ` +
          `contact ${payload.contact_id} via ${channel}. Erro: ${sendError}`,
        severity: "medium",
        source: "bot_auto",
        metadata: {
          scheduled_task_id: task.id,
          rep_id: task.rep_id,
          contact_id: payload.contact_id,
          location_id: task.location_id,
          channel,
          send_error: sendError,
        },
      });
    } catch {
      /* signal não crítico */
    }
  }

  // Avança state (recurring → próximo next_run_at; one-shot → completed).
  await advanceTask(task);
  return sendError ? "failed" : "fired";
}

/**
 * Avança o estado da task após disparo:
 *   - one-shot: marca como completed
 *   - recurring: calcula próximo next_run_at do cron e volta pra pending
 */
/**
 * Lembrete bloqueado por gate (silêncio, loop-guard, wallet) NÃO é lembrete
 * cumprido — H68, caso Gustavo Couto.
 *
 * Adia e tenta de novo, porque o bloqueio é temporário por natureza: o rep
 * destrava (recarrega a wallet, o loop-guard expira, ele responde) e aí o
 * lembrete ainda faz sentido. Recorrente segue o cron normal — quem perdeu a
 * ocorrência perdeu; a próxima vem sozinha.
 *
 * Teto de 3 dias pra não ressuscitar lembrete velho pro rep: passou disso,
 * marca `failed` e emite sinal — o que importa é NÃO sumir em silêncio.
 * (`failed` e não um status novo porque o CHECK da tabela só aceita
 * pending/running/completed/cancelled/failed; o payload guarda o motivo.)
 * Contador vive no próprio payload (jsonb), sem migration.
 */
const DEFER_BASE_MS = 30 * 60 * 1000;
const DEFER_CAP_MS = 12 * 60 * 60 * 1000;
const DEFER_MAX_MS = 3 * 24 * 60 * 60 * 1000;
/**
 * 2026-08-14 (caso Taciana): lembrete de TASK do CRM (nudge automático) atrasado
 * 2 dias é ruído — ela recebeu 6 seguidos com "(lembrete atrasado — era pra ter
 * chegado 10/08)". Nudge tem teto de 24h e expira como cancelled SEM sinal (não
 * é promessa ao rep — diferente do lembrete que ele PEDIU, que mantém 3 dias +
 * failed + sinal de admin).
 */
const DEFER_MAX_NUDGE_MS = 24 * 60 * 60 * 1000;

/** Espera com backoff: 30min, 1h, 2h, 4h, 8h, 12h… — ~8 tentativas em 3 dias.
 *  Sem isso seriam 144 re-claims por lembrete e hoje existem 151 lembretes
 *  pendentes de reps pausados (só a Michelle Melo tem 137). */
function deferDelayMs(tentativa: number): number {
  return Math.min(DEFER_BASE_MS * 2 ** Math.max(0, tentativa - 1), DEFER_CAP_MS);
}

async function deferBlockedTask(task: ScheduledTaskRow, reason: string): Promise<void> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Recorrente: mantém o comportamento de sempre (pula a ocorrência).
  if (
    (task.task_type === "recurring_reminder" ||
      task.task_type === "outbound_to_contact_recurring") &&
    task.cron_expr
  ) {
    await advanceTask(task);
    return;
  }

  const payload = (task.task_payload || {}) as Record<string, unknown>;
  const primeiro = typeof payload.first_blocked_at === "string" ? payload.first_blocked_at : nowIso;
  const vezes = (typeof payload.blocked_count === "number" ? payload.blocked_count : 0) + 1;
  const ehNudge = task.task_type === "ghl_task_reminder";
  const tetoMs = ehNudge ? DEFER_MAX_NUDGE_MS : DEFER_MAX_MS;
  const estourou = Date.now() - new Date(primeiro).getTime() > tetoMs;

  if (estourou && ehNudge) {
    // Nudge automático velho morre quieto — sem selo de atraso, sem sinal.
    await supabase
      .from("assistant_scheduled_tasks")
      .update({
        status: "cancelled",
        last_run_at: nowIso,
        task_payload: { ...payload, first_blocked_at: primeiro, blocked_count: vezes, blocked_reason: reason },
      })
      .eq("id", task.id);
    return;
  }

  if (estourou) {
    await supabase
      .from("assistant_scheduled_tasks")
      .update({
        status: "failed",
        last_run_at: nowIso,
        task_payload: { ...payload, first_blocked_at: primeiro, blocked_count: vezes, blocked_reason: reason },
      })
      .eq("id", task.id);
    try {
      const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
      recordSignalAsync({
        type: "failure",
        title: `⏰ Lembrete do rep expirou sem entregar (${reason})`,
        description:
          `Task ${task.id} (rep ${task.rep_id}) ficou 3 dias bloqueada por "${reason}" e não foi ` +
          `entregue. O rep PEDIU esse lembrete e não recebeu. Conferir o que está bloqueando ` +
          `(loop_guard/wallet/silêncio) antes que se repita.`,
        severity: "medium",
        source: "bot_auto",
        metadata: { scheduled_task_id: task.id, rep_id: task.rep_id, reason, blocked_count: vezes },
      });
    } catch {
      /* sinal não crítico */
    }
    return;
  }

  await supabase
    .from("assistant_scheduled_tasks")
    .update({
      status: "pending",
      next_run_at: new Date(Date.now() + deferDelayMs(vezes)).toISOString(),
      task_payload: { ...payload, first_blocked_at: primeiro, blocked_count: vezes, blocked_reason: reason },
    })
    .eq("id", task.id);
}

async function advanceTask(task: ScheduledTaskRow): Promise<void> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Fix Pedro 2026-05-06: pattern recurring se aplica a 2 task types:
  // recurring_reminder (msg pro rep) E outbound_to_contact_recurring
  // (msg agendada pra contato).
  if (
    (task.task_type === "recurring_reminder" ||
      task.task_type === "outbound_to_contact_recurring") &&
    task.cron_expr
  ) {
    // Resolver timezone pelo location_id da task (era NY hardcoded — bug)
    const { data: loc } = await supabase
      .from("locations")
      .select("timezone")
      .eq("location_id", task.location_id)
      .maybeSingle();
    const tz = loc?.timezone || "America/New_York";
    const nextRun = computeNextRun(task.cron_expr, new Date(), tz);
    if (!nextRun) {
      // Cron inválido — fail
      await supabase
        .from("assistant_scheduled_tasks")
        .update({ status: "failed", last_run_at: nowIso })
        .eq("id", task.id);
      return;
    }

    // 2026-08-14 (caso Matheus): recorrência com data-fim (`until` da tool) —
    // quando a PRÓXIMA execução cai depois do fim, a série completa sozinha em
    // vez de rodar até alguém lembrar de cancelar.
    const untilRaw = (task.task_payload as Record<string, unknown> | null)?.recurrence_until;
    if (typeof untilRaw === "string") {
      const untilMs = Date.parse(untilRaw);
      if (Number.isFinite(untilMs) && nextRun.getTime() > untilMs) {
        await supabase
          .from("assistant_scheduled_tasks")
          .update({ status: "completed", last_run_at: nowIso })
          .eq("id", task.id);
        return;
      }
    }

    await supabase
      .from("assistant_scheduled_tasks")
      .update({
        status: "pending",
        last_run_at: nowIso,
        next_run_at: nextRun.toISOString(),
      })
      .eq("id", task.id);
  } else {
    await supabase
      .from("assistant_scheduled_tasks")
      .update({ status: "completed", last_run_at: nowIso })
      .eq("id", task.id);
  }
}

async function markTaskFailed(taskId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("assistant_scheduled_tasks")
    .update({ status: "failed", last_run_at: new Date().toISOString() })
    .eq("id", taskId);
}

/**
 * Calcula próximo trigger de um cron expression no timezone do rep.
 * Iteração minuto a minuto, máx 31 dias (cobre cron mensal).
 */
function computeNextRun(cron: string, from: Date, timezone: string): Date | null {
  const cursor = new Date(from);
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);
  const maxIter = 31 * 24 * 60;
  for (let i = 0; i < maxIter; i++) {
    if (shouldFireCron(cron, timezone, cursor)) {
      return new Date(cursor);
    }
    cursor.setMinutes(cursor.getMinutes() + 1);
  }
  return null;
}
