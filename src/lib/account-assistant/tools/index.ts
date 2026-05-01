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
];

export const TOOL_REGISTRY: Record<string, ToolEntry> = Object.fromEntries(
  ALL_ENTRIES.map((e) => [e.def.name, e]),
);

/** Array de definitions pra passar pro LLM (Anthropic/OpenAI tools API). */
export function getAllToolDefinitions(): ToolDefinition[] {
  return ALL_ENTRIES.map((e) => e.def);
}

/** Subset filtrado por nomes (usado pelas regras de proatividade com tools_allowed). */
export function getToolDefinitions(allowedNames?: string[] | null): ToolDefinition[] {
  if (!allowedNames || allowedNames.length === 0) return getAllToolDefinitions();
  const set = new Set(allowedNames);
  return ALL_ENTRIES.filter((e) => set.has(e.def.name)).map((e) => e.def);
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

  // Gate de confirmação
  const mode = ctx.confirmationMode ?? "medium_and_high";
  const risk = entry.def.risk;
  const requiresConfirm =
    mode === "always" ||
    (mode === "medium_and_high" && (risk === "medium" || risk === "high")) ||
    (mode === "high_only" && risk === "high");

  if (requiresConfirm && args.confirmed_by_rep !== true) {
    return {
      status: "error",
      message:
        `Esta tool ('${name}', risk=${risk}) exige confirmação no modo '${mode}'. ` +
        `Pergunte ao rep: 'Vou ${formatActionDescription(name, args)} — confirma?' ` +
        `e SÓ depois de receber 'sim/confirma/pode' adicione args.confirmed_by_rep:true ` +
        `e chame esta tool de novo. Não invente confirmação.`,
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
