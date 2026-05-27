/**
 * Cron endpoint dedicado pro retry de cobrança (C3-1/C3-2/P0-3 ultra-review
 * 2026-05-26).
 *
 * ANTES: chargeUnbilledRecords só rodava dentro do Vercel cron `process-queue`
 * (1×/dia), num Promise.all de 4 jobs pesados disputando o orçamento de 60s.
 * O pg_cron (scheduler confiável) nunca chamava billing. Resultado: o retry
 * praticamente não rodava e o backlog de unbilled encalhava (192 records órfãos
 * + ~$16 não cobrados em 2026-05-21).
 *
 * AGORA: este endpoint isolado é chamado pelo pg_cron a cada 5min (migration
 * 00086), com guard WHERE EXISTS (só dispara se há unbilled) — então não há
 * auto-DDoS de calls vazias. chargeUnbilledRecords roda sozinho com os 60s
 * inteiros, faz o reaper de claims órfãos e cobra um batch bounded por run.
 *
 * Idempotência: o claim_token impede 2 runs pegarem o mesmo record; o eventId
 * (=usage_record.id) impede o GHL cobrar 2x. Logo overlap de runs é seguro.
 */

import { NextRequest, NextResponse } from "next/server";
import { chargeUnbilledRecords } from "@/lib/billing/charge";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function GET(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const startTs = Date.now();
  try {
    const result = await chargeUnbilledRecords();
    const dur = Date.now() - startTs;
    if (result.charged > 0 || result.failed > 0 || result.reaped > 0) {
      console.log(
        `[cron:billing-retry] charged=${result.charged} failed=${result.failed} reaped=${result.reaped} in ${dur}ms`,
      );
    }
    return NextResponse.json({ success: true, ...result, duration_ms: dur });
  } catch (error) {
    const msg = error instanceof Error ? error.message : "Erro desconhecido";
    console.error("[cron:billing-retry] FATAL:", msg);
    return NextResponse.json(
      { success: false, error: msg, duration_ms: Date.now() - startTs },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest) {
  return GET(request);
}
