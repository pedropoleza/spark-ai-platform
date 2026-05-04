/**
 * Registry consolidado de todas as tools do Sparkbot.
 *
 * 38 tools no total, organizadas por categoria. A IA recebe a lista
 * inteira (ou um subset filtrado pelas regras de proatividade).
 */

import type { ToolDefinition } from "@/types/account-assistant";
import type { ToolResult } from "@/types/account-assistant";
import type { ToolContext, ToolEntry } from "./types";
import { CONTACTS_TOOLS } from "./contacts";
import { NOTES_TOOLS } from "./notes";
import { TASKS_TOOLS } from "./tasks";
import { TAGS_TOOLS } from "./tags";
import { CALENDAR_TOOLS } from "./calendar";
import { OPPORTUNITIES_TOOLS } from "./opportunities";
import { MESSAGES_TOOLS } from "./messages";
import { METADATA_TOOLS } from "./metadata";
import { REMINDERS_TOOLS } from "./reminders";
import { CARRIER_KB_TOOLS } from "./carrier_kb";
import { TABULAR_TOOLS } from "./tabular";
import { IDENTITY_TOOLS } from "./identity";

const ALL_ENTRIES: ToolEntry[] = [
  ...CONTACTS_TOOLS,
  ...NOTES_TOOLS,
  ...TASKS_TOOLS,
  ...TAGS_TOOLS,
  ...CALENDAR_TOOLS,
  ...OPPORTUNITIES_TOOLS,
  ...MESSAGES_TOOLS,
  ...METADATA_TOOLS,
  ...REMINDERS_TOOLS,
  ...CARRIER_KB_TOOLS,
  ...TABULAR_TOOLS,
  ...IDENTITY_TOOLS,
];

export const TOOL_REGISTRY: Record<string, ToolEntry> = Object.fromEntries(
  ALL_ENTRIES.map((e) => [e.def.name, e]),
);

type ConfirmationMode = "always" | "medium_and_high" | "high_only";

/**
 * Decide se uma tool precisa do parâmetro `confirmed_by_rep` exposto no
 * schema, com base no risk e no confirmation_mode da location.
 *
 * Tem que bater com a lógica do gate em `executeTool` — qualquer tool que
 * o gate bloquear precisa do schema declarando o flag, senão a LLM fica
 * em loop "Confirma? → sim → bloqueado de novo" porque o SDK pode não
 * propagar campos não declarados (especialmente OpenAI strict mode).
 */
function toolRequiresConfirmation(
  risk: "safe" | "medium" | "high",
  mode: ConfirmationMode,
): boolean {
  if (mode === "always") return true;
  if (mode === "medium_and_high") return risk === "medium" || risk === "high";
  return risk === "high"; // high_only
}

/**
 * Injeta `confirmed_by_rep` no schema da tool quando o gate exige.
 * Não muta o def original — clona pra preservar pureza de TOOL_REGISTRY.
 */
function withConfirmationParam(def: ToolDefinition, mode: ConfirmationMode): ToolDefinition {
  if (!toolRequiresConfirmation(def.risk, mode)) return def;

  const params = (def.parameters || {}) as { properties?: Record<string, unknown> };
  const properties = { ...(params.properties || {}) };
  // Já tem? Não sobrescreve (caso alguma tool um dia declare explicitamente).
  if (!properties.confirmed_by_rep) {
    properties.confirmed_by_rep = {
      type: "boolean",
      description:
        "OBRIGATÓRIO antes de executar esta tool. " +
        "Pergunte ao rep 'Confirma?' e SÓ envie `true` depois de receber 'sim/confirma/pode/ok'. " +
        "Não invente confirmação — sem este flag, o sistema bloqueia.",
    };
  }
  return {
    ...def,
    parameters: { ...params, properties },
  };
}

/**
 * Array de definitions pra passar pro LLM (Anthropic/OpenAI tools API).
 *
 * `confirmationMode` é OPCIONAL pra preservar callers legados, mas SEMPRE
 * deve ser passado em produção: sem ele, schemas saem sem
 * `confirmed_by_rep`, e o LLM fica em loop quando o gate bloqueia.
 *
 * `disabledNames` (2026-05-03): admin pode banir tools específicas via
 * agent_configs.disabled_tools. Bypass complete — LLM nem vê o schema.
 */
export function getAllToolDefinitions(
  confirmationMode: ConfirmationMode = "high_only",
  disabledNames?: string[],
): ToolDefinition[] {
  const disabled = new Set(disabledNames || []);
  return ALL_ENTRIES
    .filter((e) => !disabled.has(e.def.name))
    .map((e) => withConfirmationParam(e.def, confirmationMode));
}

/** Subset filtrado por nomes (usado pelas regras de proatividade com tools_allowed). */
export function getToolDefinitions(
  allowedNames?: string[] | null,
  confirmationMode: ConfirmationMode = "high_only",
  disabledNames?: string[],
): ToolDefinition[] {
  const disabled = new Set(disabledNames || []);
  const allowed = allowedNames && allowedNames.length > 0 ? new Set(allowedNames) : null;
  const entries = ALL_ENTRIES.filter((e) => {
    if (disabled.has(e.def.name)) return false;
    if (allowed && !allowed.has(e.def.name)) return false;
    return true;
  });
  return entries.map((e) => withConfirmationParam(e.def, confirmationMode));
}

/**
 * Executa tool por nome. Retorna erro estruturado se nome desconhecido.
 *
 * H8 (review 2026-04-28): gate de confirmação enforced em CÓDIGO, não só
 * no prompt. Antes deste fix, o `confirmation_mode` era apenas instrução
 * textual — LLM podia ignorar e o tool rodava mesmo. Agora:
 *   - "always": toda tool requer args.confirmed_by_rep === true
 *   - "medium_and_high": tools risk=medium ou high requerem
 *   - "high_only": só tools risk=high requerem
 * O LLM deve incluir `confirmed_by_rep: true` no input após confirmação
 * verbal do rep ("Confirma? → sim" → próxima tool call inclui o flag).
 */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const entry = TOOL_REGISTRY[name];
  if (!entry) {
    return { status: "error", message: `Tool desconhecida: ${name}`, retryable: false };
  }

  const risk = entry.def.risk;

  // Test session gate (fix audit Phase 0): se rep está em modo teste,
  // tools de WRITE retornam mock. Antes, qualquer teste real do Pedro
  // mexia no CRM/WhatsApp de produção (delete_contact, send_message,
  // schedule_reminder iam direto pra GHL/WhatsApp).
  // Tools risk=safe (read-only) seguem normal pra não quebrar análises.
  //
  // Fix CRITICAL stress test 2026-05-03: testSessionId="" (empty string)
  // era falsy no `&&` → BYPASS do gate. Agora exige string não-vazia.
  if (ctx.testSessionId && ctx.testSessionId.length > 0 && risk !== "safe") {
    console.log(`[Sparkbot:test] mock '${name}' (risk=${risk}, session=${ctx.testSessionId})`);
    return {
      status: "ok",
      data: {
        simulated: true,
        tool: name,
        risk,
        message: `[Test mode] '${name}' não foi executada de verdade — produção CRM intacta. Args recebidos: ${JSON.stringify(args).slice(0, 200)}`,
        args_preview: args,
      },
    };
  }

  // Gate de confirmação
  const mode = ctx.confirmationMode ?? "high_only";
  const requiresConfirm =
    mode === "always" ||
    (mode === "medium_and_high" && (risk === "medium" || risk === "high")) ||
    (mode === "high_only" && risk === "high");

  if (requiresConfirm && args.confirmed_by_rep !== true) {
    return {
      status: "error",
      message:
        `Esta tool ('${name}', risk=${risk}) exige confirmação no modo '${mode}'. ` +
        `Pergunte ao rep: "Vou ${formatActionDescription(name, args)} — confirma?" ` +
        `Quando o rep responder 'sim/confirma/pode/ok', RECHAME esta mesma tool ` +
        `com EXATAMENTE os mesmos argumentos + o campo "confirmed_by_rep": true ` +
        `incluído no input. O campo é booleano (true, sem aspas).`,
      retryable: true,
    };
  }

  // Remove a flag antes de chamar o handler — handlers individuais não
  // precisam saber dela, é só sinal pro gate.
  const { confirmed_by_rep: _confirmed, ...handlerArgs } = args as Record<string, unknown> & {
    confirmed_by_rep?: boolean;
  };
  void _confirmed;
  return entry.handler(ctx, handlerArgs);
}

/** Frase humana pra prompt de confirmação. Best-effort. */
function formatActionDescription(name: string, args: Record<string, unknown>): string {
  if (name === "send_message_to_contact") {
    return `mandar mensagem pro contato ${args.contact_id || ""}`;
  }
  if (name === "create_appointment") {
    return `criar appointment em ${args.start_time || "horário informado"}`;
  }
  if (name.startsWith("delete_")) {
    return `${name.replace("_", " ")} ${args.id || ""}`;
  }
  if (name === "update_contact") return "atualizar contato";
  if (name === "create_note") return "criar nota";
  if (name === "create_task") return "criar task";
  if (name === "add_tag") return `adicionar tag '${args.tag || ""}'`;
  if (name === "remove_tag") return `remover tag '${args.tag || ""}'`;
  return name.replace(/_/g, " ");
}

export type { ToolContext } from "./types";
