import { GHLClient } from "@/lib/ghl/client";
import { channelToMessageType } from "@/lib/ghl/channel";
import { createAdminClient } from "@/lib/supabase/admin";
import { resolveMeetingLocation } from "@/lib/queue/meeting-links";
import { healMissingMeetingLocation } from "@/lib/queue/meeting-location";
import { sanitizeOutbound, resolveForbiddenTerms } from "@/lib/ai/outbound-sanitizer";
import { splitLeadOutbound } from "@/lib/ai/message-splitter";
import {
  addTagsToContact,
  removeTagsFromContact,
  updateContactField,
  isBookingConflictError,
  findContactOpportunityId,
  updateOpportunity,
  resolvePipelineStage,
} from "@/lib/ghl/operations";
import { reportError } from "@/lib/admin-signals/report-error";
import { stripSilenceMarker, type LeadSilenceDecision } from "@/lib/ai/lead-silence";
import { validateBookingSlot, isSameSlotInstant } from "@/lib/ai/slot-guard";
import { aplicarGuardaDeConfirmacao, claimsBooking } from "@/lib/ai/booking-guard";
import type { AIAction, AIResponse } from "@/types/ai";

// Delay curto entre mensagens (max 1.5s para não causar timeout no serverless)
function shortDelay(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 500 + Math.random() * 1000));
}

function normalizeMessages(message: string | string[]): string[] {
  if (Array.isArray(message)) {
    return message.filter((m) => typeof m === "string" && m.trim());
  }
  if (typeof message === "string" && message.trim()) {
    return [message];
  }
  return [];
}

interface ExecutionContext {
  companyId: string;
  locationId: string;
  contactId: string;
  agentId: string;
  conversationId: string;
  channel?: string;
  calendarId?: string;         // Calendar ID do config (overrides o que a IA manda)
  skipSendMessage?: boolean;
  testMode?: boolean;
  // Gate contact-first (caso Marina, pós-stress 2026-06-28): quando true e sem
  // WhatsApp/telefone em collectedData, dropa book_appointment (sem appointment
  // real prematuro). Derivado de post_booking.require_contact_before_booking.
  requireContactBeforeBooking?: boolean;
  collectedData?: Record<string, string>;
  // Termos proibidos (caso Marina): redigidos da saída antes de enviar/logar.
  forbiddenTerms?: string[];
  // MC-9: decisão de silêncio computada pelo caller (evaluateLeadSilence).
  // Ausente = gate desligado = comportamento legado (sempre envia).
  silenceDecision?: LeadSilenceDecision;
  /**
   * H58 (caso Alves Cury 2026-07-29): lista ISO dos free-slots REAIS buscados
   * neste turno (a mesma injetada no prompt). book/reschedule só aceitam
   * start_time que bata com um destes. undefined = caller não threadou
   * (back-compat, permite); [] = fetch falhou/sem slots (bloqueia booking).
   */
  offeredSlotsIso?: string[];
}

// Detecta um canal de contato (WhatsApp/telefone) já coletado — usado pelo gate
// de booking contact-first. >=6 chars evita tratar "sim"/"ok" como telefone.
function hasCollectedContact(data?: Record<string, string>): boolean {
  if (!data) return false;
  const keys = ["whatsapp", "whats", "phone", "telefone", "celular", "cell", "tel"];
  return Object.entries(data).some(
    ([k, v]) =>
      typeof v === "string" &&
      v.replace(/\D/g, "").length >= 6 &&
      keys.some((kk) => k.toLowerCase().includes(kk))
  );
}

// Mapeia canal para o "type" da API de mensagens do GHL
export async function executeActions(
  response: AIResponse,
  ctx: ExecutionContext
): Promise<void> {
  const client = new GHLClient(ctx.companyId, ctx.locationId);
  const supabase = createAdminClient();

  const messageType = channelToMessageType(ctx.channel);

  // 1. Executar acoes PRIMEIRO (book, reschedule, update fields, tags)
  // Fix HIGH-10 (deep review 2026-05-05): dedup actions por
  // (type, calendar_id?, start_time?, appointment_id?, field_key?, tag?,
  // pipeline_id?, stage_id?). Antes, LLM podia retornar mesma action 2x
  // (book_appointment com mesmo start_time) → race em findExistingAppointment
  // criava 2 appointments OU update incorreto.
  const dedupKey = (a: typeof response.actions[number]): string => {
    return JSON.stringify({
      t: a.type,
      f: a.field_key || "",
      v: a.value || "",
      tag: a.tag || "",
      cal: a.calendar_id || "",
      st: a.start_time || "",
      apt: a.appointment_id || "",
      pip: a.pipeline_id || "",
      stg: a.stage_id || "",
    });
  };
  const seen = new Set<string>();
  const dedupedActions = response.actions.filter((a) => {
    const k = dedupKey(a);
    if (seen.has(k)) {
      console.warn("[ActionExecutor] Skipping duplicate action:", a.type);
      return false;
    }
    seen.add(k);
    return true;
  });

  let actionsFailed = false;
  let failedActionError = "";
  // H58: o guarda de confirmação precisa do desfecho do AGENDAMENTO
  // especificamente — `actionsFailed` é agregado, então uma falha de booking
  // ficaria indistinguível de uma falha de update_field.
  const BOOKING_ACTIONS = new Set(["book_appointment", "reschedule_appointment"]);
  let tentouAgendar = false;
  let agendouComSucesso = false;

  for (const action of dedupedActions) {
    const ehAgendamento = BOOKING_ACTIONS.has(action.type);
    if (ehAgendamento) tentouAgendar = true;
    try {
      await executeAction(client, action, ctx);
      await logExecution(supabase, ctx, action.type, { ...action });
      if (ehAgendamento) agendouComSucesso = true;
    } catch (error) {
      actionsFailed = true;
      failedActionError = error instanceof Error ? error.message : String(error);
      await logExecution(supabase, ctx, action.type, { ...action }, false, error);
    }
  }

  // 2. Enviar mensagem(ns) pelo mesmo canal (pula no modo teste)
  let messages = normalizeMessages(response.message);

  // MC-9 (review Marcia 2026-07-28): gate de silêncio determinístico. Silêncio
  // SÓ com sinal EXPLÍCITO do modelo (should_send_message:false ou marcador
  // [[NAO_ENVIAR]]) + opt-in do agente (allow_silent_turns) + overrides
  // fail-open-pra-falar (1º turno / pergunta) já computados no caller
  // (ctx.silenceDecision). Actions/estado/billing rodaram normalmente acima —
  // silêncio suprime SÓ o envio. Exceção: erro de booking IGNORA o silêncio
  // (o lead precisa saber que o agendamento falhou).
  const silence = ctx.silenceDecision;
  const bookingFailedNeedsVoice =
    actionsFailed &&
    (failedActionError.includes("BOOK_GATE_NO_CONTACT") || isBookingConflictError(failedActionError));
  const silentTurn = !!silence?.silent && !bookingFailedNeedsVoice;
  if (silence?.silent && bookingFailedNeedsVoice) {
    await logExecution(supabase, ctx, "silence_overridden", { via: silence.via, reason: "booking_error" });
  }

  // Strip INCONDICIONAL do marcador (mesmo com gate OFF / turno não-silencioso):
  // sem isto, um "[[NAO_ENVIAR]]" emitido fora do follow-up iria CRU pro lead.
  const stripped = stripSilenceMarker(messages);
  messages = Array.isArray(stripped) ? stripped : stripped ? [stripped] : [];

  if (silentTurn) {
    await logExecution(supabase, ctx, "silence_decided", {
      via: silence!.via,
      messages_suppressed: messages.length,
    });
    console.log(`[ActionExecutor] MC-9: turno silencioso (via=${silence!.via}) — nada enviado.`);
    messages = [];
  } else if (messages.length === 0) {
    if (response.should_send_message === false && silence?.gateOn) {
      // Gate ON: o agente OPTOU por silêncio — modelo pediu (flag) e não há
      // texto: audita e segue sem inventar mensagem (hardening B6: o fallback
      // genérico "Pode me contar mais?" atirado num turno de intake era
      // exatamente a queixa "mensagem sem sentido depois do lead dar os dados").
      await logExecution(supabase, ctx, "empty_response_skip", { model_silent: true, gate_on: true });
      console.warn("[ActionExecutor] Modelo pediu silêncio (gate ON) — pulando envio (sem fallback).");
    } else {
      // Vazio acidental OU flag=false SEM opt-in do agente (H61 v2, review
      // adversarial 2026-08-01): a frota gate-OFF não escolheu mudez — com o
      // pass-through do flag restaurado, engolir o envio aqui deixaria lead
      // sem resposta (pior que o fallback feio). Mantém a rede legada =
      // byte-idêntico ao prod pré-H61 pra quem não ligou allow_silent_turns.
      if (response.should_send_message === false) {
        await logExecution(supabase, ctx, "model_silent_fallback", { gate_on: false });
      }
      console.warn("[ActionExecutor] Empty message, using neutral continuation");
      messages = ["Pode me contar mais sobre isso?"];
    }
  }

  // Bloqueio determinístico de termos proibidos (caso Marina 2026-07-01): redige
  // ANTES de enviar E de logar, então o que sai e o que fica no histórico batem.
  // resolveForbiddenTerms: config do DB > code-map por agentId > vazio. Sem isto
  // (passando só ctx.forbiddenTerms), o caminho da resposta principal era NO-OP
  // enquanto a coluna forbidden_terms não existe no DB — National Life vazava.
  const sanitized = sanitizeOutbound(messages, resolveForbiddenTerms(ctx.agentId, ctx.forbiddenTerms));
  if (sanitized.redacted) {
    messages = sanitized.messages;
    console.warn("[Sanitizer] Redacted forbidden terms:", sanitized.hits.join(", "));
    await logExecution(supabase, ctx, "outbound_sanitized", { hits: sanitized.hits });
  }

  // Guarda determinística de tamanho (healthcheck 2026-07-23, caso five star
  // ricos): quebra "wall of text" (700-800 chars numa bolha) em bolhas curtas
  // ANTES de enviar. Roda DEPOIS do sanitizer (o texto redigido também é
  // limitado) e é no-op pra mensagem já curta. Loop de envio abaixo já entrega
  // cada bolha como uma mensagem separada com delay.
  const split = splitLeadOutbound(messages);
  if (split.didSplit) {
    messages = split.messages;
    console.log(`[Splitter] Bolha longa quebrada → ${messages.length} bolhas`);
    await logExecution(supabase, ctx, "outbound_split", { parts: messages.length });
  }

  // H58 (caso Marilia 2026-07-26) — NUNCA afirmar agendamento que não aconteceu.
  //
  // O `slot-guard` (caso Alves Cury) impede o booking ERRADO. Este aqui cobre o
  // que sobra: o booking que falha por QUALQUER outro motivo. O LLM escreve a
  // mensagem ANTES de saber o desfecho da action — na Marilia o booking falhou
  // 14:01:53 e ela recebeu "Ótimo, segunda às 4 PM ET tá marcado 🎉" às 14:01:54.
  //
  // O tratamento que existia dependia de CLASSIFICAR a string do erro, e uma
  // string ambígua o desarmou. Este guarda não classifica nada: olha o FATO —
  // houve booking bem-sucedido neste turno? Se não, a afirmação não sai.
  // Mesmo princípio do H41 ("só afirmar o count real") e do H50 (booked_label).
  const guardaConfirm = aplicarGuardaDeConfirmacao(messages, {
    afirmaAgendamento: messages.some(claimsBooking),
    tentouAgendar,
    agendouComSucesso,
  });
  if (guardaConfirm.bloqueou) {
    messages = guardaConfirm.mensagens;
    console.warn(
      `[BookingGuard] Afirmação de agendamento BLOQUEADA (${guardaConfirm.motivo}) — trocada por texto honesto.`,
    );
    await logExecution(supabase, ctx, "false_booking_claim_blocked", {
      motivo: guardaConfirm.motivo,
      tentou_agendar: tentouAgendar,
      agendou_com_sucesso: agendouComSucesso,
      erro: failedActionError || null,
    });
    reportError({
      title: "Agente lead-facing: afirmou agendamento sem ter agendado",
      feature: "lead-booking-guard",
      severity: "high",
      description:
        `O modelo escreveu confirmação de agendamento mas ${
          tentouAgendar ? "o booking FALHOU" : "nenhuma action de agendamento foi emitida"
        }. O texto foi trocado antes de sair — a lead não recebeu confirmação falsa.`,
      metadata: {
        location_id: ctx.locationId,
        contact_id: ctx.contactId,
        agent_id: ctx.agentId,
        motivo: guardaConfirm.motivo,
        erro: failedActionError || null,
      },
    });
  }

  if (!ctx.skipSendMessage && messages.length > 0) {
    try {
      // Gate contact-first disparou: troca a confirmação (potencialmente falsa) do
      // LLM por um pedido de WhatsApp, em vez de "não consegui agendar".
      const isBookGateBlocked = actionsFailed && failedActionError.includes("BOOK_GATE_NO_CONTACT");
      // Se agendamento falhou, avisar o lead. Detection centralizada em lib/ghl/operations.ts.
      const isBookingError = !isBookGateBlocked && actionsFailed && isBookingConflictError(failedActionError);
      if (isBookGateBlocked) {
        const askMsg = "Boa! Pra eu confirmar teu lugar no encontro, me passa teu WhatsApp por aqui? 😊";
        // Ultra-review 2026-08-03: estes 2 branches eram os ÚNICOS send-paths sem
        // message_ids no log → o anti-eco (F52/H56) não reconhecia a mensagem
        // como NOSSA e pausava a IA achando que um humano assumiu — o bot
        // perguntava "posso sugerir outro?" e IGNORAVA a resposta do lead.
        const sentAsk = await client.post<{ messageId?: string }>("/conversations/messages", {
          type: messageType,
          contactId: ctx.contactId,
          message: askMsg,
        });
        await logExecution(supabase, ctx, "book_blocked_no_contact", {
          message: askMsg,
          ...(sentAsk?.messageId ? { message_ids: [sentAsk.messageId] } : {}),
        });
      } else if (isBookingError) {
        const errorMsg = "Desculpa, nao consegui agendar nesse horario. Posso sugerir outro?";
        const sentErr = await client.post<{ messageId?: string }>("/conversations/messages", {
          type: messageType,
          contactId: ctx.contactId,
          message: errorMsg,
        });
        await logExecution(supabase, ctx, "send_error_message", {
          message: errorMsg,
          ...(sentErr?.messageId ? { message_ids: [sentErr.messageId] } : {}),
        });
      } else {
        // 2026-07-23 (caso Marina): captura o messageId que o GHL retorna em cada
        // envio → grava em message_ids no log. O anti-eco do handoff (F52) casa por
        // ESSE id (determinístico), não só por texto — em IG o canal mangleia o
        // corpo e userId vem vazio, então o texto falhava e a IA se auto-pausava
        // achando que um humano tinha assumido (152 falsos positivos).
        const messageIds: string[] = [];
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          if (!msg.trim()) continue;

          if (i > 0) {
            await shortDelay();
          }

          const sent = await client.post<{ messageId?: string }>("/conversations/messages", {
            type: messageType,
            contactId: ctx.contactId,
            message: msg,
          });
          if (sent?.messageId) messageIds.push(sent.messageId);
        }

        await logExecution(supabase, ctx, "send_message", {
          message: messages,
          message_ids: messageIds,
          parts: messages.length,
          channel: ctx.channel || "SMS",
        });
      }
    } catch (error) {
      await logExecution(supabase, ctx, "send_message", { message: response.message }, false, error);
      // Sweep ultra-review 2026-06-15: este era o ÚNICO send-path lead-facing mudo no
      // catch (só logExecution, sem alerta). GHL/Stevo caindo = lead sem resposta e
      // ZERO sinal pro admin (ponto cego do F49). reportError → admin_signal high +
      // Sentry. NÃO re-lança de propósito: preserva o fluxo atual (grupo conclui, sem
      // retry/double-send) — mudar pra retry exige eval supervisionado.
      reportError({
        title: "Agente lead-facing: falha ao enviar mensagem",
        feature: "action-executor-send",
        error,
        severity: "high",
        description:
          "client.post(/conversations/messages) falhou no envio pro lead (sales/recruitment). Lead pode não ter recebido a resposta.",
        metadata: {
          location_id: ctx.locationId,
          contact_id: ctx.contactId,
          agent_id: ctx.agentId,
          channel: ctx.channel || "SMS",
        },
      });
    }
  }

  // 3. Atualizar conversation_state — SKIP em test mode pra não poluir
  // estado real da conversa do contato.
  // Fix CRIT-1 (deep review 2026-05-05): antes, testar agente em /test
  // com execActions=true E contact_id real corrompia conversation_state
  // de prod (last_ai_response_at, message_count, status, conversation_id).
  // Resultado: bot real ficava com follow-ups cancelados, summary gerado
  // antecipadamente, contagem inflada. Agora testMode preserva estado real.
  if (!ctx.testMode) {
    await updateConversationState(supabase, ctx, response);
  }
}

async function executeAction(
  client: GHLClient,
  action: AIAction,
  ctx: ExecutionContext
): Promise<void> {
  if (ctx.testMode) {
    console.log(`[TEST] Would execute: ${action.type}`, JSON.stringify(action).substring(0, 200));
    return;
  }

  switch (action.type) {
    case "update_field":
      if (action.field_key && action.value) {
        // Sales/recruitment legado prefixa standard fields com "contact." —
        // ex: "contact.firstName". updateContactField espera só o key, sem prefix.
        const key = action.field_key.startsWith("contact.")
          ? action.field_key.slice("contact.".length)
          : action.field_key;
        await updateContactField(client, ctx.contactId, key, action.value);
      }
      break;

    case "add_tag":
      if (action.tag) {
        await addTagsToContact(client, ctx.contactId, [action.tag]);
      }
      break;

    case "remove_tag":
      if (action.tag) {
        await removeTagsFromContact(client, ctx.contactId, [action.tag]);
      }
      break;

    case "book_appointment": {
      // Gate determinístico contact-first (caso Marina, pós-stress 2026-06-28):
      // sem WhatsApp/telefone coletado, NÃO cria appointment real — o LLM às vezes
      // "soft-booka" na escolha do dia antes de coletar o contato (booking_order
      // 25% no stress test). Bloqueia o booking irreversível no CRM; o handler de
      // mensagem troca a confirmação falsa por um pedido de WhatsApp.
      if (ctx.requireContactBeforeBooking && !hasCollectedContact(ctx.collectedData)) {
        throw new Error("BOOK_GATE_NO_CONTACT");
      }
      const bookCalendarId = ctx.calendarId || action.calendar_id;
      if (!bookCalendarId) {
        throw new Error("Calendario nao configurado — agendamento impossivel");
      }
      // H58: start_time TEM que ser um slot real do turno (bloqueia booking
      // fantasma/fuso trocado; o throw cai em isBookingConflictError → o lead
      // recebe a correção, não uma falsa confirmação).
      {
        const slotCheck = validateBookingSlot(action.start_time, ctx.offeredSlotsIso);
        if (!slotCheck.ok) {
          // H61 (fix bug observado em prod 2026-08-01, caso Adriana/Five Star):
          // rajada vira 2 turnos e o 2º re-emite book_appointment pro MESMO
          // horário — o slot já saiu do free-slots (consumido pelo booking do
          // turno 1), o guard H58 bloqueava e o lead recebia "não consegui
          // agendar" 20s depois do "confirmado!". Se o contato JÁ tem
          // appointment futuro nesse exato start_time, é o próprio booking do
          // turno anterior → sucesso idempotente (sem erro falso, sem tocar o
          // calendário). Fetch extra SÓ no caminho que já ia falhar. v2:
          // preferStartTime resolve contato com 2+ appointments futuros.
          const dup = await findExistingAppointment(client, ctx.contactId, ctx.locationId, action.start_time).catch(() => null);
          if (dup && isSameSlotInstant(dup.startTime, action.start_time)) {
            (action as unknown as Record<string, unknown>).mode = "idempotent_noop";
            (action as unknown as Record<string, unknown>).existing_appointment_id = dup.id;
            break;
          }
          throw new Error(`book_appointment bloqueado: ${slotCheck.reason}`);
        }
      }
      // Link da reunião por calendário (caso Marina 2026-06-28): quando o calendário
      // tem link FIXO mapeado, injeta address+override. Sem mapeamento = null e
      // NADA de campo de local vai no payload — é assim que o Spark Leads aplica o
      // default do calendário (H65, ver meeting-location.ts).
      const meetingLoc = resolveMeetingLocation(bookCalendarId);
      if (bookCalendarId && action.start_time) {
        const existingApptForBook = await findExistingAppointment(client, ctx.contactId, ctx.locationId);

        if (existingApptForBook) {
          // Tentar atualizar o existente primeiro (evita duplicatas)
          try {
            await client.put(`/calendars/events/appointments/${existingApptForBook.id}`, {
              calendarId: bookCalendarId,
              startTime: action.start_time,
              title: action.title || existingApptForBook.title,
              ...(meetingLoc ?? {}),
            });
            // H65: diferente do create, o UPDATE do Spark Leads NUNCA regenera o
            // local — reunião que nasceu vazia (antes deste fix) continuaria sem
            // link depois de remarcada. Cura best-effort: só age se o address
            // está vazio e só com a config REAL do calendário. Nunca sobrescreve
            // local preenchido (o rep pode ter editado à mão).
            if (!meetingLoc) {
              await healMissingMeetingLocation(client, existingApptForBook.id, bookCalendarId);
            }
            await tagBookedByAi(client, ctx.contactId); // tag interna (ver nota abaixo)
            // MC-10 (review Marcia 2026-07-28): o log genérico ({...action}) não
            // distinguia CREATE de RESCHEDULE — 2 "bookings" em 27s pareciam
            // double-booking quando o 2º era update do existente. Marca o modo.
            (action as unknown as Record<string, unknown>).mode = "reschedule";
            (action as unknown as Record<string, unknown>).rescheduled_from = existingApptForBook.id;
            break;
          } catch {
            try {
              await client.delete(`/calendars/events/appointments/${existingApptForBook.id}`);
            } catch {
              console.warn("[BookAppointment] Could not delete existing, creating new (may duplicate)");
            }
          }
        }

        try {
          await client.post("/calendars/events/appointments", {
            calendarId: bookCalendarId,
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: action.title || "Reunião agendada",
            // H65 (caso Liberty Financial 2026-08-04): aqui ia
            // `meetingLocationType:"phone"` fixo — e isso APAGAVA o local default
            // do calendário (Google Meet/Zoom configurado no membro do time). A
            // reunião nascia com address vazio e a automação de confirmação
            // mandava "Local do nosso encontro:" em branco pro lead. Não mandar
            // campo nenhum é o que faz o Spark Leads resolver o default.
            ...(meetingLoc ?? {}),
          });
          // Tag interna "agendado pela ia" (Pedro 2026-06-22): rastreia no CRM que
          // a IA agendou, SEM poluir o título/convite da reunião. Non-blocking.
          await tagBookedByAi(client, ctx.contactId);
        } catch (bookingError) {
          // Re-classify slot/availability errors with an actionable message
          if (bookingError instanceof Error &&
              (bookingError.message.includes("available") || bookingError.message.includes("slot") || bookingError.message.includes("422"))) {
            console.log("[BookAppointment] Slot unavailable, attempting next slot...");
            // H58 (caso Marilia 2026-07-26): esta frase dizia "Calendario nao
            // configurado ou horario indisponivel" — as DUAS causas na mesma
            // string. O isBookingConflictError testa "config" PRIMEIRO e devolve
            // false, então o guarda que trocaria a confirmação falsa por "não
            // consegui agendar" nunca disparava: a lead ouviu "tá marcado" 1
            // segundo depois do booking falhar. A frase escrita pra deixar o
            // erro acionável foi o que desarmou o tratamento dele.
            throw new Error("horario indisponivel");
          }
          throw bookingError;
        }
      }
      break;
    }

    case "reschedule_appointment":
      // H58: reagendamento passa pelo MESMO guard de slot real (lição H42).
      {
        const reslotCheck = validateBookingSlot(action.start_time, ctx.offeredSlotsIso);
        if (!reslotCheck.ok) {
          // H61: mesma idempotência do book_appointment — reagendar pro horário
          // que o contato JÁ tem é duplicata de rajada, não conflito. Sem isto,
          // o caminho delete-then-create nem chega a rodar mas o lead ganha o
          // erro falso; e evitar entrar à toa no delete também protege contra
          // o create pós-delete falhar (reunião sumiria). v2 (review): quando o
          // LLM passou appointment_id, o noop SÓ vale se a duplicata é AQUELE
          // appointment — sem isso, "mover B pro horário do A" virava falso
          // sucesso sem mover nada.
          const dup = await findExistingAppointment(client, ctx.contactId, ctx.locationId, action.start_time).catch(() => null);
          const sameTarget = !action.appointment_id || (dup && String(dup.id) === String(action.appointment_id));
          if (dup && sameTarget && isSameSlotInstant(dup.startTime, action.start_time)) {
            (action as unknown as Record<string, unknown>).mode = "idempotent_noop";
            (action as unknown as Record<string, unknown>).existing_appointment_id = dup.id;
            break;
          }
          throw new Error(`reschedule_appointment bloqueado: ${reslotCheck.reason}`);
        }
      }
      if (action.start_time) {
        // FIX CRITICAL stress test 2026-05-03: usar appointment_id explícito
        // se a IA passou. Antes ignorava e re-buscava — em contatos com 2+
        // appointments futuros (multi-calendar), reagendava o ERRADO.
        let targetApptId: string | undefined;
        let targetCalId: string | undefined;
        let targetTitle: string | undefined;
        if (action.appointment_id && /^[A-Za-z0-9]{18,}$/.test(String(action.appointment_id))) {
          targetApptId = String(action.appointment_id);
          targetCalId = action.calendar_id ? String(action.calendar_id) : undefined;
          targetTitle = action.title ? String(action.title) : undefined;
        } else {
          const existingAppt = await findExistingAppointment(client, ctx.contactId, ctx.locationId);
          if (existingAppt) {
            targetApptId = existingAppt.id;
            targetCalId = existingAppt.calendarId;
            targetTitle = existingAppt.title;
          }
        }

        if (targetApptId) {
          try {
            await client.delete(`/calendars/events/appointments/${targetApptId}`);
          } catch {
            // Se falhar ao deletar, continua e cria novo
          }
          await client.post("/calendars/events/appointments", {
            calendarId: ctx.calendarId || targetCalId,
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: targetTitle || "Reunião reagendada",
            // H65: sem campo de local = Spark Leads aplica o default do calendário.
            ...(resolveMeetingLocation(ctx.calendarId || targetCalId) ?? {}),
          });
        } else {
          // Ultra-review 2026-08-03: sem appointment existente E sem calendário
          // conhecido, o POST saía com calendarId "" → 422 do GHL (3× na semana,
          // 2 agentes) e o lead ficava com a remarcação "feita" que falhou.
          // Resolve na ordem action → config; sem nenhum, erro CLARO que o guard
          // H58 traduz em mensagem honesta pro lead.
          const rescheduleCalId = action.calendar_id || ctx.calendarId;
          if (!rescheduleCalId) {
            throw new Error("horario indisponivel: reagendamento sem calendario conhecido");
          }
          await client.post("/calendars/events/appointments", {
            calendarId: rescheduleCalId,
            locationId: ctx.locationId,
            contactId: ctx.contactId,
            startTime: action.start_time,
            title: "Reuniao agendada via AI",
            // H65: sem campo de local = Spark Leads aplica o default do calendário.
            ...(resolveMeetingLocation(rescheduleCalId) ?? {}),
          });
        }
      }
      break;

    case "move_pipeline":
      if (action.pipeline_id && action.stage_id) {
        // Ultra-review 2026-08-03: LLM/automação às vezes passa o NOME do funil
        // ou da etapa no campo de id → GHL falha/ignora em silêncio e o lead
        // nunca anda no funil (7 falhas, 2 agentes). Resolve id-ou-nome ANTES.
        const resolved = await resolvePipelineStage(
          client,
          ctx.locationId,
          String(action.pipeline_id),
          String(action.stage_id),
        );
        if (!resolved) {
          throw new Error(
            `move_pipeline: funil/etapa "${action.pipeline_id}"/"${action.stage_id}" não existe na location`,
          );
        }
        // Fix bug observado em prod 2026-06-10: move_pipeline fazia
        // PUT /opportunities/ sem oppId → 4xx → throw silencioso → etapa
        // NUNCA mudava (lead recebia "movi você" sem ter movido). A GHL
        // exige o oppId no path; resolvemos a opp do contato antes do PUT.
        const oppId = await findContactOpportunityId(
          client,
          ctx.locationId,
          ctx.contactId,
          resolved.pipelineId,
        );
        if (!oppId) {
          console.warn(
            `[ActionExecutor] move_pipeline: contato ${ctx.contactId} sem opportunity no Spark Leads — skip`,
          );
          break;
        }
        await updateOpportunity(client, oppId, {
          pipelineId: resolved.pipelineId,
          pipelineStageId: resolved.stageId,
        });
      }
      break;

    case "send_message":
      break;
  }
}

/**
 * Marca no CRM que o agendamento foi feito pela IA — tag INTERNA, não aparece no
 * título/convite da reunião (Pedro 2026-06-22: tirou "via AI" do invite e pediu
 * o rastro via tag na automação). Non-blocking: o booking já aconteceu; se a tag
 * falhar, só loga (não derruba o fluxo).
 */
async function tagBookedByAi(client: GHLClient, contactId: string): Promise<void> {
  try {
    await addTagsToContact(client, contactId, ["agendado pela ia"]);
  } catch (e) {
    console.warn(
      "[BookAppointment] falha ao adicionar tag 'agendado pela ia' (non-blocking):",
      e instanceof Error ? e.message : e,
    );
  }
}

/**
 * Busca appointment existente (futuro) para um contato.
 * Tenta multiplos endpoints da GHL API.
 */
/**
 * H61 v2 (review adversarial 2026-08-01): entre os appointments futuros válidos,
 * prioriza o que casa o instante pedido (±60s) — sem isso, contato com 2+
 * appointments futuros fazia o check idempotente comparar contra o PRIMEIRO do
 * array (ordem do GHL, não garantida), errando pros dois lados: não disparava
 * na duplicata real E podia casar o appointment errado. Puro, exportado pra teste.
 */
export function pickFutureAppointment<
  T extends { startTime: string; status?: string; appointmentStatus?: string },
>(items: T[], now: Date, preferStartTime?: string): T | null {
  const futures = items.filter((e) => {
    const start = new Date(e.startTime);
    const status = (e.status || e.appointmentStatus || "").toLowerCase();
    return start > now && status !== "cancelled" && status !== "deleted";
  });
  if (futures.length === 0) return null;
  if (preferStartTime) {
    const match = futures.find((e) => isSameSlotInstant(e.startTime, preferStartTime));
    if (match) return match;
  }
  return futures[0];
}

async function findExistingAppointment(
  client: GHLClient,
  contactId: string,
  locationId: string,
  preferStartTime?: string,
): Promise<{ id: string; title: string; calendarId: string; startTime: string } | null> {
  // H6 (review 2026-04-28): GHL API tem formato variável; antes deste fix,
  // chamávamos os 3 endpoints SEQUENCIAL (~400ms p99 desnecessário em
  // booking flow). Agora rodamos os 3 em paralelo e pegamos o primeiro
  // que retorna um appointment futuro válido.
  type AppointmentItem = { id: string; title: string; calendarId: string; startTime: string; status?: string; appointmentStatus?: string };

  const endpoints = [
    { path: `/contacts/${contactId}/appointments`, params: { locationId } as Record<string, string> },
    { path: "/calendars/events/appointments", params: { locationId, contactId } as Record<string, string> },
    { path: "/calendars/events", params: { locationId, contactId } as Record<string, string> },
  ];

  const now = new Date();

  // Paraleliza todas as chamadas. Cada Promise resolve com o primeiro
  // appointment futuro válido daquele endpoint (ou null se não houver).
  const results = await Promise.allSettled(
    endpoints.map(async (ep) => {
      const result = await client.get<Record<string, unknown>>(ep.path, ep.params);
      const items: AppointmentItem[] =
        (result.events as AppointmentItem[]) ||
        (result.appointments as AppointmentItem[]) ||
        (result.data as AppointmentItem[]) ||
        [];

      console.log(`[FindAppointment] ${ep.path} returned ${items.length} items`);

      if (items.length === 0) return null;
      return pickFutureAppointment(items, now, preferStartTime);
    }),
  );

  // Prioridade pelo ordem dos endpoints (primeiro endpoint que retornou
  // resultado válido vence). Mantém comportamento legado.
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === "fulfilled" && r.value) {
      console.log(`[FindAppointment] Found via ${endpoints[i].path}: ${r.value.id} at ${r.value.startTime}`);
      return r.value;
    }
    if (r.status === "rejected") {
      console.log(
        `[FindAppointment] ${endpoints[i].path} failed:`,
        r.reason instanceof Error ? r.reason.message : r.reason,
      );
    }
  }

  console.log("[FindAppointment] No future appointments found for contact", contactId);
  return null;
}

async function updateConversationState(
  supabase: ReturnType<typeof createAdminClient>,
  ctx: ExecutionContext,
  response: AIResponse
): Promise<void> {
  // Merge collected_data com dados existentes (nao sobrescreve campos anteriores)
  const { data: existing } = await supabase
    .from("conversation_state")
    .select("collected_data, message_count, summary_note_id, segment_number")
    .eq("agent_id", ctx.agentId)
    .eq("contact_id", ctx.contactId)
    .maybeSingle();

  const previousData = (existing?.collected_data as Record<string, string>) || {};
  const mergedData = { ...previousData, ...response.collected_data };

  // Se conversa tinha nota de resumo, iniciar novo segmento
  const existingFull = existing as Record<string, unknown> | null;
  const hadSummary = existingFull?.summary_note_id && existingFull.summary_note_id !== "generating";
  const segmentReset = hadSummary ? {
    summary_note_id: null,
    summary_note_created_at: null,
    segment_number: ((existingFull?.segment_number as number) || 1) + 1,
    ai_paused_at: null,
    ai_paused_reason: null,
  } : {};

  await supabase
    .from("conversation_state")
    .upsert(
      {
        agent_id: ctx.agentId,
        location_id: ctx.locationId,
        contact_id: ctx.contactId,
        conversation_id: ctx.conversationId,
        status: response.conversation_status,
        collected_data: mergedData,
        message_count: (existing?.message_count || 0) + 1,
        last_ai_response_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...segmentReset,
      },
      { onConflict: "agent_id,contact_id" }
    );
}

async function logExecution(
  supabase: ReturnType<typeof createAdminClient>,
  ctx: ExecutionContext,
  actionType: string,
  payload: Record<string, unknown>,
  success = true,
  error?: unknown
): Promise<void> {
  await supabase.from("execution_log").insert({
    agent_id: ctx.agentId,
    conversation_id: ctx.conversationId,
    contact_id: ctx.contactId,
    location_id: ctx.locationId,
    action_type: actionType,
    action_payload: payload,
    success,
    error_message: error instanceof Error ? error.message : error ? String(error) : null,
  });
}
