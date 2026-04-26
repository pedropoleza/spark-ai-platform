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

/** Executa tool por nome. Retorna erro estruturado se nome desconhecido. */
export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  const entry = TOOL_REGISTRY[name];
  if (!entry) {
    return { status: "error", message: `Tool desconhecida: ${name}`, retryable: false };
  }
  return entry.handler(ctx, args);
}

export type { ToolContext } from "./types";
