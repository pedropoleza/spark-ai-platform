import { NextRequest, NextResponse } from "next/server";
import { processMessageQueue } from "@/lib/queue/queue-processor";
import { processScheduledFollowUps } from "@/lib/queue/follow-up-scheduler";
import { isAuthorizedCron } from "@/lib/utils/cron-auth";
import { withDeadline } from "@/lib/utils/deadline";
import { reportError } from "@/lib/admin-signals/report-error";

export const maxDuration = 60;

// H92 (2026-09-18): a fila de MENSAGENS tem prioridade absoluta sobre o
// follow-up. Antes os dois rodavam em `Promise.all` sob o mesmo teto de 60s —
// quando o loop de follow-up estourava o tempo (sinal real: "24 órfãs em
// 'processing' encerradas pelo reaper — lambda morreu no meio do loop de
// follow-up"), a lambda morria inteira e levava junto as mensagens que a fila
// já tinha marcado como 'processing'. Elas só voltavam pelo reaper, 5 min
// depois. O lead esperando é o que não pode pagar por isso.
//
// Agora: fila PRIMEIRO e sozinha; follow-up depois, com o tempo que sobrar e
// com teto próprio. `allSettled` porque a falha de um não pode derrubar o outro.
const TETO_TOTAL_MS = 50_000; // margem de 10s antes do hard-limit da Vercel
const TETO_FILA_MS = 35_000;
const TETO_FOLLOWUP_MIN_MS = 5_000;

// H94 (2026-09-21): o `withDeadline` abaixo só CORRE contra o relógio — ele
// rejeita a promise mas não interrompe o laço lá dentro, e as mensagens já
// claimadas continuam presas em 'processing' até o reaper. Por isso o teto vai
// TAMBÉM por dentro: o processador precisa saber quanto tempo tem pra decidir
// devolver o resto da fila em vez de morrer com ele na mão. Uns segundos a
// menos que o teto de fora, pra devolução caber antes do corte.
const ORCAMENTO_INTERNO_FILA_MS = TETO_FILA_MS - 5_000;

export async function POST(request: NextRequest) {
  if (!isAuthorizedCron(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const inicio = Date.now();
  let queueResult: { processed: number; errors: number; devolvidas?: number } = { processed: 0, errors: 0 };
  let queueTimeout = false;
  let followUpResult: unknown = { skipped: "sem tempo" };
  let followUpTimeout = false;

  try {
    try {
      queueResult = await withDeadline(
        processMessageQueue({ orcamentoMs: ORCAMENTO_INTERNO_FILA_MS }),
        TETO_FILA_MS,
        "fila",
      );
    } catch (e) {
      queueTimeout = true;
      console.error("[process-batch] fila estourou o teto:", e instanceof Error ? e.message : e);
      reportError({
        title: "Fila de mensagens estourou o teto de tempo",
        feature: "cron-process-batch",
        severity: "high",
        error: e,
      });
    }

    const restante = TETO_TOTAL_MS - (Date.now() - inicio);
    if (restante > TETO_FOLLOWUP_MIN_MS) {
      try {
        followUpResult = await withDeadline(processScheduledFollowUps(), restante, "follow-up");
      } catch (e) {
        followUpTimeout = true;
        console.warn("[process-batch] follow-up estourou o teto (fila já rodou):", e instanceof Error ? e.message : e);
      }
    }

    return NextResponse.json({
      success: true,
      queue: queueResult,
      queue_timeout: queueTimeout,
      followups: followUpResult,
      followup_timeout: followUpTimeout,
      duration_ms: Date.now() - inicio,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error("Erro no process-batch:", error);
    reportError({ title: "Cron process-batch: crash (pipeline lead-facing parado)", feature: "cron-process-batch", severity: "critical", error });
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : "Erro desconhecido" },
      { status: 500 }
    );
  }
}
