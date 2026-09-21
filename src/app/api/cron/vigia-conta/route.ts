/**
 * Crawl diário de saúde das contas lead-facing sob observação (H94).
 *
 * `?loc=a,b` escolhe as contas; sem isso usa `VIGIA_CONTAS` do env. Cada achado
 * com gravidade acima de "ok" vira sinal de admin — a ideia é que a conta grite
 * sozinha, em vez de depender do cliente reclamar (foi assim que a conta da
 * Marina passou dias com a cauda da fila em horas e a entrega falhando).
 */
import { NextRequest, NextResponse } from "next/server";
import { vigiarConta } from "@/lib/monitoring/vigia-conta";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";
import { reportError } from "@/lib/admin-signals/report-error";
import { createAdminClient } from "@/lib/supabase/admin";

export const maxDuration = 60;

const PADRAO = ["A62s5EQj1hldOuvBEowv", "ONRf1DUKVnfxivEGxcTj"];

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = new URL(request.url);
  const locs = (url.searchParams.get("loc") || process.env.VIGIA_CONTAS || PADRAO.join(","))
    .split(",").map((s) => s.trim()).filter(Boolean);
  const horas = Number(url.searchParams.get("horas") || 24);

  const sb = createAdminClient();
  const saida: unknown[] = [];

  for (const loc of locs) {
    try {
      const r = await vigiarConta(loc, horas);
      const ruins = r.achados.filter((a) => a.gravidade !== "ok");
      saida.push({ loc, ruins: ruins.length, achados: r.achados });

      for (const a of ruins) {
        // "medio" fica só no histórico — sinal todo dia vira ruído e o alarme
        // que grita lobo é o que ninguém lê (lição do H90).
        if (a.gravidade === "medio") continue;
        reportError({
          // Título ESTÁVEL (sem número variável) pra o dedup do painel não
          // criar um sinal novo a cada dia; o número vai na descrição.
          title: `[${loc}] vigia-conta: ${a.chave}`,
          feature: "vigia-conta",
          severity: a.gravidade === "critico" ? "critical" : "high",
          description: a.resumo,
          metadata: { location_id: loc, chave: a.chave, detalhe: a.detalhe },
        });
      }

      await sb.from("execution_log").insert({
        agent_id: null, location_id: loc, contact_id: "system",
        action_type: "vigia_conta_diario",
        action_payload: { horas, achados: r.achados },
        success: ruins.length === 0,
      }).then(() => {}, () => {});
    } catch (e) {
      saida.push({ loc, erro: e instanceof Error ? e.message : String(e) });
      reportError({ title: `Vigia de conta falhou (${loc})`, feature: "vigia-conta", severity: "high", error: e });
    }
  }

  return NextResponse.json({ ok: true, horas, contas: saida });
}
