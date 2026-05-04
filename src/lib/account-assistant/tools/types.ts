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
      message: `${entityName}_id inválido: "${id}". IDs do GHL têm ~20 chars alfanuméricos misturados (ex: 'ErpM2X8vR1U4IrRTZnKX'). Use search_contacts ou get_contact pra obter o ID real antes de chamar esta tool.`,
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
 * Wrap padrão pra tools que falham na chamada Spark Leads (GHL API): converte
 * Error em ToolResult de erro com mensagem útil pro LLM corrigir.
 *
 * Fix HIGH stress test 2026-05-03: antes expunhamos `err.message` cru, que
 * pode incluir detalhes do response (URLs internas, IDs, info de outro
 * tenant). Agora detecta padrões comuns (404/403/422) e devolve mensagem
 * resumida. Full message vai pra logs (Vercel) onde só admins acessam.
 *
 * Pedro 2026-05-04: também detecta "duplicated contacts" (caso comum quando
 * rep tenta criar contato com phone/email que já existe em outra location)
 * — extrai contactId existente do response body pra LLM oferecer atualizar.
 * Plus: mensagens user-facing usam "Spark Leads", não "GHL".
 */
export function ghlErrorToResult(err: unknown, action: string): ToolResult {
  const fullMsg = err instanceof Error ? err.message : "Erro desconhecido";
  console.warn(`[ghl] ${action} falhou:`, fullMsg);

  // Caso especial: duplicate contacts (400 com meta.contactId no body).
  // Extrai contactId existente pra LLM oferecer update em vez de create.
  if (/duplicated\s+contacts/i.test(fullMsg) || /duplicate\s+key/i.test(fullMsg)) {
    const match = fullMsg.match(/"contactId"\s*:\s*"([A-Za-z0-9]{18,})"/);
    const existingId = match ? match[1] : null;
    const nameMatch = fullMsg.match(/"contactName"\s*:\s*"([^"]+)"/);
    const existingName = nameMatch ? nameMatch[1] : null;
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

  // Mapeia padrões pra mensagens redacted que ainda ajudam LLM
  let safeMsg = `Spark Leads rejeitou ${action}`;
  if (/\b404\b/.test(fullMsg) || /not\s*found/i.test(fullMsg)) {
    safeMsg = `${action}: recurso não encontrado no Spark Leads (provavelmente ID inválido ou deletado)`;
  } else if (/\b403\b/.test(fullMsg) || /forbidden/i.test(fullMsg)) {
    safeMsg = `${action}: permissão negada (token sem escopo necessário ou recurso de outra location)`;
  } else if (/\b422\b/.test(fullMsg) || /validation/i.test(fullMsg)) {
    safeMsg = `${action}: dados inválidos (verifique campos obrigatórios)`;
  } else if (/\b401\b/.test(fullMsg) || /unauthor/i.test(fullMsg)) {
    safeMsg = `${action}: token expirado ou inválido (admin recarregar)`;
  } else if (/\b429\b/.test(fullMsg) || /rate.limit/i.test(fullMsg)) {
    safeMsg = `${action}: rate limit do Spark Leads — tente em alguns segundos`;
  } else if (/\b5\d\d\b/.test(fullMsg) || /server.error/i.test(fullMsg)) {
    safeMsg = `${action}: erro temporário do Spark Leads — tente de novo`;
  }
  return {
    status: "error",
    message: safeMsg,
    retryable: /\b(429|5\d\d)\b/.test(fullMsg),
  };
}
