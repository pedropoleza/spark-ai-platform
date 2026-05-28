/**
 * GET /api/sparkbot/rep-status
 *
 * Etapa 2.5 do plano de gaps (Pedro 2026-05-28): o embed do SparkBot mostrava
 * sempre dot verde "online" — não dava sinal quando o agente foi pausado pela
 * agência ou quando o silence-gate ativou (≥4 proativos sem resposta). Rep
 * mandava "oi" e bot não respondia → parecia bug. Este endpoint retorna o
 * status pra colorir o dot + tooltip explicativo.
 *
 * Auth: Bearer JWT do /check-admin.
 *
 * Response:
 *   { online: boolean, status: "online" | "paused" | "silenced", message: string }
 *
 * Follow-up explícito (rastreado no PLANO): off_hours (dentro de working_hours/
 * quiet_hours) e cap_reached (cap mensal de gasto) exigem cálculo de timezone +
 * cap em runtime — vão em iteração futura. Por ora cobre o caso de "pausa
 * efetiva" do agente, que é o footgun maior.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { corsHeadersFor } from "@/lib/utils/cors";

export const maxDuration = 15;

export async function OPTIONS(request: NextRequest) {
  return new NextResponse(null, { status: 204, headers: corsHeadersFor(request) });
}

export async function GET(request: NextRequest) {
  const cors = corsHeadersFor(request);
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const payload = await verifySparkbotWebToken(token).catch(() => null);
  if (!payload) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: cors });
  }

  const supabase = createAdminClient();
  const { data: rep } = await supabase
    .from("rep_identities")
    .select("location_id, consecutive_proactive_without_reply")
    .eq("id", payload.rep_id)
    .maybeSingle();
  if (!rep) {
    return NextResponse.json(
      { online: false, status: "unknown", message: "Não consegui ler seu cadastro." },
      { headers: cors },
    );
  }

  // Status do agente SparkBot dessa location.
  const { data: agent } = await supabase
    .from("agents")
    .select("id, status")
    .eq("location_id", rep.location_id)
    .eq("type", "account_assistant")
    .maybeSingle();

  if (!agent) {
    return NextResponse.json(
      { online: false, status: "paused", message: "SparkBot não está liberado pra essa conta." },
      { headers: cors },
    );
  }
  if (agent.status !== "active") {
    return NextResponse.json(
      { online: false, status: "paused", message: "SparkBot pausado pela agência." },
      { headers: cors },
    );
  }
  // Silence gate (anti-spam): 4+ proativos consecutivos sem resposta → pausa
  // proativos pro rep. Resposta ao inbound funciona normalmente, mas vale
  // sinalizar pro user que algo está reduzido.
  if ((rep.consecutive_proactive_without_reply || 0) >= 4) {
    return NextResponse.json(
      {
        online: true,
        status: "silenced",
        message: "Em modo silêncio — proativos pausados porque você não respondeu 4 seguidos. Mande uma msg pro bot pra retomar.",
      },
      { headers: cors },
    );
  }

  return NextResponse.json(
    { online: true, status: "online", message: "Conectado." },
    { headers: cors },
  );
}
