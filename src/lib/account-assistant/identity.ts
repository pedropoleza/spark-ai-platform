import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import type { RepIdentity, GHLUserLink, RepProfile } from "@/types/account-assistant";

/**
 * Normaliza phone para formato E.164 (+<countrycode><number>).
 * GHL envia phones em vários formatos; padronizamos pra ter unique constraint
 * funcionando e lookups determinísticos.
 */
export function normalizePhone(raw: string): string {
  if (!raw) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  // Se já começa com código de país (10+ dígitos), adiciona +
  if (digits.length >= 11 && !raw.startsWith("+")) return `+${digits}`;
  // Se tem 10 dígitos (US sem código), presume +1
  if (digits.length === 10) return `+1${digits}`;
  // Fallback: devolve como veio se não conseguir inferir
  return raw.startsWith("+") ? raw : `+${digits}`;
}

/**
 * Busca o rep por phone. Se não existir, varre todas as locations conhecidas
 * procurando GHL users com esse phone e cria o registro. Retorna null se
 * nenhum match — nesse caso o assistente responde "não autorizado".
 */
export async function identifyRep(phone: string): Promise<RepIdentity | null> {
  const normalizedPhone = normalizePhone(phone);
  const supabase = createAdminClient();

  // 1. Lookup local
  const { data: existing } = await supabase
    .from("rep_identities")
    .select("*")
    .eq("phone", normalizedPhone)
    .maybeSingle();

  if (existing) return existing as RepIdentity;

  // 2. Primeira interação — procura o phone em todas as locations cadastradas
  const { data: locations } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name");

  if (!locations || locations.length === 0) return null;

  const matches: GHLUserLink[] = [];
  let displayName: string | null = null;

  for (const loc of locations) {
    try {
      const client = new GHLClient(loc.company_id, loc.location_id);
      // GHL API: GET /users/search (V2) ou /users/ com filtro de phone
      const res = await client.get<{
        users?: Array<{
          id: string;
          firstName?: string;
          lastName?: string;
          phone?: string;
          roles?: { role?: string };
        }>;
      }>("/users/", { locationId: loc.location_id });

      const users = res.users || [];
      for (const u of users) {
        const userPhone = normalizePhone(u.phone || "");
        if (userPhone === normalizedPhone) {
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
          matches.push({
            location_id: loc.location_id,
            ghl_user_id: u.id,
            location_name: loc.location_name || null,
            role: u.roles?.role || null,
          });
          if (!displayName && name) displayName = name;
        }
      }
    } catch (err) {
      console.warn(`[identity] failed to search users in location ${loc.location_id}:`, err instanceof Error ? err.message : err);
      // Continua pras outras locations — falha parcial não deve bloquear
    }
  }

  if (matches.length === 0) return null;

  // 3. Cria rep_identity
  const { data: created, error } = await supabase
    .from("rep_identities")
    .insert({
      phone: normalizedPhone,
      display_name: displayName,
      ghl_users: matches,
      // Se só 1 location, já seta como ativa pra não perguntar
      active_location_id: matches.length === 1 ? matches[0].location_id : null,
    })
    .select()
    .single();

  if (error) {
    console.error("[identity] failed to insert rep_identity:", error.message);
    return null;
  }

  return created as RepIdentity;
}

/**
 * Atualiza o profile (memória adaptativa) do rep. Merge raso — caller deve
 * passar apenas as chaves que quer atualizar. Usa update pra não sobrescrever.
 */
export async function updateRepProfile(repId: string, profilePatch: Partial<RepProfile>): Promise<void> {
  const supabase = createAdminClient();
  const { data: current } = await supabase
    .from("rep_identities")
    .select("profile")
    .eq("id", repId)
    .maybeSingle();

  const merged = { ...(current?.profile || {}), ...profilePatch };
  await supabase
    .from("rep_identities")
    .update({ profile: merged, updated_at: new Date().toISOString() })
    .eq("id", repId);
}

/** Marca terms como aceitos. */
export async function acceptTerms(repId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ terms_accepted_at: new Date().toISOString() })
    .eq("id", repId);
}

/** Seta active_location_id (quando rep escolhe qual operar). */
export async function setActiveLocation(repId: string, locationId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ active_location_id: locationId, updated_at: new Date().toISOString() })
    .eq("id", repId);
}
