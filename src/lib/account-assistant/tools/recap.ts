/**
 * Recap Mode (H31.3, Pedro 2026-05-15).
 *
 * Comando "recap" / "resumo" / "o que fizemos?" — bot devolve resumo
 * das últimas N writes da sessão atual.
 *
 * Lê sparkbot_messages do rep nos últimos X minutos (default 30) e
 * extrai tool_calls com status=ok que sejam WRITES.
 */

import type { ToolEntry } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";

const RECAP_TOOL: ToolEntry = {
  def: {
    name: "recap_session",
    description:
      "Resume as últimas write actions executadas pelo bot na sessão atual do rep. Use quando rep falar 'recap', 'resumo', 'o que fizemos?', 'qual o status?', 'me mostra o que aconteceu', etc.\n\n" +
      "Retorna lista de writes (notes/tasks/contatos/opps/msgs/jobs criadas) com timestamps. Não inclui leituras (search/list) — só ações que MUDARAM estado.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        last_minutes: {
          type: "number",
          description: "Janela em minutos. Default 30, max 120.",
        },
      },
    },
  },
  handler: async (ctx, args) => {
    const minutes = Math.min(Math.max(Number(args.last_minutes) || 30, 1), 120);
    const cutoffIso = new Date(Date.now() - minutes * 60_000).toISOString();
    const supabase = createAdminClient();

    // Fix bug observado em review 2026-06-10: recap não escopava por location,
    // vazava writes de OUTRA sub-account do mesmo rep (multi-location que usa
    // switch_active_location). Espelha o filtro M9 do silence check
    // (processor.ts ~376) — escopa por active_location_id, que é a location
    // ativa NO MOMENTO do write (carimbada no insert do agent msg em
    // webhook-handler.ts). hub_location_id não serve: é o hub/canal da conversa,
    // constante entre switches, não escoparia nada.
    // Guard: rep multi-location que ainda não escolheu pode ter ctx.locationId
    // vazio — nesse caso NÃO aplica o filtro pra não zerar o recap (mesma
    // postura tolerante do M9).
    let query = supabase
      .from("sparkbot_messages")
      .select("created_at, role, content, metadata")
      .eq("rep_id", ctx.rep.id)
      .eq("role", "agent")
      .gte("created_at", cutoffIso);
    if (ctx.locationId) {
      query = query.eq("active_location_id", ctx.locationId);
    }
    const { data: msgs } = await query.order("created_at", { ascending: true });

    if (!msgs || msgs.length === 0) {
      return {
        status: "not_found",
        message: "Nada feito nessa janela — sessão sem ações recentes.",
      };
    }

    type ToolCall = {
      name?: string;
      input?: Record<string, unknown>;
      result_preview?: string;
    };

    interface WriteAction {
      timestamp: string;
      tool: string;
      summary: string;
    }

    const WRITE_TOOLS = new Set([
      "create_contact", "update_contact", "delete_contact",
      "create_note", "update_note", "delete_note",
      "create_task", "update_task", "complete_task", "delete_task",
      "add_tag", "remove_tag",
      "create_opportunity", "update_opportunity", "update_opportunity_status",
      "delete_opportunity", "create_appointment", "update_appointment",
      "delete_appointment", "block_calendar_slot",
      "send_message_to_contact", "schedule_message_to_contact",
      "schedule_bulk_message", "schedule_bulk_message_v2",
      "cancel_bulk_job", "pause_bulk_job", "resume_bulk_job",
      "schedule_reminder", "cancel_reminder",
      "import_contacts_from_data",
      "set_rep_alias", "forget_rep_alias",
      "confirm_rep_timezone", "switch_active_location",
      "set_daily_briefing",
    ]);

    const writes: WriteAction[] = [];
    for (const m of msgs) {
      const meta = (m.metadata as { tool_calls?: ToolCall[] } | null)?.tool_calls;
      if (!Array.isArray(meta)) continue;
      for (const tc of meta) {
        if (!tc.name || !WRITE_TOOLS.has(tc.name)) continue;
        const preview = tc.result_preview || "";
        // Só inclui status=ok
        if (!preview.includes('"status":"ok"')) continue;
        writes.push({
          timestamp: m.created_at,
          tool: tc.name,
          summary: extractSummary(tc.name, tc.input || {}, preview),
        });
      }
    }

    if (writes.length === 0) {
      return {
        status: "ok",
        data: {
          window_minutes: minutes,
          total_writes: 0,
          message: `Nenhuma ação executada nos últimos ${minutes}min.`,
        },
      };
    }

    // Formata
    const lines = [
      `*Últimos ${minutes}min — ${writes.length} ação${writes.length === 1 ? "" : "ões"}:*`,
      "",
    ];
    for (const w of writes) {
      const time = new Date(w.timestamp).toLocaleTimeString("pt-BR", {
        timeZone: (ctx.rep as { timezone?: string }).timezone || "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
      });
      lines.push(`✓ ${time} — ${w.summary}`);
    }

    return {
      status: "ok",
      data: {
        window_minutes: minutes,
        total_writes: writes.length,
        writes: writes.map((w) => ({
          timestamp: w.timestamp,
          tool: w.tool,
          summary: w.summary,
        })),
        recap_formatted: lines.join("\n"),
      },
    };
  },
};

function extractSummary(
  toolName: string,
  input: Record<string, unknown>,
  preview: string,
): string {
  // Tenta dar 1 linha legível do que aconteceu
  switch (toolName) {
    case "create_contact": {
      const fn = String(input.first_name || "");
      const ln = String(input.last_name || "");
      return `Contato criado: ${(fn + " " + ln).trim() || "(sem nome)"}`;
    }
    case "update_contact":
      return `Contato atualizado`;
    case "create_note":
      return `Nota criada${input.contact_id ? ` em contato ${String(input.contact_id).slice(0, 8)}` : ""}`;
    case "create_task":
      return `Task criada: ${String(input.title || "").slice(0, 40)}`;
    case "complete_task":
      return `Task marcada como concluída`;
    case "add_tag":
      return `Tag adicionada: ${Array.isArray(input.tags) ? (input.tags as string[]).join(", ") : ""}`;
    case "create_opportunity":
      return `Opportunity criada: ${String(input.name || "").slice(0, 40)}`;
    case "update_opportunity_status":
      return `Status da opp mudado pra ${String(input.status || "")}`;
    case "create_appointment":
      return `Appointment marcado ${String(input.start_time || "").slice(0, 16)}`;
    case "send_message_to_contact":
      return `Msg enviada${input.contact_id ? ` pra contato ${String(input.contact_id).slice(0, 8)}` : ""}`;
    case "schedule_bulk_message_v2": {
      const m = preview.match(/total_enqueued":(\d+)/);
      return `Disparo em massa criado: ${m?.[1] || "?"} contatos`;
    }
    case "schedule_reminder":
      return `Lembrete agendado: ${String(input.title || "").slice(0, 40)}`;
    case "pause_bulk_job":
      return `Disparo pausado`;
    case "cancel_bulk_job":
      return `Disparo cancelado`;
    case "resume_bulk_job":
      return `Disparo retomado`;
    case "set_rep_alias":
      return `Alias '${input.alias}' = '${String(input.expansion || "").slice(0, 40)}'`;
    case "switch_active_location":
      return `Location ativa trocada`;
    case "confirm_rep_timezone":
      return `Fuso confirmado: ${input.timezone}`;
    default:
      return `${toolName} executada`;
  }
}

export const RECAP_TOOLS: ToolEntry[] = [RECAP_TOOL];
