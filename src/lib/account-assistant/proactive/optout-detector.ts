/**
 * Opt-out detector (Etapa 4.8 — Pedro 2026-05-28).
 *
 * D3: keywords default globais PT+EN + custom adicional por location.
 *
 * Lógica de match:
 *   1. Normaliza mensagem: lowercase, trim, remove pontuação.
 *   2. Se a mensagem normalizada bate EXATAMENTE com uma keyword (palavra
 *      única), OU se a keyword aparece como token isolado, é opt-out.
 *   3. Não pega "non-stop" como STOP (word boundary).
 *
 * Falso-positivo é RUIM (opt-out incorreto = contato nunca mais recebe
 * mensagem). Por isso match estrito por palavra inteira.
 *
 * Chamado pelo webhook GHL inbound assim que detecta msg de contato.
 */
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Default global: keywords mais comuns PT + EN. Lista deliberadamente curta
 * pra reduzir falso-positivo. Admin pode adicionar mais via Settings.
 */
const DEFAULT_OPTOUT_KEYWORDS = [
  // EN
  "stop",
  "unsubscribe",
  // PT
  "parar",
  "cancelar",
  "sair",
  "descadastrar",
  "remover",
];

export interface OptOutDetection {
  detected: boolean;
  matched_keyword?: string;
  source?: "default" | "custom";
}

/**
 * Carrega custom keywords de location_outreach_settings.
 * Default empty array. Cache curto seria nice mas read é barato.
 */
async function loadCustomKeywords(locationId: string): Promise<string[]> {
  const supabase = createAdminClient();
  const { data } = await supabase
    .from("location_outreach_settings")
    .select("custom_optout_keywords")
    .eq("location_id", locationId)
    .maybeSingle();
  const raw = (data?.custom_optout_keywords as string[] | null) || [];
  return raw
    .map((k) => k.trim().toLowerCase())
    .filter((k) => k.length > 0 && k.length < 60);
}

/**
 * Normaliza msg pro match. Remove pontuação e diacríticos pra cobrir variantes.
 */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // remove acentos
    .toLowerCase()
    .replace(/[!?.,;:"'`()[\]{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Detecta opt-out na mensagem. Match por palavra inteira (boundary).
 */
export async function detectOptOut(
  locationId: string,
  messageBody: string,
): Promise<OptOutDetection> {
  if (!messageBody || messageBody.trim().length === 0) {
    return { detected: false };
  }
  if (messageBody.length > 200) {
    // Mensagens longas raramente são opt-out — só matchar nas curtas evita
    // falso-positivo em conversas normais que tenham "stop" no meio.
    return { detected: false };
  }

  const normalized = normalize(messageBody);
  const tokens = new Set(normalized.split(/\s+/));

  // Default keywords (sempre ativas).
  for (const kw of DEFAULT_OPTOUT_KEYWORDS) {
    if (tokens.has(kw)) {
      return { detected: true, matched_keyword: kw, source: "default" };
    }
  }

  // Custom keywords da location (aditivo).
  const custom = await loadCustomKeywords(locationId);
  for (const kw of custom) {
    if (tokens.has(kw)) {
      return { detected: true, matched_keyword: kw, source: "custom" };
    }
  }

  return { detected: false };
}

/**
 * Marca o contato como opt-out na tabela outreach_optouts. Idempotente
 * via UNIQUE constraint (location_id, contact_id).
 */
export async function recordOptOut(
  locationId: string,
  contactId: string,
  matchedKeyword: string,
  source: "default" | "custom",
): Promise<{ ok: boolean; reason?: string }> {
  if (!contactId || !locationId) {
    return { ok: false, reason: "missing_args" };
  }
  const supabase = createAdminClient();
  const { error } = await supabase
    .from("outreach_optouts")
    .insert({
      location_id: locationId,
      contact_id: contactId,
      source: "keyword",
      reason: `auto:${source}:${matchedKeyword}`,
    });
  // UNIQUE constraint = idempotente. Código 23505 = duplicate key.
  if (error && error.code === "23505") {
    return { ok: true, reason: "already_opted_out" };
  }
  if (error) {
    return { ok: false, reason: error.message.slice(0, 200) };
  }
  return { ok: true };
}

/**
 * Conveniência: detect + record em uma chamada. Chamado pelo webhook inbound.
 */
export async function processInboundForOptOut(
  locationId: string,
  contactId: string,
  messageBody: string,
): Promise<OptOutDetection & { recorded?: boolean }> {
  const result = await detectOptOut(locationId, messageBody);
  if (!result.detected || !result.matched_keyword || !result.source) {
    return result;
  }
  const recordResult = await recordOptOut(
    locationId,
    contactId,
    result.matched_keyword,
    result.source,
  );
  return { ...result, recorded: recordResult.ok };
}

/**
 * Filtra uma lista de contact_ids removendo os que estão opt-out. Usado
 * pelo bulk-runner antes do envio (defensive — opt-out pode ter sido
 * adicionado depois do populate).
 */
export async function filterOutOptOutContacts(
  locationId: string,
  contactIds: string[],
): Promise<Set<string>> {
  if (!locationId || contactIds.length === 0) return new Set();
  const supabase = createAdminClient();
  const optedOut = new Set<string>();
  const CHUNK = 500;
  for (let i = 0; i < contactIds.length; i += CHUNK) {
    const chunk = contactIds.slice(i, i + CHUNK);
    const { data } = await supabase
      .from("outreach_optouts")
      .select("contact_id")
      .eq("location_id", locationId)
      .in("contact_id", chunk);
    for (const r of (data || []) as Array<{ contact_id: string }>) {
      optedOut.add(r.contact_id);
    }
  }
  return optedOut;
}

/**
 * Lista keywords ativas pra UI mostrar quais estão sendo monitoradas.
 */
export async function listActiveKeywords(
  locationId: string,
): Promise<{ default: string[]; custom: string[] }> {
  const custom = await loadCustomKeywords(locationId);
  return { default: [...DEFAULT_OPTOUT_KEYWORDS], custom };
}
