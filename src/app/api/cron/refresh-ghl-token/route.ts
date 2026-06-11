/**
 * Cron endpoint — refresh de todos os GHL company tokens.
 *
 * Pedro 2026-05-17: migra refresh do n8n pra Vercel cron. Roda 1x/dia
 * (1AM ET, configurado em vercel.json). Tokens duram 24h, refresh em
 * <24h mantém sempre válido.
 *
 * Segurança: requer header `Authorization: Bearer <CRON_SECRET>` ou
 * `x-vercel-cron: 1` (header automático do Vercel Cron).
 *
 * Idempotente — pode rodar várias vezes sem problema (cada call dá novo
 * par access+refresh).
 */

import { NextResponse } from "next/server";
import { refreshAllCompanyTokens } from "@/lib/ghl/token-refresher";
import { reportError } from "@/lib/admin-signals/report-error";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function isAuthorized(req: Request): boolean {
  // Vercel Cron automaticamente seta esse header
  if (req.headers.get("x-vercel-cron") === "1") return true;
  // Fallback: bearer secret
  const auth = req.headers.get("authorization") || "";
  const expected = `Bearer ${process.env.CRON_SECRET || ""}`;
  return auth === expected && expected !== "Bearer ";
}

export async function GET(req: Request) {
  if (!isAuthorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  const startTs = Date.now();
  try {
    const result = await refreshAllCompanyTokens();
    const durationMs = Date.now() - startTs;
    console.log(
      `[cron:refresh-ghl-token] ${result.refreshed}/${result.total} refreshed, ` +
        `${result.failed} failed in ${durationMs}ms`,
    );

    // Fix silent-failure 2026-06-10: refreshAllCompanyTokens() agrega os erros
    // por company e RETORNA NORMAL — então até "0/N renovados" caía aqui no
    // caminho de sucesso (200, ok:true) e o reportError do catch NUNCA rodava.
    // Resultado: falha TOTAL ficava muda até os tokens expirarem (~24h) e todo o
    // data plane (SparkBot + agentes lead-facing) começar a dar 401 em
    // /oauth/locationToken, sem nenhum alerta ligando o apagão ao refresh que
    // falhou. Agora alertamos no resultado AGREGADO (não só em crash). A
    // agregação em token-refresher.ts segue intacta — 1 company ruim não bloqueia
    // as outras; só passamos a reagir ao placar final.
    const totalFailure = result.total > 0 && result.refreshed === 0;
    const partialFailure = result.refreshed > 0 && result.failed > 0;

    if (totalFailure) {
      reportError({
        // Title ESTÁVEL (sem o N variável) pra clusterizar no /hub/admin/health.
        title: "Cron refresh-ghl-token: 0 tokens renovados — tokens GHL vão expirar",
        feature: "cron-refresh-ghl-token",
        severity: "critical",
        description:
          `0/${result.total} company tokens renovados (${result.failed} falharam). ` +
          `Tokens GHL expiram em ~24h → SparkBot + agentes lead-facing vão começar a ` +
          `falhar /oauth/locationToken com 401. Checar GHL_CLIENT_ID/GHL_CLIENT_SECRET ` +
          `e o endpoint OAuth do GHL.`,
        // Error sintético só pra dar exception (+stack) ao Sentry/paging — o
        // detalhe por company vai no metadata.failures.
        error: new Error(
          `refresh-ghl-token: 0/${result.total} renovados. Ex: ${result.failures[0]?.error ?? "?"}`,
        ),
        metadata: {
          total: result.total,
          refreshed: result.refreshed,
          failed: result.failed,
          failures: result.failures.slice(0, 20), // trunca pra não estourar o signal
        },
      });
    } else if (partialFailure) {
      reportError({
        title: "Cron refresh-ghl-token: refresh parcial — alguns tokens GHL falharam",
        feature: "cron-refresh-ghl-token",
        // SignalSeverity não tem "warning" — parcial entra como "high" (abaixo de
        // "critical", mas é outage garantido em ~24h pros companies que falharam).
        severity: "high",
        description:
          `${result.refreshed}/${result.total} renovados, ${result.failed} falharam. ` +
          `Os companies que falharam vão expirar em ~24h se não recuperarem no próximo run.`,
        metadata: {
          total: result.total,
          refreshed: result.refreshed,
          failed: result.failed,
          failures: result.failures.slice(0, 20),
        },
      });
    }

    return NextResponse.json(
      {
        ok: !totalFailure,
        total: result.total,
        refreshed: result.refreshed,
        failed: result.failed,
        failures: result.failures,
        duration_ms: durationMs,
      },
      // 500 em falha total → Vercel cron loga o run como failed também (não fica
      // só no signal). Parcial segue 200 (algo passou); o warning cobre o resto.
      { status: totalFailure ? 500 : 200 },
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[cron:refresh-ghl-token] FATAL:", msg);
    reportError({ title: "Cron refresh-ghl-token: crash (tokens GHL podem expirar → tudo quebra)", feature: "cron-refresh-ghl-token", severity: "critical", error: err });
    return NextResponse.json(
      { ok: false, error: msg, duration_ms: Date.now() - startTs },
      { status: 500 },
    );
  }
}

// Permite POST também (alguns schedulers preferem)
export async function POST(req: Request) {
  return GET(req);
}
