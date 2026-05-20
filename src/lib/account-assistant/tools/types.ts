/**
 * Tipos compartilhados pelo tool catalog do Sparkbot.
 *
 * Cada tool em tools/<categoria>.ts exporta um array de { def, handler }
 * que vai ser concatenado no registry final de tools/index.ts.
 */

import type { GHLClient } from "@/lib/ghl/client";
import type { ToolDefinition, ToolResult, RepIdentity, RepInput } from "@/types/account-assistant";

export interface ToolContext {
  rep: RepIdentity;
  locationId: string; // active_location_id resolvido
  companyId: string;
  ghlClient: GHLClient;
  /**
   * Quando setado, indica que estamos em modo de teste — tools de agendamento
   * (schedule_reminder) salvam essa session no payload pra disparar o reminder
   * na sessão correta. Quando undefined, é fluxo real (V3 envia via WhatsApp).
   */
  testSessionId?: string | null;
  /**
   * H8: enforcement de confirmação no nível de execução.
   * - "always" — toda tool exige confirmed_by_rep:true
   * - "medium_and_high" — só tools risk=medium ou high exigem
   * - "high_only" — só tools risk=high exigem
   * Bypass: handler recebe arg confirmed_by_rep:true do LLM (que pega depois
   * do "Confirma?" verbal do rep).
   */
  confirmationMode?: "always" | "medium_and_high" | "high_only";
  /**
   * Anexo da turn atual (imagem/PDF/CSV/XLSX). Usado por tools como
   * `import_contacts_from_data` que precisam acessar rows completas SEM
   * que o LLM tenha que copiá-las pro `args` (economiza tokens + evita
   * que o LLM perca rows na hora de copiar 500 linhas como string).
   */
  attachment?: RepInput | null;
  /**
   * KBs habilitadas pelo admin nesta location. Usado pelo
   * query_carrier_knowledge pra rejeitar consultas a KB desabilitada.
   * Default no caller (processor/dispatcher): ambas habilitadas.
   */
  enabledKbs?: string[];
}

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => Promise<ToolResult>;

export interface ToolEntry {
  def: ToolDefinition;
  handler: ToolHandler;
}

/**
 * IDs do GHL são alfanuméricos ~20 chars. Se o LLM mandar algo curto
 * (ex: "2", "pedro"), quase certamente inventou — rejeita antes de bater
 * na API e dá dica pra ele chamar search_contacts primeiro.
 *
 * Fix stress test 2026-05-03: regex e length tightened pra rejeitar
 * "aaaaaaaaaa" (10 same chars), strings só numéricas (phones), padrões de
 * email parcial, etc. Real GHL IDs são alfanuméricos misturados.
 */
export function validateGhlId(id: string, entityName: string): ToolResult | null {
  const isInvalid =
    !id ||
    typeof id !== "string" ||
    id.length < 18 ||                       // GHL IDs reais sempre >= 18 chars
    !/^[A-Za-z0-9]+$/.test(id) ||           // sem `_-` (eram permitidos antes — IDs reais não usam)
    /^[0-9]+$/.test(id) ||                   // tudo numérico = phone, não ID
    /^(.)\1+$/.test(id);                     // todos chars iguais (aaaaaa…)
  if (isInvalid) {
    return {
      status: "error",
      message: `${entityName}_id inválido: "${id}". IDs do Spark Leads têm ~20 chars alfanuméricos misturados (ex: 'ErpM2X8vR1U4IrRTZnKX'). Use search_contacts ou get_contact pra obter o ID real antes de chamar esta tool.`,
      retryable: false,
    };
  }
  return null;
}

/**
 * Valida ISO 8601. Datas passadas pelas tools devem ser ISO com Z (UTC) ou
 * offset (+HH:MM). Devolve null se OK, ou ToolResult de erro.
 */
export function validateIso8601(value: string, fieldName: string): ToolResult | null {
  if (!value) return { status: "error", message: `${fieldName} obrigatório`, retryable: false };
  const parsed = new Date(value);
  if (isNaN(parsed.getTime())) {
    return {
      status: "error",
      message: `${fieldName} não é ISO 8601 válido: "${value}". Use formato '2026-04-28T10:00:00-05:00' ou '2026-04-28T15:00:00Z'.`,
      retryable: false,
    };
  }
  return null;
}

/** Helper pra extrair o ghl_user_id do rep na location ativa. */
export function getRepGhlUserId(ctx: ToolContext): string | undefined {
  return ctx.rep.ghl_users.find((u) => u.location_id === ctx.locationId)?.ghl_user_id;
}

/**
 * Resolve `assigned_to` / `assigned_user_id` pra ghl_user_id real.
 *
 * Pedro 2026-05-14: criado pra cobrir 2 casos:
 *  1. Tasks atribuídas a outro user via input do rep ("cria task pro João")
 *  2. Bug histórico onde LLM mandava `"self"` literal como string e GHL
 *     rejeitava com 422 "user id not part of calendar team" (signal HIGH
 *     2 hits 2026-05-11).
 *
 * Valores aceitos:
 *  - undefined/null/'' → { user_id: undefined } (caller decide default)
 *  - 'self' | 'me' | 'eu' | 'rep' | 'self_user' → ghl_user_id do rep ativo
 *  - UUID-like (>=18 chars alfanuméricos) → returned as-is
 *  - Qualquer outro → erro estruturado pro LLM corrigir (use list_users)
 */
export function resolveAssignedUserId(
  ctx: ToolContext,
  raw: unknown,
): { ok: true; user_id: string | undefined } | { ok: false; error: ToolResult } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, user_id: undefined };
  }
  const original = String(raw).trim();
  if (!original) return { ok: true, user_id: undefined };

  const lower = original.toLowerCase();
  if (["self", "me", "eu", "rep", "self_user", "myself"].includes(lower)) {
    const repId = getRepGhlUserId(ctx);
    // Pedro 2026-05-20 (fluxo 15:34): se não der pra resolver o user do rep,
    // NÃO erra (antes a msg "use list_users + ID explícito" fazia o LLM listar
    // users e perguntar "qual seu user?" + sugerir um aleatório). Em vez disso,
    // segue SEM atribuir — a tool decide o default (ex: create_appointment já
    // omite assignedUserId por padrão). Comportamento "self = silencioso".
    if (!repId) {
      console.warn(
        `[resolveAssignedUserId] 'self' irresolúvel pro rep ${ctx.rep.id} na location ${ctx.locationId} — seguindo SEM atribuir.`,
      );
      return { ok: true, user_id: undefined };
    }
    return { ok: true, user_id: repId };
  }

  // Valida como UUID-like (mesma heurística do validateGhlId mas standalone)
  if (original.length < 18 || !/^[A-Za-z0-9]+$/.test(original)) {
    return {
      ok: false,
      error: {
        status: "error",
        message:
          `assigned_to inválido: "${original}". Use 'self' (atribuir ao rep ativo) ou um ghl_user_id válido ` +
          `(~20 chars alfanuméricos). Liste opções com list_users e use o campo \`id\` exato.`,
        retryable: false,
      },
    };
  }
  return { ok: true, user_id: original };
}

/**
 * Wrap padrão pra tools que falham na chamada Spark Leads (GHL API): converte
 * Error em ToolResult de erro com mensagem útil pro LLM corrigir.
 *
 * Histórico de evolução:
 * - Stress test 2026-05-03: antes expunhamos err.message CRU, vazando URLs
 *   internas + IDs de outros tenants. Mascaramos pra "Spark Leads rejeitou X".
 * - Pedro 2026-05-04 (fix duplicate contact): extrai meta.contactId do
 *   400 pra LLM oferecer update_contact em vez de criar.
 * - Pedro 2026-05-04 (Marcela slot): mascarar tudo era ruim — LLM não
 *   sabe se é look-busy, slot ocupado, validação, permissão. Agora
 *   EXTRAI o `message` do JSON do GHL e expõe SANITIZADO (sem URLs,
 *   traceIds, IDs internos) pro LLM. LLM pode reagir inteligentemente
 *   ("slot indisponível? oferece outro horário"; "validation? ajusta o
 *   campo"; etc). Mensagem real do GHL é o single source of truth.
 *
 * Sanitização: remove URLs, traceIds, GHL location/company IDs (pra não
 * vazar info inter-tenant). Mantém status code + message + relevant meta.
 */

/**
 * Limpa mensagem do GHL antes de expor pro LLM. Remove campos sensíveis
 * mas mantém info útil pro LLM tomar decisão.
 */
function sanitizeGhlMessage(rawMsg: string): string {
  return rawMsg
    // URLs (http/https)
    .replace(/https?:\/\/[^\s,)"]+/g, "[url]")
    // traceId, sessionId, requestId
    .replace(/"(traceId|sessionId|requestId|x-request-id)"\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"')
    // locationId, companyId, accountId (info inter-tenant)
    .replace(/"(locationId|companyId|accountId|tenantId)"\s*:\s*"[^"]+"/gi, '"$1":"[redacted]"')
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Extrai status code + mensagem semântica do erro thrown por GHLClient.
 * Formato típico: `GHL API 400: {"message":"X","statusCode":400,"meta":{...},"traceId":"..."}`
 *
 * Returns { statusCode, message, meta } onde meta tem `contactId`/`contactName`/`field`
 * etc preservados (sanitização já foi aplicada).
 */
function extractGhlError(fullMsg: string): {
  statusCode: number | null;
  message: string | null;
  meta: Record<string, unknown> | null;
} {
  const codeMatch = fullMsg.match(/GHL API (\d{3}):/);
  const statusCode = codeMatch ? parseInt(codeMatch[1]) : null;

  const jsonMatch = fullMsg.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return { statusCode, message: null, meta: null };

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      message?: string | string[];
      meta?: Record<string, unknown>;
    };
    let msg: string | null = null;
    if (typeof parsed.message === "string") msg = parsed.message;
    else if (Array.isArray(parsed.message)) msg = parsed.message.join("; ");
    return {
      statusCode,
      message: msg,
      meta: parsed.meta ?? null,
    };
  } catch {
    return { statusCode, message: null, meta: null };
  }
}

export function ghlErrorToResult(err: unknown, action: string): ToolResult {
  const fullMsg = err instanceof Error ? err.message : "Erro desconhecido";
  console.warn(`[ghl] ${action} falhou:`, fullMsg);

  const { statusCode, message: ghlMsg, meta } = extractGhlError(fullMsg);

  // Onda 2 (2026-05-20): IAM-unsupported — erro PERMANENTE do endpoint.
  // GHL retorna 5xx com "not yet supported by the IAM Service".
  // client.ts já jogou imediatamente (sem retry); aqui classificamos pra
  // flagScopeIssue em executeTool poder alertar o admin.
  if (/not yet supported by the IAM|not supported by the IAM|IAM Service/i.test(fullMsg)) {
    return {
      status: "error",
      message:
        "Essa ação não é suportada pelo Spark Leads pra esse recurso — não dá pra fazer por aqui",
      retryable: false,
      code: "unsupported_endpoint",
    };
  }

  // Onda 2 (2026-05-20): 403 — escopo insuficiente ou location sem acesso.
  // Mantém mensagem existente mas injeta o code pra governança de escopo.
  if (statusCode === 403 || /forbidden/i.test(fullMsg)) {
    return {
      status: "error",
      message:
        ghlMsg
          ? `${action}: ${sanitizeGhlMessage(ghlMsg)} (código 403)`
          : `${action}: permissão negada (token sem escopo necessário ou recurso de outra location)`,
      retryable: false,
      code: "scope_or_location",
    };
  }

  // Caso especial mantido: duplicate contacts (400 com meta.contactId).
  // Extrai contactId pra LLM oferecer update_contact em vez de create.
  if (
    /duplicated\s+contacts/i.test(fullMsg) ||
    /duplicate\s+key/i.test(fullMsg) ||
    (meta?.contactId && /duplicat/i.test(ghlMsg || ""))
  ) {
    const existingId =
      (meta?.contactId as string) ||
      fullMsg.match(/"contactId"\s*:\s*"([A-Za-z0-9]{18,})"/)?.[1] ||
      null;
    const existingName =
      (meta?.contactName as string) ||
      fullMsg.match(/"contactName"\s*:\s*"([^"]+)"/)?.[1] ||
      null;
    return {
      status: "error",
      message:
        `Esse contato já existe no Spark Leads` +
        (existingName ? ` (${existingName})` : "") +
        (existingId ? ` — ID: ${existingId}.` : ".") +
        ` Pra atualizar dados, use update_contact com esse contact_id.` +
        ` Pra adicionar tags, use add_tag.` +
        ` Pra criar nota nele, use create_note.`,
      retryable: false,
    };
  }

  // Caminho principal: SE temos mensagem do GHL, expõe sanitizada pro LLM.
  // Fix Pedro 2026-05-04: antes mascarávamos pra "Spark Leads rejeitou X" —
  // LLM não tinha como tomar decisão. Agora bot vê "The slot you have
  // selected is no longer available" e pode oferecer outro horário, ou
  // "phone is invalid" e pode pedir pro rep corrigir.
  if (ghlMsg) {
    const sanitized = sanitizeGhlMessage(ghlMsg);
    const codeStr = statusCode ? ` (código ${statusCode})` : "";
    const metaHints: string[] = [];
    if (meta?.field) metaHints.push(`campo: ${String(meta.field)}`);
    if (meta?.matchingField) metaHints.push(`campo conflitante: ${String(meta.matchingField)}`);
    const metaStr = metaHints.length > 0 ? ` [${metaHints.join(", ")}]` : "";
    return {
      status: "error",
      message: `${action} falhou: ${sanitized}${metaStr}${codeStr}`,
      retryable:
        statusCode === 429 ||
        (statusCode !== null && statusCode >= 500 && statusCode < 600),
    };
  }

  // Fallback: sem mensagem extraída do JSON, usa mapeamento por status code.
  // Mantém comportamento legado pros casos onde o erro não veio em JSON
  // (ex: network errors, timeout, response não-JSON do gateway).
  let safeMsg = `Spark Leads rejeitou ${action}`;
  if (statusCode === 404 || /not\s*found/i.test(fullMsg)) {
    safeMsg = `${action}: recurso não encontrado no Spark Leads (provavelmente ID inválido ou deletado)`;
  } else if (statusCode === 403 || /forbidden/i.test(fullMsg)) {
    safeMsg = `${action}: permissão negada (token sem escopo necessário ou recurso de outra location)`;
  } else if (statusCode === 422 || /validation/i.test(fullMsg)) {
    safeMsg = `${action}: dados inválidos (verifique campos obrigatórios)`;
  } else if (statusCode === 401 || /unauthor/i.test(fullMsg)) {
    safeMsg = `${action}: token expirado ou inválido (admin recarregar)`;
  } else if (statusCode === 429 || /rate.limit/i.test(fullMsg)) {
    safeMsg = `${action}: rate limit do Spark Leads — tente em alguns segundos`;
  } else if (
    (statusCode !== null && statusCode >= 500 && statusCode < 600) ||
    /server.error/i.test(fullMsg)
  ) {
    safeMsg = `${action}: erro temporário do Spark Leads — tente de novo`;
  }
  return {
    status: "error",
    message: safeMsg,
    retryable:
      statusCode === 429 ||
      (statusCode !== null && statusCode >= 500 && statusCode < 600),
  };
}
