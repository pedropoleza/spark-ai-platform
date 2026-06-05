/**
 * Captura raw do webhook inbound (diagnóstico — Pedro 2026-05-24).
 *
 * Grava cada payload que chega no /api/webhooks/inbound-message ANTES de
 * qualquer skip, pra responder "o GHL está encaminhando a DM (IG etc) pra gente,
 * e com qual payload?". Capped: mantém só os últimos 100 (prune no insert).
 *
 * Fire-and-forget, non-fatal, gated por env INBOUND_WEBHOOK_CAPTURE (default ON;
 * setar "off" desliga). Tabela: inbound_webhook_samples (migration 00078).
 * Debug-only — dropar a tabela quando não precisar mais.
 */

import { createAdminClient } from "@/lib/supabase/admin";

const KEEP_LAST = 100;

export function isInboundCaptureEnabled(): boolean {
  return (process.env.INBOUND_WEBHOOK_CAPTURE || "").toLowerCase() !== "off";
}

export interface InboundSample {
  locationId?: string | null;
  contactId?: string | null;
  messageType?: string | null;
  detectedChannel?: string | null;
  messageDirection?: string | null;
  isRealMessage?: boolean | null;
  raw: unknown;
}

/**
 * Grava um sample (fire-and-forget). Nunca lança — é só diagnóstico.
 * Chame com `void captureInboundWebhookSample(...)`.
 */
export async function captureInboundWebhookSample(sample: InboundSample): Promise<void> {
  if (!isInboundCaptureEnabled()) return;
  try {
    const supabase = createAdminClient();
    await supabase.from("inbound_webhook_samples").insert({
      location_id: sample.locationId ?? null,
      contact_id: sample.contactId ?? null,
      message_type: sample.messageType ?? null,
      detected_channel: sample.detectedChannel ?? null,
      message_direction: sample.messageDirection ?? null,
      is_real_message: sample.isRealMessage ?? null,
      raw: sample.raw ?? null,
    });
    // Prune best-effort: mantém só os últimos KEEP_LAST POR LOCATION. Antes era
    // GLOBAL (sem filtro de location) — uma location de alto tráfego evictava os
    // samples de outra (acoplamento cross-tenant). Fix review 2026-06-05.
    const loc = sample.locationId ?? null;
    const cutoffSel = supabase.from("inbound_webhook_samples").select("received_at");
    const { data: cutoffRow } = await (loc ? cutoffSel.eq("location_id", loc) : cutoffSel)
      .order("received_at", { ascending: false })
      .range(KEEP_LAST, KEEP_LAST)
      .maybeSingle();
    if (cutoffRow?.received_at) {
      const del = supabase
        .from("inbound_webhook_samples")
        .delete()
        .lt("received_at", cutoffRow.received_at as string);
      await (loc ? del.eq("location_id", loc) : del);
    }
  } catch (err) {
    console.warn(
      "[inbound-capture] falhou (non-fatal):",
      err instanceof Error ? err.message.slice(0, 120) : err,
    );
  }
}
