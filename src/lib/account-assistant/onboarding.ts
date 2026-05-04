/**
 * Helpers de onboarding do SparkBot — compartilhados entre os 2 entrypoints:
 *
 *   1. **WhatsApp** (`processor.ts:processIncoming`): rep aceita termos via
 *      msg textual; bot devolve `buildOnboardingMessage` como string que vai
 *      pelo `sendResponseToRep`.
 *
 *   2. **Web UI** (`/api/sparkbot/check-admin`): rep abre painel; check-admin
 *      auto-aceita os termos (UX no GHL é redundante mostrar). Aqui usamos
 *      `seedWebOnboardingMessage` pra INSERTAR a mesma mensagem direto no
 *      `sparkbot_messages` — painel pega via polling do inbox.
 *
 * Ambos compartilham:
 *   - Auto-confirmação de fuso lendo `location.timezone`
 *   - Mesmo guia rápido em `buildOnboardingMessage`
 *
 * Pedro 2026-05-04: refator a partir de bug onde Web UI não mostrava
 * onboarding (auto-accept silencioso pulava o painel inteiro).
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { buildOnboardingMessage, formatTimezoneHumanFriendly, TERMS_ACCEPTED_TEXT } from "./terms";
import type { RepIdentity } from "@/types/account-assistant";

/**
 * Resolve o fuso da location ativa, persiste como `timezone_confirmed_at`,
 * e devolve a mensagem composta de onboarding pra usar no WhatsApp.
 */
export async function buildOnboardingForWhatsApp(rep: RepIdentity): Promise<string> {
  const tz = await confirmTimezoneFromLocation(rep);
  return buildOnboardingMessage(formatTimezoneHumanFriendly(tz));
}

/**
 * Mesma lógica do path WhatsApp, mas insere a mensagem em `sparkbot_messages`
 * pra aparecer no painel Web UI via polling. Usa `channel='web_ui'` e
 * marca como já lida (`read_in_web_at=now`) — não precisa do badge unread
 * na primeira vez.
 *
 * Retorna o id da mensagem inserida (pra debug) ou null em falha.
 */
export async function seedWebOnboardingMessage(args: {
  rep: RepIdentity;
  hubLocationId: string;
  hubAgentId: string;
}): Promise<string | null> {
  try {
    const tz = await confirmTimezoneFromLocation(args.rep);
    const text = buildOnboardingMessage(formatTimezoneHumanFriendly(tz));

    const supabase = createAdminClient();
    const { data, error } = await supabase
      .from("sparkbot_messages")
      .insert({
        rep_id: args.rep.id,
        hub_location_id: args.hubLocationId,
        agent_id: args.hubAgentId,
        active_location_id: args.rep.active_location_id || args.rep.ghl_users[0]?.location_id || null,
        role: "agent",
        content: text,
        channel: "web_ui",
        // Já lida — primeira interação que rep ainda nem viu, mas não queremos
        // badge unread (UX pesada na primeira vez)
        read_in_web_at: new Date().toISOString(),
        metadata: { source: "web_onboarding" },
      })
      .select("id")
      .single();

    if (error) {
      console.warn("[onboarding] seedWebOnboardingMessage failed:", error.message);
      return null;
    }
    return data?.id || null;
  } catch (err) {
    console.warn(
      "[onboarding] seedWebOnboardingMessage crashed:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Helper interno: lê `location.timezone` do GHL (table locations sincronizada),
 * persiste em `rep_identities` e retorna o IANA salvo. Falha graciosa.
 */
async function confirmTimezoneFromLocation(rep: RepIdentity): Promise<string | null> {
  const supabase = createAdminClient();
  const locationId = rep.active_location_id || rep.ghl_users[0]?.location_id;
  if (!locationId) return null;

  const { data: location } = await supabase
    .from("locations")
    .select("timezone")
    .eq("location_id", locationId)
    .maybeSingle();

  const tz = (location?.timezone || "").trim() || null;
  if (!tz) return null;

  // Idempotente — só atualiza se ainda não foi confirmado, pra não sobrescrever
  // override manual via tool `confirm_rep_timezone`.
  if (!rep.timezone_confirmed_at) {
    await supabase
      .from("rep_identities")
      .update({
        timezone: tz,
        timezone_confirmed_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq("id", rep.id);
  }
  return tz;
}

/** Re-export TERMS_ACCEPTED_TEXT pra callers que querem fallback simples. */
export { TERMS_ACCEPTED_TEXT };
