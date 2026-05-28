/**
 * POST /api/hub/campaigns/preview — count rápido de contatos via Filter Engine (F21).
 *
 * Pedro 2026-05-28: hoje rep cria campanha sem saber quantos contatos vão
 * receber. Pode criar pra 0 (footgun silencioso) ou pra 5000 sem perceber.
 *
 * Endpoint executa o Filter Engine com a tag fornecida + limita 1 row (só
 * conta). Resposta:
 *   { count: 42, capped: false, sample_names: ["João", "Maria", "Pedro"] }
 *
 * Auth: session + agent_id check (mesma location).
 * NÃO cria nada — só leitura.
 */
import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { executeContactsFilter } from "@/lib/account-assistant/filter-engine";
import type {
  FilterExpression,
  FilterExecutionContext,
} from "@/lib/account-assistant/filter-engine";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export const maxDuration = 20;
export const dynamic = "force-dynamic";

const PreviewSchema = z.object({
  agent_id: z.string().uuid(),
  tag: z.string().min(1).max(80),
});

const PREVIEW_HARD_CAP = 5000;
const SAMPLE_SIZE = 5;

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  const parsed = PreviewSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorResponse(
      "Dados inválidos: " + parsed.error.issues.map((i) => i.message).join("; "),
      400,
      "invalid_input",
    );
  }
  const { agent_id, tag } = parsed.data;

  const supabase = createAdminClient();

  // Scope-check: agente é da location E lead-facing.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, type, location_id")
    .eq("id", agent_id)
    .eq("location_id", session.locationId)
    .maybeSingle();
  if (!agent) return errorResponse("Agente não encontrado", 404, "agent_not_found");

  // Resolve company_id pra GHL client.
  const { data: location } = await supabase
    .from("locations")
    .select("company_id")
    .eq("location_id", session.locationId)
    .maybeSingle();
  if (!location?.company_id) {
    return errorResponse("Sub-account não sincronizada com Spark Leads", 500, "location_not_synced");
  }

  // Rep_id pro contexto (usa qualquer rep da location pra evitar erro de scope).
  const { data: rep } = await supabase
    .from("rep_identities")
    .select("id")
    .eq("location_id", session.locationId)
    .limit(1)
    .maybeSingle();
  if (!rep) {
    return errorResponse("Nenhum rep cadastrado nesta sub-account", 500, "no_rep");
  }

  const ghlClient = new GHLClient(location.company_id, session.locationId);
  const filterCtx: FilterExecutionContext = {
    rep_id: rep.id,
    location_id: session.locationId,
    company_id: location.company_id,
    agent_id,
    ghl_client: ghlClient,
    consumer_tool: "campaign_preview",
  };

  const filter: FilterExpression = {
    field: "tags",
    op: "contains",
    value: tag.trim(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;

  const filterResult = await executeContactsFilter(filter, filterCtx, {
    limit: PREVIEW_HARD_CAP,
  });

  if (filterResult.status !== "ok") {
    return errorResponse(
      `Filtro falhou: ${filterResult.message || filterResult.status}`,
      400,
      "filter_failed",
    );
  }

  const items = filterResult.items || [];
  const count = items.length;
  const capped = count >= PREVIEW_HARD_CAP;
  const sampleNames = items
    .slice(0, SAMPLE_SIZE)
    .map((c) => c.name || c.firstName || "Contato sem nome")
    .filter((n): n is string => Boolean(n));

  return NextResponse.json({
    ok: true,
    count,
    capped,
    sample_names: sampleNames,
    total_reported_by_ghl: filterResult.total_reported_by_ghl ?? null,
  });
}
