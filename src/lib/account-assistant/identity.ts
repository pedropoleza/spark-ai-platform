import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { reportError } from "@/lib/admin-signals/report-error";
import {
  setTermsAccepted,
  setTermsRejected,
  setGroupCampaignTermsAccepted,
  setGroupCampaignTermsRejected,
  setGroupCampaignTermsPending,
  clearGroupCampaignTermsPending,
  setActiveLocation as repoSetActiveLocation,
  mergeRepProfile,
  updateRepById,
} from "@/lib/repositories";
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
 * Resolve o default country ("US"|"BR") pra normalizePhone a partir do
 * timezone IANA da location. Faz lookup na tabela `locations` via admin
 * client e cai pra "US" (mercado dominante) em qualquer falha — fail-soft,
 * nunca bloqueia a operação.
 *
 * Fonte única: usado tanto pelo import tabular quanto pelas tools de contato
 * (create_contact/update_contact). Sem normalização BR-aware, número BR de
 * 10/11 dígitos sem `+` default-a pra +1 no GHL → contato com phone errado,
 * falha de dedup e outbound (SMS/WhatsApp) que não entrega silenciosamente.
 */
export async function resolveLocationDefaultCountry(locationId: string): Promise<"US" | "BR"> {
  try {
    const sb = createAdminClient();
    const { data: locRow } = await sb
      .from("locations")
      .select("timezone")
      .eq("location_id", locationId)
      .maybeSingle();
    return inferCountryFromTimezone(locRow?.timezone);
  } catch (err) {
    console.warn(
      "[identity] resolveLocationDefaultCountry lookup falhou — usando US default:",
      err instanceof Error ? err.message : err,
    );
    return "US";
  }
}

/**
 * Busca o rep por phone. Se não existir, varre todas as locations conhecidas
 * procurando GHL users com esse phone e cria o registro.
 *
 * Retorno:
 *   - `RepIdentity` — achou/criou o rep.
 *   - `null` — rep genuinamente não é user em nenhuma location (varredura OK,
 *      phone não bateu). Caller responde "não cadastrado".
 *   - `"scan_failed"` — a varredura QUEBROU em 100% das locations (provável
 *      apagão de token GHL). Caller NÃO deve dizer "não cadastrado" (seria
 *      mentira que esconde um apagão) — responde "problema técnico, tenta de
 *      novo". reportError crítico já foi disparado aqui dentro.
 */
export async function identifyRep(phone: string): Promise<RepIdentity | null | "scan_failed"> {
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

  // 2. Primeira interação — procura o phone nas locations cadastradas.
  type LocationRow = {
    location_id: string;
    company_id: string;
    location_name: string | null;
    deauthorized_at?: string | null;
  };
  // Skip-inactive (2026-06-27): seleciona deauthorized_at; se a coluna ainda não
  // existe (migration 00118 não aplicada), degrada pro select de hoje (varre todas).
  let locations: LocationRow[] | null;
  {
    const r = await supabase
      .from("locations")
      .select("location_id, company_id, location_name, deauthorized_at");
    if (r.error) {
      const r2 = await supabase
        .from("locations")
        .select("location_id, company_id, location_name");
      locations = (r2.data as LocationRow[] | null) ?? null;
    } else {
      locations = (r.data as LocationRow[] | null) ?? null;
    }
  }

  if (!locations || locations.length === 0) return null;

  const matches: GHLUserLink[] = [];
  let displayName: string | null = null;
  // Fix bug observado em prod 2026-05-03: rep BR levou lembrete em horário NY
  // porque processor pegava location.timezone, mas a hora correta é a do REP.
  // Capturamos o timezone do GHL user object (campo IANA) no identify e
  // armazenamos top-level pra resolver fácil em runtime.
  let repTimezone: string | null = null;

  // Fix bug observado em prod 2026-06-16 (caso Manuela Garcia 954-477-1397 / Ana
  // Paula Lemika 954-451-8104): a varredura de PRIMEIRA VIAGEM era SEQUENCIAL
  // sobre TODAS as locations. Com 120 sub-accounts (~855ms/loc incluindo mint de
  // location-token + retries de location inativa) dava ~103s — estourando o
  // maxDuration=60s do webhook (waitUntil) → o lambda morria NO MEIO da varredura
  // → rep novo NUNCA era criado e o corretor não recebia NADA (nem o "não
  // cadastrado", pois o código morria antes). Reps já existentes não passam por
  // aqui (lookup local no passo 1). Agora roda em LOTES PARALELOS — cabe em poucos
  // segundos. Ordem preservada (displayName/repTimezone = 1º match em ordem de
  // location, idêntico ao sequencial anterior).
  // Skip-inactive (2026-06-27, follow-up [[sparkbot-new-rep-scaling]]): ~metade das
  // ~130 locations vivem inativas/desautorizadas e SEMPRE erram o mint de token,
  // gastando slot da varredura à toa. Marcamos `locations.deauthorized_at` quando o
  // erro é de location-fora (texto PERSISTENTE, ver classifyScanError) e PULAMOS
  // essas por 7d (re-check pega reativação). NUNCA marcamos 401/403 genérico: num
  // apagão de company-token TODAS dariam 401 e marcaríamos o mundo como inativo
  // (= onboarding mudo). Pular uma location de fato inativa não perde rep — o mint
  // falharia e não dá pra ler os users dela de qualquer jeito.
  const DEAUTH_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
  const nowMs = Date.now();
  const classifyScanError = (err: unknown): "deauth" | "technical" => {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    if (
      msg.includes("is not active") ||
      msg.includes("does not have access") ||
      msg.includes("location not found") ||
      msg.includes("invalid locationid")
    ) {
      return "deauth";
    }
    return "technical";
  };

  // Elegíveis = nunca marcadas OU marcadas há mais de 7d (re-check). O resto pula.
  const toScan = locations.filter((l) => {
    if (!l.deauthorized_at) return true;
    const t = Date.parse(l.deauthorized_at);
    return Number.isNaN(t) || nowMs - t >= DEAUTH_RECHECK_MS;
  });
  const skippedInactive = locations.length - toScan.length;
  if (skippedInactive > 0) {
    console.log(`[identity] scan ${toScan.length}/${locations.length} locations (puladas ${skippedInactive} inativas <7d)`);
  }

  // techErrors = falha técnica (timeout/5xx/429/401 de apagão) — sinaliza apagão.
  // deauthThisPass = locations que erraram por estar fora → marcar. reactivated =
  // antes-marcadas que voltaram a varrer OK → limpar a marca.
  let techErrors = 0;
  const deauthThisPass: string[] = [];
  const reactivated: string[] = [];
  const SCAN_CONCURRENCY = 20;
  const scanLocation = async (
    loc: LocationRow,
  ): Promise<{ found: Array<{ link: GHLUserLink; name: string; tz: string | null }>; errorKind: "none" | "deauth" | "technical" }> => {
    try {
      const client = new GHLClient(loc.company_id, loc.location_id);
      // GHL API: GET /users/ filtrando por location
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

      const out: Array<{ link: GHLUserLink; name: string; tz: string | null }> = [];
      for (const u of res.users || []) {
        if (normalizePhone(u.phone || "") === normalizedPhone) {
          const tz = (u.timezone || "").trim() || null;
          out.push({
            link: {
              location_id: loc.location_id,
              ghl_user_id: u.id,
              location_name: loc.location_name || null,
              role: u.roles?.role || null,
              timezone: tz,
            },
            name: [u.firstName, u.lastName].filter(Boolean).join(" "),
            tz,
          });
        }
      }
      return { found: out, errorKind: "none" };
    } catch (err) {
      const kind = classifyScanError(err);
      console.warn(`[identity] scan falhou em ${loc.location_id} (${kind}):`, err instanceof Error ? err.message : err);
      // Falha parcial não bloqueia as outras locations.
      return { found: [], errorKind: kind };
    }
  };

  for (let i = 0; i < toScan.length; i += SCAN_CONCURRENCY) {
    const batch = toScan.slice(i, i + SCAN_CONCURRENCY);
    const batchResults = await Promise.all(batch.map(scanLocation));
    batchResults.forEach((res, j) => {
      const loc = batch[j];
      if (res.errorKind === "technical") techErrors++;
      else if (res.errorKind === "deauth") deauthThisPass.push(loc.location_id);
      else if (loc.deauthorized_at) reactivated.push(loc.location_id); // varreu OK uma antes-marcada → reativou
      for (const m of res.found) {
        matches.push(m.link);
        if (!displayName && m.name) displayName = m.name;
        if (!repTimezone && m.tz) repTimezone = m.tz;
      }
    });
  }

  // Persiste (des)autorização — best-effort (otimização do próximo scan, não
  // correção). Falha aqui (ex: coluna ausente pré-00118) é inofensiva: ignoramos.
  if (deauthThisPass.length) {
    await supabase
      .from("locations")
      .update({ deauthorized_at: new Date(nowMs).toISOString() })
      .in("location_id", deauthThisPass);
  }
  if (reactivated.length) {
    await supabase.from("locations").update({ deauthorized_at: null }).in("location_id", reactivated);
  }

  if (matches.length === 0) {
    // Fix bug observado em prod 2026-06-16 (onboarding mudo): distingue "rep
    // genuinamente não é user em nenhuma location" (null → "não cadastrado") de "a
    // varredura QUEBROU tecnicamente em TODAS as ativas" (token GHL caído →
    // "scan_failed"). Dizer "não cadastrado" num apagão é mentira que o ESCONDE.
    // As inativas (deauth/puladas) NÃO contam — só falha técnica das que deveriam
    // responder. okScans = quantas varreram OK (acharam ou não o phone). Exige
    // techErrors>0 pra não disparar quando o cenário é "todas inativas" (esperado).
    const okScans = toScan.length - techErrors - deauthThisPass.length;
    if (okScans === 0 && techErrors > 0) {
      reportError({
        title: "SparkBot: varredura de identificação de rep falhou 100%",
        feature: "sparkbot-identify-rep",
        severity: "critical",
        description:
          `identifyRep não conseguiu varrer NENHUMA das ${toScan.length} locations ativas ` +
          `(todas erraram tecnicamente) ao procurar o phone. Provável apagão de token GHL — ` +
          `onboarding de rep novo está MUDO.`,
        metadata: {
          phone,
          locations_total: locations.length,
          scanned: toScan.length,
          tech_errors: techErrors,
          skipped_inactive: skippedInactive + deauthThisPass.length,
        },
      });
      return "scan_failed";
    }
    return null;
  }

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
  await mergeRepProfile(repId, profilePatch);
}

/** Marca terms como aceitos. */
export async function acceptTerms(repId: string): Promise<void> {
  await setTermsAccepted(repId, new Date().toISOString());
}

/**
 * Marca terms como REJEITADOS. Fix CRITICAL Track 1 C1 (review 2026-05-05):
 * antes, rep que recusava ficava em loop infinito porque rejeição não era
 * persistida. Agora bot silencia até admin limpar a flag manualmente
 * (UPDATE rep_identities SET terms_rejected_at = NULL WHERE id = X).
 */
export async function rejectTerms(repId: string): Promise<void> {
  await setTermsRejected(repId, new Date().toISOString());
}

// --- Terms PARTE 2 (campanha de grupo, 2026-06-18) -------------------------

/** Aceita a Parte 2 (campanha de grupo). Limpa o pending. */
export async function acceptGroupCampaignTerms(repId: string): Promise<void> {
  await setGroupCampaignTermsAccepted(repId, new Date().toISOString());
}

/** Recusa a Parte 2. Limpa o pending. NÃO silencia o SparkBot. */
export async function rejectGroupCampaignTerms(repId: string): Promise<void> {
  await setGroupCampaignTermsRejected(repId, new Date().toISOString());
}

/** Marca que o rep entrou no fluxo de aceite da Parte 2 (a tool schedule chama). */
export async function markGroupCampaignTermsPending(repId: string): Promise<void> {
  await setGroupCampaignTermsPending(repId, new Date().toISOString());
}

/** Limpa o pending da Parte 2 sem registrar aceite/recusa (resposta ambígua). */
export async function clearGroupCampaignTermsPendingState(repId: string): Promise<void> {
  await clearGroupCampaignTermsPending(repId);
}

/** Seta active_location_id (quando rep escolhe qual operar). */
export async function setActiveLocation(repId: string, locationId: string): Promise<void> {
  await repoSetActiveLocation(repId, locationId, new Date().toISOString());
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

  await updateRepById(rep.id, { is_internal: detected, updated_at: new Date().toISOString() });
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
