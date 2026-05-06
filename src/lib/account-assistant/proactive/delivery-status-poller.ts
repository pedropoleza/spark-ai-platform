/**
 * Polling de delivery status pra mensagens proativas.
 *
 * POR QUE EXISTE: Stevo (Evolution API/Baileys, sessão WhatsApp Web não-oficial)
 * retorna 200 ao GHL POST `/conversations/messages` quando ACEITA o request,
 * mas o status real (delivered/sent/failed) só fica disponível 1-30s depois
 * via GET `/conversations/messages/{id}`.
 *
 * Antes (≤2026-05-06), nosso código só persistia `whatsapp_sent: true` no
 * momento do POST e nunca verificava status real. Quando instância Stevo
 * caía (pediu re-scan QR, sessão expirou, etc), TODAS as proativas viravam
 * `failed` no GHL/Stevo e ninguém percebia. Caso real: 35 proativas em 7
 * dias, 100% failed, bot sem visibilidade.
 *
 * O QUE ESTE POLLER FAZ:
 *  1. Busca msgs proativas com `delivery_status = pending_confirm` e
 *     `ghl_message_id` setado, criadas nas últimas 4h.
 *  2. Pra cada, GET /conversations/messages/{id} e atualiza metadata.
 *  3. Se status terminal (delivered/sent/read): marca como confirmed.
 *  4. Se status=failed: marca channel='system' (badge no painel web do
 *     rep) + cria signal admin "Stevo delivery failed".
 *  5. Se ainda em fila (queued/sending): deixa pending pra próxima rodada.
 *
 * Roda dentro do cron `sparkbot-proactive` (já agendado a cada 30s).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";

const POLL_WINDOW_HOURS = 4;
const STALE_TIMEOUT_MIN = 10; // se fica pendente >10min, força check

const TERMINAL_STATUSES = new Set([
  "delivered", "sent", "read", "completed",
]);
const FAILED_STATUSES = new Set([
  "failed", "rejected", "undelivered",
]);

interface PendingMsgRow {
  id: string;
  rep_id: string;
  hub_location_id: string;
  ghl_message_id: string;
  channel: string;
  created_at: string;
  metadata: Record<string, unknown>;
}

/**
 * Roda 1 ciclo de polling. Returns counters pra debug.
 */
export async function pollDeliveryStatuses(): Promise<{
  checked: number;
  delivered: number;
  failed: number;
  still_pending: number;
  errors: number;
}> {
  const supabase = createAdminClient();
  const counters = { checked: 0, delivered: 0, failed: 0, still_pending: 0, errors: 0 };

  // Busca msgs pendentes — usa filter via JSONB pra metadata.delivery_status.
  // Limit 50/ciclo pra não estourar latência (cron tem 60s max).
  const since = new Date(
    Date.now() - POLL_WINDOW_HOURS * 60 * 60 * 1000,
  ).toISOString();
  const { data: pending, error } = await supabase
    .from("sparkbot_messages")
    .select("id, rep_id, hub_location_id, ghl_message_id, channel, created_at, metadata")
    .eq("role", "agent")
    .not("ghl_message_id", "is", null)
    .gte("created_at", since)
    .filter("metadata->>delivery_status", "eq", "pending_confirm")
    .limit(50);
  if (error) {
    console.warn("[delivery-poller] query error:", error.message);
    return counters;
  }
  const rows = (pending || []) as unknown as PendingMsgRow[];
  if (rows.length === 0) return counters;

  // Agrupa por hub_location_id pra reusar GHLClient
  const byHub = new Map<string, PendingMsgRow[]>();
  for (const r of rows) {
    const arr = byHub.get(r.hub_location_id) || [];
    arr.push(r);
    byHub.set(r.hub_location_id, arr);
  }

  for (const [hubLocationId, msgs] of byHub) {
    const { data: hub } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", hubLocationId)
      .maybeSingle();
    if (!hub?.company_id) {
      console.warn(`[delivery-poller] hub ${hubLocationId} sem company_id — skip`);
      counters.errors += msgs.length;
      continue;
    }
    const ghl = new GHLClient(hub.company_id, hubLocationId);

    for (const msg of msgs) {
      counters.checked++;
      try {
        type MsgDetail = { message?: { id: string; status?: string; error?: string; conversationProviderId?: string } };
        const detail = await ghl.get<MsgDetail>(
          `/conversations/messages/${encodeURIComponent(msg.ghl_message_id)}`,
        );
        const status = (detail.message?.status || "").toLowerCase();
        const errMsg = detail.message?.error || null;

        if (TERMINAL_STATUSES.has(status)) {
          counters.delivered++;
          await supabase
            .from("sparkbot_messages")
            .update({
              metadata: {
                ...msg.metadata,
                delivery_status: status,
                delivery_status_checked_at: new Date().toISOString(),
                delivery_error: null,
              },
            })
            .eq("id", msg.id);
        } else if (FAILED_STATUSES.has(status)) {
          counters.failed++;
          // Atualiza metadata + muda canal pra 'system' (rep verá badge).
          await supabase
            .from("sparkbot_messages")
            .update({
              channel: "system",
              read_in_web_at: null, // re-ativa badge
              metadata: {
                ...msg.metadata,
                delivery_status: status,
                delivery_status_checked_at: new Date().toISOString(),
                delivery_error: errMsg,
                whatsapp_sent: false, // corrige flag mentirosa
                fallback_to_web_at: new Date().toISOString(),
              },
            })
            .eq("id", msg.id);

          // Auto-signal admin (dedup natural via fingerprint hash)
          try {
            const { recordSignalAsync } = await import(
              "@/lib/admin-signals/recorder"
            );
            recordSignalAsync({
              type: "failure",
              title: `Stevo delivery failed: ${errMsg || "unknown"}`,
              description:
                `Mensagem proativa ${msg.ghl_message_id} (rep ${msg.rep_id}) ` +
                `virou ${status} após send. error="${errMsg}". ` +
                `Verificar instância Stevo do HUB ${hubLocationId}.`,
              severity: "high",
              source: "bot_auto",
              metadata: {
                rep_id: msg.rep_id,
                hub_location_id: hubLocationId,
                ghl_message_id: msg.ghl_message_id,
                stevo_error: errMsg,
                stevo_provider_id: detail.message?.conversationProviderId || null,
                source: msg.metadata?.source || null,
              },
            });
          } catch {
            // Signal não-crítico
          }
        } else {
          counters.still_pending++;
          // Stale check: se passou de STALE_TIMEOUT_MIN sem virar terminal,
          // marca delivery_status='stale' (ainda em fila Stevo, mas suspeito).
          const ageMin = (Date.now() - new Date(msg.created_at).getTime()) / 60_000;
          if (ageMin > STALE_TIMEOUT_MIN) {
            await supabase
              .from("sparkbot_messages")
              .update({
                metadata: {
                  ...msg.metadata,
                  delivery_status: "stale",
                  delivery_status_checked_at: new Date().toISOString(),
                  last_polled_status: status || "(empty)",
                  age_when_marked_stale_min: Math.round(ageMin),
                },
              })
              .eq("id", msg.id);
          }
        }
      } catch (err) {
        counters.errors++;
        console.warn(
          `[delivery-poller] check ${msg.ghl_message_id} falhou:`,
          err instanceof Error ? err.message.slice(0, 100) : err,
        );
      }
    }
  }

  // Circuit breaker: se ≥5 failed nos últimos 10min, registra signal global
  // "STEVO DOWN" — admin recebe alert big-time.
  if (counters.failed >= 5) {
    try {
      const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
      recordSignalAsync({
        type: "failure",
        title: `🚨 STEVO DOWN: ${counters.failed} mensagens falharam neste ciclo`,
        description:
          `${counters.failed} de ${counters.checked} mensagens proativas marcadas ` +
          `como failed. Provavelmente instância Stevo precisa re-conectar (re-scan QR).\n` +
          `Verifique dashboard Stevo / N8N App + número WhatsApp do HUB.`,
        severity: "high",
        source: "bot_auto",
        metadata: {
          poll_cycle_failed_count: counters.failed,
          poll_cycle_total: counters.checked,
        },
      });
    } catch {
      /* no-op */
    }
  }

  console.log(
    `[delivery-poller] ciclo: checked=${counters.checked} ` +
      `delivered=${counters.delivered} failed=${counters.failed} ` +
      `still_pending=${counters.still_pending} errors=${counters.errors}`,
  );
  return counters;
}
