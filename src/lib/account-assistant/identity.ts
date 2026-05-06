import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import type { RepIdentity, GHLUserLink, RepProfile } from "@/types/account-assistant";

/**
 * Normaliza phone para formato E.164 (+<countrycode><number>).
 * GHL envia phones em vários formatos; padronizamos pra ter unique constraint
 * funcionando e lookups determinísticos.
 *
 * IMPORTANTE: o default country é via `defaultCountry` arg (vem da timezone
 * da location ativa). Antes assumia US sempre (`+1` em 10/11 dígitos), o que
 * quebrou TODOS os imports brasileiros: `11987654321` virava `+11987654321`
 * (US wrong) em vez de `+5511987654321`.
 *
 * Heurística:
 * - Se já começa com `+` → preserva (assumindo E.164 já válido)
 * - Se tem 12+ dígitos sem `+` → assume que tem country code, prepend `+`
 * - Se tem 10/11 dígitos:
 *   - defaultCountry='BR' → prepend `+55`
 *   - defaultCountry='US' (default) → prepend `+1`
 * - Fallback: prepend `+` direto
 *
 * Para detectar country da location: ver inferCountryFromTimezone()
 */
export function normalizePhone(raw: string, defaultCountry: "US" | "BR" = "US"): string {
  if (!raw) return raw;
  const digits = raw.replace(/\D/g, "");
  if (!digits) return raw;
  // Já tem `+` na entrada — preserva (assume E.164 válido)
  if (raw.trim().startsWith("+")) return `+${digits}`;
  // 12+ dígitos sem `+` — provavelmente já tem country code
  if (digits.length >= 12) return `+${digits}`;
  // 10/11 dígitos — depende do default country
  if (digits.length === 10 || digits.length === 11) {
    if (defaultCountry === "BR") return `+55${digits}`;
    return `+1${digits}`;
  }
  // Fallback (curto demais, dificilmente válido)
  return `+${digits}`;
}

/**
 * Gera variantes plausíveis de phone E.164 pra um input não-normalizado.
 * Usado em identifyRep onde não sabemos o country do rep upfront.
 *
 * Estratégia:
 * - Se já tem `+`: retorna como E.164 (single candidate)
 * - Se 12+ dígitos: assume country code presente, prepend `+`
 * - Se 10-11 dígitos: gera 2 candidatos — `+55<digits>` e `+1<digits>`
 * - Senão: fallback `+<digits>`
 */
export function generatePhoneCandidates(raw: string): string[] {
  if (!raw) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("+")) {
    const digits = trimmed.replace(/\D/g, "");
    return [`+${digits}`];
  }
  const digits = trimmed.replace(/\D/g, "");
  if (!digits) return [];
  if (digits.length >= 12) return [`+${digits}`];
  if (digits.length === 10 || digits.length === 11) {
    // Order: BR primeiro porque mercado-alvo. Mas tenta ambos no lookup.
    return [`+55${digits}`, `+1${digits}`];
  }
  return [`+${digits}`];
}

/**
 * Infere country code (BR/US) da timezone IANA da location.
 * Brazilian timezones começam com America/Sao_Paulo, America/Fortaleza, etc.
 * Pra outros casos volta US (default seguro pra mercado dominante).
 */
export function inferCountryFromTimezone(tz: string | null | undefined): "US" | "BR" {
  if (!tz) return "US";
  const lower = tz.toLowerCase();
  // Timezones brasileiros conhecidos (IANA)
  const brTimezones = [
    "america/sao_paulo", "america/fortaleza", "america/recife",
    "america/maceio", "america/bahia", "america/araguaina",
    "america/belem", "america/campo_grande", "america/cuiaba",
    "america/manaus", "america/porto_velho", "america/boa_vista",
    "america/rio_branco", "america/eirunepe", "america/santarem",
    "america/noronha", "brazil/east", "brazil/west", "brazil/acre",
  ];
  if (brTimezones.some((b) => lower === b || lower.includes("brazil") || lower.includes("sao_paulo"))) return "BR";
  return "US";
}

/**
 * Busca o rep por phone. Se não existir, varre todas as locations conhecidas
 * procurando GHL users com esse phone e cria o registro. Retorna null se
 * nenhum match — nesse caso o assistente responde "não autorizado".
 */
export async function identifyRep(phone: string): Promise<RepIdentity | null> {
  // Fix CRITICAL stress test 2026-05-03: webhook chega ANTES de saber o
  // país. Tenta variações pra cobrir BR + US sem assumir um default.
  // Phone candidato é a query — gera variantes:
  //   - Já com `+`: usa direto.
  //   - 10/11 digits sem `+`: tenta `+1<digits>` E `+55<digits>` em paralelo.
  //   - Tudo com `+`: assume E.164.
  const candidates = generatePhoneCandidates(phone);
  const supabase = createAdminClient();

  // 1. Lookup local — tenta cada candidato
  // Fix Track 10 H11 (review 2026-05-05): preserva PRIMEIRO candidato como
  // default em vez de "último testado". generatePhoneCandidates retorna
  // [+55..., +1...] pra phones BR (priorizando BR já que mercado é BR-EUA).
  // Antes, se nenhum candidato existisse no DB, normalizedPhone virava o
  // ÚLTIMO testado (+1...) → rep BR criado com phone US errado.
  const normalizedPhone = candidates[0];
  for (const candidate of candidates) {
    const { data: existing } = await supabase
      .from("rep_identities")
      .select("*")
      .eq("phone", candidate)
      .maybeSingle();
    if (existing) return existing as RepIdentity;
  }

  // 2. Primeira interação — procura o phone em todas as locations cadastradas
  const { data: locations } = await supabase
    .from("locations")
    .select("location_id, company_id, location_name");

  if (!locations || locations.length === 0) return null;

  const matches: GHLUserLink[] = [];
  let displayName: string | null = null;
  // Fix bug observado em prod 2026-05-03: rep BR levou lembrete em horário NY
  // porque processor pegava location.timezone, mas a hora correta é a do REP.
  // Capturamos o timezone do GHL user object (campo IANA) no identify e
  // armazenamos top-level pra resolver fácil em runtime.
  let repTimezone: string | null = null;

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
          timezone?: string;
          roles?: { role?: string };
        }>;
      }>("/users/", { locationId: loc.location_id });

      const users = res.users || [];
      for (const u of users) {
        const userPhone = normalizePhone(u.phone || "");
        if (userPhone === normalizedPhone) {
          const name = [u.firstName, u.lastName].filter(Boolean).join(" ");
          const tz = (u.timezone || "").trim() || null;
          matches.push({
            location_id: loc.location_id,
            ghl_user_id: u.id,
            location_name: loc.location_name || null,
            role: u.roles?.role || null,
            timezone: tz,
          });
          if (!displayName && name) displayName = name;
          // Top-level timezone = primeiro non-null encontrado. Em prática,
          // GHL user tem 1 timezone único — múltiplas locations devolvem o
          // mesmo valor. Se vier discrepância, prevalece o primeiro match.
          if (!repTimezone && tz) repTimezone = tz;
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
      timezone: repTimezone,
      // Se só 1 location, já seta como ativa pra não perguntar
      active_location_id: matches.length === 1 ? matches[0].location_id : null,
    })
    .select()
    .single();

  if (error) {
    // Fix CRITICAL Track 1 C3 (review 2026-05-05): race condition entre
    // 2 webhooks Stevo+GHL em <100ms. Ambos passam dedup ID-based,
    // ambos chegam ao INSERT, UNIQUE phone constraint salva o segundo
    // com 23505 — antes, esse error subia como `null` → rep recebia
    // "não cadastrado" simultaneamente com termos. Agora, se 23505,
    // re-fetch e devolve a row criada pelo competidor.
    if ((error as { code?: string }).code === "23505") {
      const { data: existing } = await supabase
        .from("rep_identities")
        .select("*")
        .eq("phone", normalizedPhone)
        .maybeSingle();
      if (existing) return existing as RepIdentity;
    }
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

/**
 * Marca terms como REJEITADOS. Fix CRITICAL Track 1 C1 (review 2026-05-05):
 * antes, rep que recusava ficava em loop infinito porque rejeição não era
 * persistida. Agora bot silencia até admin limpar a flag manualmente
 * (UPDATE rep_identities SET terms_rejected_at = NULL WHERE id = X).
 */
export async function rejectTerms(repId: string): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ terms_rejected_at: new Date().toISOString() })
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

/**
 * Detecta se o rep é "internal" (agency owner / admin) — não deve ser cobrado
 * pelo uso do SparkBot. Heurística em camadas (curto-circuita na primeira
 * que bater):
 *
 *   1. **Env var `INTERNAL_TEAM_PHONES`** — lista CSV de phones em E.164.
 *      Mais robusto. Pedro adiciona phones do team via Vercel env. Ex:
 *      `INTERNAL_TEAM_PHONES="+17867717077,+15555555555"`.
 *
 *   2. **GHL user.type == 'agency'** — se algum dos `ghl_users[]` tiver
 *      `userType` ou `roles.type` === 'agency', considera internal. (Esse
 *      campo é populado em identifyRep quando o GHL retorna.)
 *
 *   3. **Heurística "muitas locations"** — rep com acesso a 5+ sub-accounts
 *      é provável agency-level (pra Brazillionaires que tem 61 locations,
 *      isso bate só pro Pedro/admins).
 *
 * Se nenhuma bate, assume não-internal (cobra normal).
 */
export function detectIsInternal(rep: RepIdentity): boolean {
  // Camada 1: env list
  const envList = (process.env.INTERNAL_TEAM_PHONES || "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (envList.length > 0 && rep.phone && envList.includes(rep.phone)) {
    return true;
  }

  // Camada 2: role type no ghl_users (capturado durante identify se GHL retornar)
  const hasAgencyRole = rep.ghl_users.some((u) => {
    const role = (u.role || "").toLowerCase();
    return role === "agency" || role === "agency_owner" || role === "agency_admin";
  });
  if (hasAgencyRole) return true;

  // Camada 3: heurística — muitas locations
  if (rep.ghl_users.length >= 5) return true;

  return false;
}

/**
 * Sincroniza `is_internal` no rep_identities baseado na detecção atual.
 * Idempotente — só faz UPDATE se valor mudou.
 */
export async function syncRepInternalFlag(rep: RepIdentity): Promise<boolean> {
  const detected = detectIsInternal(rep);
  if (rep.is_internal === detected) return detected; // sem mudança

  const supabase = createAdminClient();
  await supabase
    .from("rep_identities")
    .update({ is_internal: detected, updated_at: new Date().toISOString() })
    .eq("id", rep.id);
  return detected;
}

/**
 * Identifica rep pelo ghl_user_id (usado pelo Web UI no GHL onde não temos
 * phone direto, só user_id). Se não existir, busca o user no GHL pra obter
 * phone e cria o registro. Igual identifyRep mas começando do user_id.
 *
 * Retorna null se user não tem permissão de admin OU não foi encontrado.
 */
export async function identifyRepByGhlUser(args: {
  ghlUserId: string;
  locationId: string;
  companyId: string;
}): Promise<RepIdentity | null> {
  const { ghlUserId, locationId, companyId } = args;
  const supabase = createAdminClient();

  // 1. Busca rep que já tem esse ghl_user_id na location
  // Usa filtro JSONB containment: ghl_users contém { ghl_user_id, location_id }
  const { data: existing } = await supabase
    .from("rep_identities")
    .select("*")
    .filter("ghl_users", "cs", JSON.stringify([{ ghl_user_id: ghlUserId, location_id: locationId }]))
    .maybeSingle();

  if (existing) return existing as RepIdentity;

  // 2. Primeira vez que esse user usa o web — busca dados via GHL API
  let userPhone: string | null = null;
  let userName: string | null = null;
  let userRole: string | null = null;
  let userTimezone: string | null = null;
  try {
    const client = new GHLClient(companyId, locationId);
    const res = await client.get<{
      users?: Array<{
        id: string;
        firstName?: string;
        lastName?: string;
        phone?: string;
        timezone?: string;
        roles?: { role?: string };
      }>;
    }>("/users/", { locationId });

    const u = (res.users || []).find((x) => x.id === ghlUserId);
    if (u) {
      userPhone = u.phone ? normalizePhone(u.phone) : null;
      userName = [u.firstName, u.lastName].filter(Boolean).join(" ") || null;
      userRole = u.roles?.role || null;
      userTimezone = (u.timezone || "").trim() || null;
    }
  } catch (err) {
    console.warn(
      `[identity:web] failed to fetch user ${ghlUserId} in ${locationId}:`,
      err instanceof Error ? err.message : err,
    );
  }

  // 3. Antes de criar novo rep, tenta deduplicar via 2 lookups em camadas:
  //
  //   3a. Por `ghl_user_id` em QUALQUER location de qualquer rep — cobre
  //       o caso de Pedro que tem várias sub-accounts e abre uma nova:
  //       o ghl_user_id que ele usa nesse location pode JÁ existir em outro
  //       rep_identity (ex: mesmo user_id em Spark Leads + Ideal English).
  //
  //   3b. Por phone (real ou placeholder `webonly:<ghlUserId>`) — cobre
  //       o caso de WhatsApp-first rep que depois abre Web UI, ou re-abre
  //       Web UI quando GHL não devolveu phone na primeira vez.
  //
  // Fix CRITICAL bug observado em prod 2026-05-04: sem o lookup 3a, GHL
  // que não retorna phone fazia code cair em step 4 (insert com
  // `webonly:<ghlUserId>` placeholder), violando unique constraint quando
  // já existia rep_identity com esse exato placeholder.
  const repExistingViaUserId = await supabase
    .from("rep_identities")
    .select("*")
    .filter("ghl_users", "cs", JSON.stringify([{ ghl_user_id: ghlUserId }]))
    .limit(1)
    .maybeSingle();

  const lookupPhone = userPhone || `webonly:${ghlUserId}`;
  const repExistingViaPhone = repExistingViaUserId.data
    ? null
    : (await supabase
        .from("rep_identities")
        .select("*")
        .eq("phone", lookupPhone)
        .maybeSingle()).data;

  const byPhone = repExistingViaUserId.data || repExistingViaPhone;
  {
    if (byPhone) {
      const repExisting = byPhone as RepIdentity;
      const links = (repExisting.ghl_users || []) as GHLUserLink[];
      const alreadyHas = links.some(
        (l) => l.ghl_user_id === ghlUserId && l.location_id === locationId,
      );

      // Fix CRITICAL bug observado em prod 2026-05-06 (Pedro auditando
      // Magnet Money): antes, se um rep tinha o ghl_user_id em LocationA
      // (real), e alguém abria web UI / chamava check-admin com mesmo
      // ghl_user_id em LocationB onde ele NÃO é user, code adicionava
      // link "garbage" {role=null, location_name=null} no ghl_users[]
      // só pelo match do ghl_user_id. Resultado: 31 garbage links em 7
      // reps detectados.
      // Impacto: cron iterava locations garbage, query GHL events com
      // ghl_user_id em location onde user não existe → desperdício +
      // logs poluídos. Plus: confunde lógica de active_location.
      // Fix: SÓ adiciona link se step 2 (lookup /users/?locationId=X)
      // CONFIRMOU que o user existe lá (userPhone OU userName OU userRole
      // não-null indicam que API retornou o user real).
      const userConfirmedInLocation =
        userPhone !== null || userName !== null || userRole !== null;

      if (!alreadyHas && !userConfirmedInLocation) {
        console.warn(
          `[identity:web] ghl_user_id ${ghlUserId} NÃO é user em ${locationId} ` +
            `(GHL /users/ não retornou). Skip add link garbage. rep=${repExisting.id}`,
        );
        return repExisting;
      }

      if (!alreadyHas) {
        const updatedLinks = [
          ...links,
          {
            ghl_user_id: ghlUserId,
            location_id: locationId,
            location_name: null,
            role: userRole,
            timezone: userTimezone,
          },
        ];
        // Se rep ainda não tinha timezone top-level, popula agora
        const updates: Record<string, unknown> = {
          ghl_users: updatedLinks,
          updated_at: new Date().toISOString(),
        };
        if (!repExisting.timezone && userTimezone) {
          updates.timezone = userTimezone;
        }
        await supabase
          .from("rep_identities")
          .update(updates)
          .eq("id", repExisting.id);
        return {
          ...repExisting,
          ghl_users: updatedLinks,
          timezone: repExisting.timezone || userTimezone,
        };
      }
      return repExisting;
    }
  }

  // 4. Cria rep novo. Phone pode ser null (rep só usa via web por ora).
  // O UNIQUE em phone exige valor, então usamos placeholder único quando
  // phone real não tá disponível.
  const phoneOrPlaceholder = userPhone || `webonly:${ghlUserId}`;
  const { data: created, error } = await supabase
    .from("rep_identities")
    .insert({
      phone: phoneOrPlaceholder,
      display_name: userName,
      ghl_users: [
        {
          ghl_user_id: ghlUserId,
          location_id: locationId,
          location_name: null,
          role: userRole,
          timezone: userTimezone,
        },
      ],
      timezone: userTimezone,
      active_location_id: locationId,
    })
    .select()
    .single();

  if (error) {
    console.error("[identity:web] failed to insert rep_identity:", error.message);
    return null;
  }

  return created as RepIdentity;
}
