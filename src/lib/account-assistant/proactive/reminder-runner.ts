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
import { shouldFireCron } from "./cron-evaluator";
import { loadSilenceDecision, recordProactiveSent } from "./silence-gate";

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
  task_payload: { message?: string; title?: string; test_session_id?: string | null };
  next_run_at: string;
  cron_expr: string | null;
  status: string;
  last_run_at: string | null;
  delivery_channel?: "whatsapp" | "web_ui" | "both" | null;
}

export async function fireScheduledReminders(): Promise<ReminderRunResult> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  // Atomic claim: marca pending → running em uma só query
  const { data: claimed } = await supabase
    .from("assistant_scheduled_tasks")
    .update({ status: "running" })
    .eq("status", "pending")
    .lte("next_run_at", nowIso)
    .in("task_type", ["reminder", "recurring_reminder"])
    .select("*")
    .order("next_run_at", { ascending: true })
    .limit(50);

  if (!claimed || claimed.length === 0) {
    return { fired: 0, failed: 0, skipped: 0 };
  }

  let fired = 0;
  let failed = 0;
  let skipped = 0;

  for (const task of claimed as ScheduledTaskRow[]) {
    try {
      const result = await fireOne(task);
      if (result === "fired") fired++;
      else if (result === "skipped") skipped++;
      else failed++;
    } catch (err) {
      console.error(`[reminder-runner] task ${task.id} failed:`, err instanceof Error ? err.message : err);
      failed++;
      await markTaskFailed(task.id);
    }
  }

  return { fired, failed, skipped };
}

async function fireOne(task: ScheduledTaskRow): Promise<"fired" | "failed" | "skipped"> {
  const supabase = createAdminClient();
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

  // Silence gate (fix audit Phase 3): se rep não tá respondendo, evita
  // spam que dispara banimento WhatsApp. Soft warning no 2º, hard no 3º,
  // pausa no 4º. Só aplica em entregas REAIS (não em test session).
  const decision = await loadSilenceDecision(supabase, task.rep_id);
  if (!decision.canSend) {
    console.log(
      `[reminder-runner] task ${task.id} skipped (silence gate, reason=${decision.reason}) — ` +
      `${decision.shouldSetPaused ? "pausando rep" : "rep já pausado"}`,
    );
    await recordProactiveSent(supabase, task.rep_id, decision);
    await advanceTask(task);
    return "skipped";
  }

  // Prepend warning prefix se gate sinalizou (2º ou 3º proativo sem resposta)
  const finalMessage = decision.warningPrefix
    ? `${decision.warningPrefix}${message}`
    : message;

  // Web UI: insere em sparkbot_messages com channel='system' (proativa).
  // Painel web vai pegar no próximo poll e mostrar como notificação.
  if (channels.includes("web_ui")) {
    await deliverReminderWeb(task, finalMessage, title);
  }

  // WhatsApp: V3 enviaria pelo Hub real; por enquanto registra como
  // 'system' channel='whatsapp' pra histórico (e V3 envia depois).
  if (channels.includes("whatsapp")) {
    await deliverReminderWhatsapp(task, finalMessage, title);
  }

  // Persiste o counter increment + warning marker
  await recordProactiveSent(supabase, task.rep_id, decision);
  await advanceTask(task);
  return "fired";
}

async function deliverReminderWeb(
  task: ScheduledTaskRow,
  message: string,
  title: string | undefined,
): Promise<void> {
  const supabase = createAdminClient();
  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  if (!hubLocationId) {
    console.warn("[reminder-runner] ASSISTANT_HUB_LOCATION_ID não configurado — pulando entrega web");
    return;
  }
  // Resolve agent_id (sparkbot do Hub)
  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  if (!hubAgent) return;

  await supabase.from("sparkbot_messages").insert({
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
    },
  });
}

async function deliverReminderWhatsapp(
  task: ScheduledTaskRow,
  message: string,
  title: string | undefined,
): Promise<void> {
  // C1 fix: tenta enviar WhatsApp real via GHL conversations/messages.
  // Antes deste fix, lembretes WhatsApp NUNCA chegavam no celular — só
  // marcavam pending_v3_send que ninguém consumia.
  //
  // Comportamento controlado por env vars:
  //   - WHATSAPP_DELIVERY_ENABLED=1 (default 0): tenta envio real via GHL
  //   - WHATSAPP_DELIVERY_LOCATION_ID: location pra usar pra enviar (se rep
  //     tem múltiplas, fixa essa); fallback pra task.location_id
  //
  // Se delivery falha (ou flag off), faz FALLBACK pro web: insere msg
  // como channel='system' (badge no painel) — assim lembrete não some
  // silenciosamente, rep vê na próxima vez que abrir o GHL.

  const supabase = createAdminClient();
  const hubLocationId = process.env.ASSISTANT_HUB_LOCATION_ID?.trim();
  const hubCompanyId = process.env.ASSISTANT_HUB_COMPANY_ID?.trim()
    || process.env.NEXT_PUBLIC_GHL_COMPANY_ID?.trim();
  if (!hubLocationId) return;

  const { data: hubAgent } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", hubLocationId)
    .eq("type", "account_assistant")
    .eq("status", "active")
    .maybeSingle();
  if (!hubAgent) return;

  const formattedMessage = `🔔 ${title || "Lembrete"}\n\n${message}`;
  const enabled = process.env.WHATSAPP_DELIVERY_ENABLED === "1";

  // Tenta envio WhatsApp real
  let sentViaWhatsapp = false;
  let sendError: string | null = null;
  if (enabled && hubCompanyId) {
    try {
      // Resolve qual location usar pra enviar.
      // Fix bug observado em prod 2026-05-03: antes default era task.location_id
      // (a active_location do rep) — mas Stevo/Evolution tá conectado na HUB,
      // não em locations random. GHL aceitava o POST mas a msg ficava sem
      // provider e nunca saía. Default agora é hub; task.location_id é
      // último fallback (dev/staging sem hub).
      const sendLocationId = process.env.WHATSAPP_DELIVERY_LOCATION_ID?.trim()
        || hubLocationId
        || task.location_id;

      // Resolve rep info pra encontrar phone/contact
      const { data: rep } = await supabase
        .from("rep_identities")
        .select("phone, ghl_users")
        .eq("id", task.rep_id)
        .maybeSingle();

      if (!rep || !rep.phone || rep.phone.startsWith("webonly:")) {
        throw new Error(`rep ${task.rep_id} sem phone real (web-only)`);
      }

      // Busca contact_id do rep no GHL pela phone (ou ghl_user_id)
      const { GHLClient } = await import("@/lib/ghl/client");
      const ghlClient = new GHLClient(hubCompanyId, sendLocationId);

      // Busca contact pelo phone (pode existir como contact regular ou criar)
      type ContactSearchResult = {
        contacts?: Array<{ id: string; phone?: string }>;
        results?: Array<{ id: string; phone?: string }>;
      };
      const search = await ghlClient.get<ContactSearchResult>(
        "/contacts/search/duplicate",
        { locationId: sendLocationId, number: rep.phone },
      ).catch(() => null);

      let contactId = search?.contacts?.[0]?.id || search?.results?.[0]?.id;

      // Se não achou, cria contact mínimo (pra poder enviar msg)
      // Fix bug observado em prod 2026-05-03: o /contacts/search/duplicate às
      // vezes não acha o contato (formato do phone, quirk da API V2), aí o
      // create devolve 400 com `meta.contactId` apontando pro existente.
      // Em vez de explodir, extraímos esse ID do erro e usamos.
      if (!contactId) {
        try {
          const created = await ghlClient.post<{ contact: { id: string } }>(
            "/contacts/",
            {
              locationId: sendLocationId,
              phone: rep.phone,
              firstName: "Spark Rep",
              lastName: task.rep_id.slice(0, 8),
              tags: ["sparkbot-rep"],
            },
          );
          contactId = created.contact?.id;
        } catch (createErr) {
          // GHL devolve 400 com body JSON contendo `meta.contactId` quando o
          // location bloqueia duplicado. Parse a mensagem do erro pra extrair.
          const errMsg = createErr instanceof Error ? createErr.message : String(createErr);
          const jsonMatch = errMsg.match(/\{[\s\S]*\}/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]) as {
                statusCode?: number;
                message?: string;
                meta?: { contactId?: string };
              };
              if (parsed.statusCode === 400 && parsed.meta?.contactId) {
                contactId = parsed.meta.contactId;
                console.log(
                  `[reminder-runner] contact existente extraído do erro 400 do GHL: ${contactId}`,
                );
              }
            } catch {
              // JSON não parseou — relança erro original
            }
          }
          if (!contactId) throw createErr;
        }
      }

      if (!contactId) throw new Error("não consegui resolver contact_id no GHL");

      // Envia via canal preferido (SMS via Stevo agora; WhatsApp quando
      // API liberada). Helper centralizado em outbound-channel.ts.
      const { pickOutboundChannel, fallbackChannel } = await import("../outbound-channel");
      const outboundType = pickOutboundChannel();
      try {
        await ghlClient.post("/conversations/messages", {
          type: outboundType,
          contactId,
          message: formattedMessage,
        });
      } catch (sendErr) {
        const fb = fallbackChannel(outboundType);
        console.warn(`[reminder-runner] send ${outboundType} falhou — fallback ${fb}:`, sendErr instanceof Error ? sendErr.message : sendErr);
        await ghlClient.post("/conversations/messages", {
          type: fb,
          contactId,
          message: formattedMessage,
        });
      }
      sentViaWhatsapp = true;
    } catch (err) {
      sendError = err instanceof Error ? err.message : String(err);
      console.warn(
        `[reminder-runner] WhatsApp delivery falhou pra task ${task.id}, ` +
        `fallback pro painel web: ${sendError}`,
      );
    }
  }

  // Insere registro em sparkbot_messages.
  // - Se enviou via WhatsApp: read_in_web_at=now (não badge no web)
  // - Se falhou OU flag desabilitada: read_in_web_at=null (badge no web pra
  //   rep não perder o lembrete)
  await supabase.from("sparkbot_messages").insert({
    rep_id: task.rep_id,
    hub_location_id: hubLocationId,
    agent_id: hubAgent.id,
    active_location_id: task.location_id,
    role: "agent",
    content: formattedMessage,
    channel: sentViaWhatsapp ? "whatsapp" : "system",
    read_in_web_at: sentViaWhatsapp ? new Date().toISOString() : null,
    metadata: {
      reminder_id: task.id,
      task_type: task.task_type,
      source: "scheduled_reminder",
      whatsapp_sent: sentViaWhatsapp,
      whatsapp_send_error: sendError,
      whatsapp_delivery_enabled: enabled,
    },
  });
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
 * Avança o estado da task após disparo:
 *   - one-shot: marca como completed
 *   - recurring: calcula próximo next_run_at do cron e volta pra pending
 */
async function advanceTask(task: ScheduledTaskRow): Promise<void> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  if (task.task_type === "recurring_reminder" && task.cron_expr) {
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
