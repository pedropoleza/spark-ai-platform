/**
 * Runner de bulk_message_recipients.
 *
 * Roda dentro do cron principal (/api/cron/sparkbot-proactive) a cada 30s.
 * Pra cada tick:
 *   1. Atomic claim de até MAX_PER_TICK recipients pending com
 *      scheduled_at <= now() (status='pending' → 'sending').
 *   2. Pra cada claim:
 *      a. Se job.status != 'running' (pause/cancel) → marca skipped, segue.
 *      b. Se respect_quiet_hours=true e estamos dentro quiet_hours do agent
 *         → reverte pra pending (será reprocessado próximo tick).
 *      c. Gera variation via Haiku (se variation_mode != 'none').
 *      d. Envia via GHL conversations/messages (canal por job).
 *      e. Marca status='sent' ou 'failed' + grava actual_message + sent_at.
 *   3. Atualiza counters do job. Se todos recipients !pending, marca
 *      job.status='completed'.
 *
 * Cap defensivo: MAX_PER_TICK=5. Pra 100 contatos a 90s de drip, 30s tick
 * geralmente pega 0-1 por tick — limite só afeta backlog (ex: voltar de
 * quiet_hours com 8h de fila).
 *
 * F60 (Pedro 2026-06-10): MAX_PER_TICK é throttle INTRA-tick, NÃO o teto diário.
 * O teto diário (daily_cap) é enforçado UPSTREAM, no populate-time: o
 * campaign-populator / recurring-runner já nascem com scheduled_at espalhado de
 * modo que nenhum dia-ET ultrapasse o cap. Como o claim aqui filtra
 * `scheduled_at <= now`, recipients de dias futuros não são pegos antes da hora —
 * o runner respeita o teto sem precisar de contador diário próprio (ver
 * distributeScheduledAtsByDailyCap em tools/bulk-messages.ts).
 *
 * Silence gate: NÃO se aplica aqui — msg vai pro CONTATO, não pro rep.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { generateVariation } from "./bulk-message-variator";
// F32 (Pedro 2026-05-28): trocado isInQuietHours → isInBlockedHours pra
// respeitar TAMBÉM working_hours (semantica "respeitar horário de
// atendimento" da UI). Antes outreach às 8h sábado disparava (fora de
// quiet_hours mas fora de working_hours seg-sex 9-18).
import { isInBlockedHours as sharedIsInBlockedHours } from "./quiet-hours";

const MAX_PER_TICK = 5;

// H37 (Pedro 2026-06-10): janela pra considerar uma row 'sending' como órfã
// (lambda morreu entre o claim e o UPDATE final). 3min é bem acima do
// maxDuration de 60s do lambda — nenhum tick vivo ainda segura a row, então o
// revert pra pending é seguro. Ver reclaimOrphanedSending().
const RECLAIM_STUCK_AFTER_MS = 3 * 60 * 1000;

export interface BulkRunResult {
  fired: number;
  failed: number;
  skipped: number;
  jobs_completed: number;
}

interface BulkRecipientRow {
  id: string;
  job_id: string;
  contact_id: string;
  contact_name: string | null;
  contact_phone: string | null;
  scheduled_at: string;
  status: string;
  // Etapa 4.4 (Pedro 2026-05-28): quando setado, o runner usa esse template
  // em vez do job.message_template. Sequence-runner seta isso pra steps 2+.
  message_template_override?: string | null;
}

interface BulkJobRow {
  id: string;
  rep_id: string;
  location_id: string;
  agent_id: string | null;
  message_template: string;
  variation_mode: "none" | "light" | "medium";
  delivery_channel: "whatsapp_web_sms" | "whatsapp_api";
  respect_quiet_hours: boolean;
  status: string;
  total_contacts: number;
  sent_count: number;
  failed_count: number;
  skipped_count: number;
  // NB-11 (2026-06-10): usado no tiebreaker client-side pós-claim (ordem de
  // PROCESSAMENTO dentro do tick). A seleção autoritativa é no DB (RPC).
  priority: number | null;
}

export async function fireBulkRecipients(): Promise<BulkRunResult> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  // F16 (Pedro 2026-05-28): timer pro last_duration_ms.
  const tickStartedAt = Date.now();

  // F1.5 Pedro 2026-05-16 (caso Gustavo): heartbeat upfront — registra que
  // runner está vivo MESMO QUE não ache recipients pendentes. Antes, sem
  // heartbeat, podia-se ter 21h sem tick sem ninguém saber.
  // Fix H7 (review 2026-05-16): tracking explícito de heartbeat success
  // (vs. falha silenciosa). Se DB down durante tick, recordTickError no
  // catch externo, mas heartbeat upfront e success final independentes —
  // health-check vai detectar via last_tick_at antigo.
  let tickError: string | null = null;
  let heartbeatOk = false;
  try {
    const { error: hbErr } = await supabase
      .from("bulk_runner_health")
      .update({
        last_tick_at: nowIso,
        updated_at: nowIso,
        // Counters preenchidos ao fim da função abaixo
      })
      .eq("id", 1);
    if (hbErr) {
      console.warn("[bulk-runner] heartbeat update retornou erro:", hbErr.message);
    } else {
      heartbeatOk = true;
    }
  } catch (err) {
    console.warn("[bulk-runner] heartbeat update falhou:", err);
  }
  if (!heartbeatOk) {
    // Heartbeat falhou — tick prossegue mas pula success record (evita
    // overwriter erro mais grave que vier). Health-check via last_tick_at
    // vai detectar stale.
    console.warn("[bulk-runner] continuing tick sem heartbeat ok — health-check vai pegar como stale");
  }

  // H37 (Pedro 2026-06-10): ANTES de claimar, recupera recipients órfãos
  // presos em 'sending' (lambda morreu entre o claim e o UPDATE final). Volta
  // pra pending pra serem re-claimados — neste mesmo tick, inclusive. Sem isso
  // o job ficava 'running' pra sempre (refreshJobCounters exige sending===0) e
  // o rep nunca recebia a notificação de conclusão. Ver doc da função pro
  // tradeoff de idempotência. Não-fatal (a função engole o próprio erro).
  await reclaimOrphanedSending({ supabase, nowMs: tickStartedAt });

  // Atomic claim: pega até MAX_PER_TICK pending vencidos, ORDENADOS POR PRIORITY
  // NO DB, e marca como 'sending' num passo só.
  //
  // F4.1 Pedro 2026-05-16: priority queue (jobs urgentes furam fila).
  // NB-11 (review 2026-06-10): a ordenação por priority agora é no DB (RPC
  // claim_bulk_recipients, migration 00105). Antes era em 2 passos — SELECT
  // ORDER BY scheduled_at LIMIT 20 (buffer) + sort client-side por priority —, e
  // sob backlog (>=20 vencidos de baixa prioridade com timestamps antigos) o
  // buffer de 20 era todo consumido por eles e o job de alta prioridade nunca
  // entrava na janela: o "fura fila" falhava justo quando importa. PostgREST não
  // ordena top-level por coluna de embed M2O (verificado em prod), então a
  // ordenação tem que ser SQL. Ver claimBulkRecipients (RPC + fallback legado).
  let claimed: BulkRecipientRow[] = [];
  try {
    claimed = await claimBulkRecipients(supabase, MAX_PER_TICK, nowIso);
  } catch (err) {
    tickError = err instanceof Error ? err.message : String(err);
    await recordTickError(tickError);
    throw err;
  }

  if (claimed.length === 0) {
    // Tick OK sem trabalho — reseta consecutive_errors
    await resetConsecutiveErrors();
    return { fired: 0, failed: 0, skipped: 0, jobs_completed: 0 };
  }

  // Hidrata jobs (1 query batch)
  const jobIds = Array.from(new Set(claimed.map((r) => r.job_id)));
  const { data: jobsData } = await supabase
    .from("bulk_message_jobs")
    .select("*")
    .in("id", jobIds);
  const jobsById = new Map<string, BulkJobRow>(
    (jobsData || []).map((j) => [j.id as string, j as BulkJobRow]),
  );

  // NB-11 (2026-06-10): tiebreaker/fallback — re-ordena as rows reivindicadas
  // por priority no app. A seleção autoritativa (quais recipients entram) já foi
  // no DB (RPC ORDER BY priority DESC, scheduled_at ASC); aqui só garantimos
  // ordem de PROCESSAMENTO determinística dentro do tick, já que UPDATE..
  // RETURNING não garante ordem das rows devolvidas.
  claimed.sort((a, b) => {
    const pa = jobsById.get(a.job_id)?.priority ?? 50;
    const pb = jobsById.get(b.job_id)?.priority ?? 50;
    if (pa !== pb) return pb - pa;
    return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime();
  });

  let fired = 0;
  let failed = 0;
  let skipped = 0;
  const touchedJobIds = new Set<string>();

  // Etapa 4.8: pre-check opt-outs em batch antes do loop. Reduz N queries
  // pra 1 LEFT-JOIN-like via filterOutOptOutContacts (1 query per location).
  // Agrupa por location_id pra minimizar round-trips.
  const optedOutByLocation = new Map<string, Set<string>>();
  try {
    const { filterOutOptOutContacts } = await import("./optout-detector");
    const byLoc = new Map<string, string[]>(); // location_id → contact_ids
    for (const r of claimed) {
      const job = jobsById.get(r.job_id);
      if (!job) continue;
      const arr = byLoc.get(job.location_id) || [];
      arr.push(r.contact_id);
      byLoc.set(job.location_id, arr);
    }
    for (const [loc, ids] of byLoc.entries()) {
      const optedSet = await filterOutOptOutContacts(loc, ids);
      optedOutByLocation.set(loc, optedSet);
    }
  } catch (err) {
    console.warn(
      "[bulk-runner] opt-out pre-check falhou (não-fatal, segue sem skip):",
      err instanceof Error ? err.message.slice(0, 150) : err,
    );
  }

  for (const recipient of claimed) {
    const job = jobsById.get(recipient.job_id);
    if (!job) {
      // Job sumiu (cancelado e deletado em algum lugar?) — marca skipped.
      await markRecipientSkipped(recipient.id, "job_not_found");
      skipped++;
      continue;
    }
    touchedJobIds.add(job.id);

    // Etapa 4.8: skip opt-outs (set pre-computado acima).
    const optedSet = optedOutByLocation.get(job.location_id);
    if (optedSet?.has(recipient.contact_id)) {
      await markRecipientSkipped(recipient.id, "contact_opted_out");
      skipped++;
      continue;
    }

    // Fix C4 (review 2026-05-16): priority queue claim (F4.1) já filtra
    // paused/cancelled/completed/failed no pre-select via inner JOIN com
    // bulk_message_jobs.status='running'. Esses branches só batem em RACE
    // raríssima (job pause entre fetch candidates e claim update). Não
    // revertemos mais paused recipients pra pending pra evitar loop
    // pending→sending→pending que rodava todo tick até resume.
    // Quando rep pausa, novos ticks simplesmente não claim. Quando resume,
    // recipients pending originais voltam a ser claim normalmente.
    if (job.status !== "running") {
      await markRecipientSkipped(recipient.id, `job_status_${job.status}_race`);
      skipped++;
      continue;
    }

    // F32 (Pedro 2026-05-28): respeita quiet_hours + working_hours.
    // O flag `respect_quiet_hours` no job é setado pelo outreach-runner
    // a partir de `oc.respect_working_hours` (nome legado no schema do
    // outreach_config). Semanticamente o usuário pede "respeitar
    // horários" — qualquer um dos 2 configs do agente vale.
    if (job.respect_quiet_hours) {
      const blocked = await isInBlockedHours(job.agent_id);
      if (blocked.blocked) {
        // Volta pra pending, próximo tick re-tenta. Loop até sair do bloqueio.
        await supabase
          .from("bulk_message_recipients")
          .update({ status: "pending" })
          .eq("id", recipient.id);
        skipped++;
        continue;
      }
    }

    // Etapa 4.4 (Pedro 2026-05-28): se recipient tem message_template_override
    // (usado por sequence-runner pra steps 2+), usa ele. Senão, usa o template
    // do job (caminho original). variation_mode ainda se aplica em ambos.
    const effectiveTemplate = recipient.message_template_override?.trim()
      ? recipient.message_template_override
      : job.message_template;

    let messageToSend: string;
    try {
      messageToSend = await generateVariation(
        effectiveTemplate,
        job.variation_mode,
        recipient.contact_name,
      );
    } catch (err) {
      console.warn(
        `[bulk-runner] variation falhou pra recipient ${recipient.id}, usando template direto:`,
        err instanceof Error ? err.message : err,
      );
      messageToSend = effectiveTemplate;
    }

    // Envia via GHL
    const result = await sendToContact(job, recipient, messageToSend);
    if (result.ok) {
      await supabase
        .from("bulk_message_recipients")
        .update({
          status: "sent",
          actual_message: messageToSend,
          sent_at: new Date().toISOString(),
        })
        .eq("id", recipient.id);
      // F3.2 Pedro 2026-05-16: registra cooldown pra preview futuro avisar
      // duplicação. Async/silent — não bloqueia se falhar.
      try {
        const { recordContactBulkSent } = await import("@/lib/account-assistant/tools/bulk-messages");
        await recordContactBulkSent(recipient.contact_id, job.location_id, job.id);
      } catch {
        // silent — cooldown é warn-only metadata
      }
      fired++;
    } else {
      await supabase
        .from("bulk_message_recipients")
        .update({
          status: "failed",
          actual_message: messageToSend,
          error_message: result.error || "envio falhou",
        })
        .eq("id", recipient.id);
      failed++;
    }
  }

  // Atualiza counters dos jobs tocados + marca completed se acabou
  let jobsCompleted = 0;
  for (const jobId of touchedJobIds) {
    const completed = await refreshJobCounters(jobId);
    if (completed) jobsCompleted++;
  }

  // F1.5 Pedro 2026-05-16: registra resultado completo no heartbeat.
  // Útil pro painel admin ver throughput em tempo real.
  // F16 (Pedro 2026-05-28): inclui last_duration_ms.
  await recordTickSuccess(
    {
      fired,
      failed,
      skipped,
      jobs_completed: jobsCompleted,
    },
    Date.now() - tickStartedAt,
  );

  return { fired, failed, skipped, jobs_completed: jobsCompleted };
}

// NB-11 (2026-06-10): buffer do caminho de FALLBACK (RPC ainda não aplicada).
// Grande o suficiente pra a ordenação client-side por priority furar fila mesmo
// sob backlog realista — diferente do antigo MAX_PER_TICK*4 (=20), que era
// justamente a causa do bug. Rows são leves (poucas colunas) e esse caminho só
// roda no gap de deploy, então o custo é desprezível.
const FALLBACK_CANDIDATE_BUFFER = 200;

/**
 * NB-11 (2026-06-10): candidato normalizado pro `selectClaimBatch`. Espelha as
 * colunas que a RPC usa no WHERE/ORDER BY (status do recipient + status/priority
 * do job + scheduled_at).
 */
export interface ClaimCandidate {
  id: string;
  scheduled_at: string;
  job_priority: number;
  job_status: string;
  recipient_status: string;
}

/**
 * NB-11 (2026-06-10): política de seleção do claim — PURA e exportada pra teste.
 * Espelha o `ORDER BY j.priority DESC, r.scheduled_at ASC LIMIT n` da RPC
 * `claim_bulk_recipients` (migration 00105). É o que faz priority "furar fila":
 * sob backlog, um job de prioridade alta com scheduled_at mais novo ganha de 20+
 * recipients antigos de prioridade baixa.
 *
 * Em runtime roda só no caminho de FALLBACK (RPC ausente). A ordenação
 * AUTORITATIVA em prod é a SQL da RPC — esta função é o guard de paridade da
 * política (mesmo papel do `isOrphanedSending` pro reclaim).
 */
export function selectClaimBatch(
  candidates: ClaimCandidate[],
  nowMs: number,
  limit: number,
): ClaimCandidate[] {
  return candidates
    .filter(
      (c) =>
        c.recipient_status === "pending" &&
        c.job_status === "running" &&
        new Date(c.scheduled_at).getTime() <= nowMs,
    )
    .sort((a, b) => {
      if (a.job_priority !== b.job_priority) return b.job_priority - a.job_priority; // priority DESC
      return new Date(a.scheduled_at).getTime() - new Date(b.scheduled_at).getTime(); // scheduled_at ASC
    })
    .slice(0, Math.max(limit, 0));
}

/**
 * NB-11 (2026-06-10): erro do supabase-js indica "função RPC não existe"? Usado
 * pra detectar o gap de deploy (código novo + migration 00105 ainda não
 * aplicada via MCP) e cair no fallback legado em vez de quebrar o tick.
 *   - PGRST202: PostgREST não achou a função no schema cache.
 *   - 42883: undefined_function no Postgres.
 * Mensagem como rede de segurança final.
 */
function isMissingFunctionError(
  err: { code?: string | null; message?: string | null } | null,
): boolean {
  if (!err) return false;
  if (err.code === "PGRST202" || err.code === "42883") return true;
  const m = (err.message ?? "").toLowerCase();
  return (
    m.includes("could not find the function") ||
    (m.includes("function") && m.includes("does not exist"))
  );
}

/**
 * NB-11 (2026-06-10): claim atômico priority-first de até `limit` recipients.
 *
 * Primário (pós-migration 00105): RPC `claim_bulk_recipients` — ordena por
 * priority NO DB antes do LIMIT + FOR UPDATE SKIP LOCKED, carimba claim_token/
 * claimed_at (H37) e devolve as rows reivindicadas (status já = 'sending').
 *
 * Fallback (gap de deploy / rollback): se a RPC ainda não existe, usa o caminho
 * legado (SELECT buffer + `selectClaimBatch` + UPDATE com double-check de
 * status). O buffer é grande (FALLBACK_CANDIDATE_BUFFER) pra também furar fila —
 * nunca pior que o comportamento pré-NB-11.
 *
 * Exportada pra teste (`scripts/test-bulk-priority-claim.ts`). Erros REAIS
 * (não "função ausente") propagam pro caller (recordTickError + throw).
 */
export async function claimBulkRecipients(
  supabase: ReturnType<typeof createAdminClient>,
  limit: number,
  nowIso: string,
): Promise<BulkRecipientRow[]> {
  // H37: 1 claim_token por tick (todas as rows do claim compartilham). claimed_at
  // é o que reclaimOrphanedSending usa pra medir idade.
  const claimToken = crypto.randomUUID();

  const { data: rpcData, error: rpcErr } = await supabase.rpc("claim_bulk_recipients", {
    p_limit: limit,
    p_claim_token: claimToken,
  });
  if (!rpcErr) {
    return (rpcData || []) as BulkRecipientRow[];
  }
  // Erro real → propaga (o caller registra tick error e re-tenta no próximo tick).
  if (!isMissingFunctionError(rpcErr)) {
    throw new Error(rpcErr.message || "claim_bulk_recipients RPC falhou");
  }
  console.warn(
    "[bulk-runner] RPC claim_bulk_recipients ausente (aplicar migration 00105) — fallback legado priority-first",
  );
  return legacyClaimWithClientSort(supabase, limit, claimToken, nowIso);
}

/**
 * NB-11 (2026-06-10): caminho legado do claim (pré-RPC). SELECT buffer ordenado
 * por scheduled_at + `selectClaimBatch` (priority DESC) client-side + UPDATE
 * atômico com double-check `.eq('status','pending')`. Só roda no fallback.
 */
async function legacyClaimWithClientSort(
  supabase: ReturnType<typeof createAdminClient>,
  limit: number,
  claimToken: string,
  nowIso: string,
): Promise<BulkRecipientRow[]> {
  const { data: candidates } = await supabase
    .from("bulk_message_recipients")
    .select("id, scheduled_at, status, bulk_message_jobs!inner(priority, status)")
    .eq("status", "pending")
    .lte("scheduled_at", nowIso)
    .order("scheduled_at", { ascending: true })
    .limit(FALLBACK_CANDIDATE_BUFFER);
  if (!candidates || candidates.length === 0) return [];

  type EmbeddedJob = { priority: number | null; status: string };
  type Raw = {
    id: string;
    scheduled_at: string;
    status: string;
    bulk_message_jobs: EmbeddedJob | EmbeddedJob[];
  };
  const normalized: ClaimCandidate[] = (candidates as Raw[]).map((r) => {
    const j = Array.isArray(r.bulk_message_jobs) ? r.bulk_message_jobs[0] : r.bulk_message_jobs;
    return {
      id: r.id,
      scheduled_at: r.scheduled_at,
      job_priority: j?.priority ?? 50,
      job_status: j?.status ?? "",
      recipient_status: r.status,
    };
  });
  const selected = selectClaimBatch(normalized, Date.parse(nowIso), limit);
  if (selected.length === 0) return [];

  const ids = selected.map((c) => c.id);
  const { data: claimedRaw } = await supabase
    .from("bulk_message_recipients")
    .update({ status: "sending", claim_token: claimToken, claimed_at: nowIso })
    .in("id", ids)
    .eq("status", "pending") // double-check pra race
    .select("*");
  return (claimedRaw || []) as BulkRecipientRow[];
}

/**
 * H37 (Pedro 2026-06-10): decide se uma row 'sending' é órfã (lambda morreu)
 * com base na IDADE do claim. Pura + exportada pra teste. cutoffMs deve ser
 * `now - RECLAIM_STUCK_AFTER_MS`.
 */
export function isOrphanedSending(
  row: { claimed_at: string | null; scheduled_at: string },
  cutoffMs: number,
): boolean {
  // Caminho normal (pós-migration 00102): claimed_at carimbado no claim. Órfã
  // se foi reivindicada antes do cutoff.
  if (row.claimed_at) return new Date(row.claimed_at).getTime() < cutoffMs;
  // claimed_at NULL: claim por código pré-00102 OU por lambda velho durante um
  // deploy rolling. Usa scheduled_at como proxy de idade — o claim só pega
  // `scheduled_at <= now`, então uma 'sending' com scheduled_at vencido há mais
  // que a janela quase certamente é órfã (não um claim legítimo recente).
  return new Date(row.scheduled_at).getTime() < cutoffMs;
}

/**
 * H37 (Pedro 2026-06-10): reverte pra 'pending' recipients órfãos presos em
 * 'sending'. Roda no começo de cada tick, ANTES do claim.
 *
 * Por que existe: se o lambda do Vercel morre (timeout maxDuration=60s, OOM,
 * deploy no meio) ENTRE o claim atômico (pending→sending) e o UPDATE final
 * (→sent/failed), a row fica presa em 'sending' pra sempre. Como
 * refreshJobCounters() exige `sending===0` pra completar o job, o job fica
 * 'running' eternamente e o rep nunca recebe a notificação de conclusão. (O
 * reaper H12 resolve o mesmo no message_queue — mas lá a tabela tem updated_at;
 * aqui dependemos do claimed_at da migration 00102.)
 *
 * Idempotência (tradeoff): se o GHL send REALMENTE completou mas o lambda
 * morreu antes do UPDATE, reverter causa 1 reenvio. Aceito — a janela de
 * RECLAIM_STUCK_AFTER_MS (3min, bem acima do maxDuration de 60s) torna isso
 * raríssimo, e 1 msg duplicada << job preso pra sempre. Diferente do H12, NÃO
 * temos um UNIQUE (tipo ghl_message_id) como seguro final, então a idade é a
 * única proteção — por isso só revertemos rows velhas o suficiente.
 *
 * 'sending' é normalmente 0-5 rows (claim→terminal no mesmo tick); órfãs só
 * acumulam em morte de lambda. Por isso fetch + filtro em JS (idade é lógica
 * pura/testável) em vez de OR no PostgREST. Retorna quantos foram revertidos.
 * Nunca lança (falha = warn + 0).
 */
export async function reclaimOrphanedSending(
  deps: { supabase?: ReturnType<typeof createAdminClient>; nowMs?: number } = {},
): Promise<number> {
  const supabase = deps.supabase ?? createAdminClient();
  const nowMs = deps.nowMs ?? Date.now();
  const cutoffMs = nowMs - RECLAIM_STUCK_AFTER_MS;
  try {
    const { data: sendingRows } = await supabase
      .from("bulk_message_recipients")
      .select("id, claimed_at, scheduled_at")
      .eq("status", "sending");
    const orphanIds = (
      (sendingRows || []) as Array<{
        id: string;
        claimed_at: string | null;
        scheduled_at: string;
      }>
    )
      .filter((r) => isOrphanedSending(r, cutoffMs))
      .map((r) => r.id);
    if (orphanIds.length === 0) return 0;

    const { data: reverted } = await supabase
      .from("bulk_message_recipients")
      .update({ status: "pending", claim_token: null, claimed_at: null })
      .in("id", orphanIds)
      .eq("status", "sending") // double-check anti-race
      .select("id");
    const n = reverted?.length ?? 0;
    if (n > 0) {
      console.warn(
        `[bulk-runner] reclaimed ${n} recipient(s) órfão(s) em 'sending' (>${Math.round(
          RECLAIM_STUCK_AFTER_MS / 60000,
        )}min) → pending`,
      );
    }
    return n;
  } catch (err) {
    console.warn(
      "[bulk-runner] reclaimOrphanedSending falhou (não-fatal):",
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/**
 * F1.5: registra tick bem-sucedido + reseta error streak.
 * F16 (Pedro 2026-05-28): durationMs opcional pra last_duration_ms.
 */
async function recordTickSuccess(result: BulkRunResult, durationMs?: number): Promise<void> {
  const supabase = createAdminClient();
  try {
    const update: Record<string, unknown> = {
      last_tick_at: new Date().toISOString(),
      last_jobs_processed: result.jobs_completed,
      last_fired: result.fired,
      last_failed: result.failed,
      last_skipped: result.skipped,
      consecutive_errors: 0,
      updated_at: new Date().toISOString(),
    };
    if (typeof durationMs === "number" && durationMs >= 0) {
      update.last_duration_ms = Math.round(durationMs);
    }
    await supabase
      .from("bulk_runner_health")
      .update(update)
      .eq("id", 1);
  } catch (err) {
    console.warn("[bulk-runner] recordTickSuccess falhou:", err);
  }
}

async function resetConsecutiveErrors(): Promise<void> {
  const supabase = createAdminClient();
  try {
    await supabase
      .from("bulk_runner_health")
      .update({ consecutive_errors: 0, updated_at: new Date().toISOString() })
      .eq("id", 1);
  } catch {
    // não fatal
  }
}

/**
 * F1.5: registra erro de tick + incrementa streak.
 * Quando consecutive_errors >= 3, cria admin_signal pra avisar.
 */
async function recordTickError(errorMsg: string): Promise<void> {
  const supabase = createAdminClient();
  try {
    const { data: current } = await supabase
      .from("bulk_runner_health")
      .select("consecutive_errors")
      .eq("id", 1)
      .maybeSingle();
    const streak = (current?.consecutive_errors ?? 0) + 1;
    await supabase
      .from("bulk_runner_health")
      .update({
        last_error: errorMsg.slice(0, 500),
        last_error_at: new Date().toISOString(),
        consecutive_errors: streak,
        updated_at: new Date().toISOString(),
      })
      .eq("id", 1);

    // Cria signal admin a partir de 3 erros consecutivos (evita spam transient)
    if (streak >= 3) {
      const { recordSignalAsync } = await import("@/lib/admin-signals/recorder");
      recordSignalAsync({
        type: "error",
        title: `bulk-runner: ${streak} erros consecutivos`,
        description: errorMsg.slice(0, 500),
        severity: "high",
        source: "bot_auto",
        metadata: { component: "bulk-message-runner", consecutive_errors: streak },
      });
    }
  } catch (err) {
    console.warn("[bulk-runner] recordTickError falhou:", err);
  }
}

async function markRecipientSkipped(
  recipientId: string,
  reason: string,
): Promise<void> {
  const supabase = createAdminClient();
  await supabase
    .from("bulk_message_recipients")
    .update({ status: "skipped", error_message: reason })
    .eq("id", recipientId);
}

/**
 * Wrapper local — delega pra lib compartilhada `quiet-hours.ts` (Pedro F14
 * 2026-05-28). Antes a lógica vivia duplicada inline; agora bulk-runner e
 * recurring-runner usam o mesmo helper.
 *
 * F32 (Pedro 2026-05-28): nome mantido mas agora respeita quiet_hours +
 * working_hours combinados via isInBlockedHours.
 */
async function isInBlockedHours(
  agentId: string | null,
): Promise<{ blocked: boolean; reason?: "quiet_hours" | "working_hours" }> {
  return sharedIsInBlockedHours(agentId);
}

/**
 * Envia msg pro contato via GHL conversations/messages.
 * Type mapping:
 *   - 'whatsapp_web_sms' → type: "SMS" (Stevo/Evolution roteia pro WhatsApp)
 *   - 'whatsapp_api' → type: "WhatsApp"
 */
async function sendToContact(
  job: BulkJobRow,
  recipient: BulkRecipientRow,
  message: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const supabase = createAdminClient();
    const { data: location } = await supabase
      .from("locations")
      .select("company_id")
      .eq("location_id", job.location_id)
      .maybeSingle();
    if (!location) {
      return { ok: false, error: "location não sincronizada" };
    }
    const ghlClient = new GHLClient(location.company_id, job.location_id);
    const ghlType = job.delivery_channel === "whatsapp_api" ? "WhatsApp" : "SMS";

    // Fix Pedro 2026-05-06: PROTOCOLO PADRÃO — antes de QUALQUER send,
    // garante que assignedTo é o rep que criou o job. Em contas com
    // múltiplas instâncias WhatsApp ativas, GHL roteia outbound baseado
    // no assignedTo do contato. Sem isso, mensagem em massa pode sair
    // pelo número de outro rep da agency, confundindo recipientes.
    try {
      const { data: rep } = await supabase
        .from("rep_identities")
        .select("ghl_users")
        .eq("id", job.rep_id)
        .maybeSingle();
      const repGhlUserId = (
        (rep?.ghl_users as Array<{ ghl_user_id: string; location_id: string }>) || []
      ).find((u) => u.location_id === job.location_id)?.ghl_user_id;
      if (repGhlUserId) {
        const { ensureContactAssignedTo } = await import("@/lib/ghl/operations");
        await ensureContactAssignedTo(ghlClient, recipient.contact_id, repGhlUserId);
      }
    } catch (assignErr) {
      // Não fatal — segue. (Pra recipient com 100s/1000s de msgs, esse
      // hit no GHL é aceitável: 1 extra GET + ocasional PUT por contato.)
      console.warn(
        `[bulk-runner] assignedTo update falhou pra contact=${recipient.contact_id}:`,
        assignErr instanceof Error ? assignErr.message.slice(0, 100) : assignErr,
      );
    }

    // Fix HIGH-H6 (deep audit 2026-05-06): fallback automático WhatsApp API
    // → SMS quando sub-account não tem subscription Meta. Antes, jobs em
    // bulk com delivery_channel='whatsapp_api' falhavam recipient-a-recipient
    // sem fallback. Agora cobertura paralela aos paths singular (send +
    // scheduled outbound_to_contact).
    const trySend = async (ch: string) =>
      ghlClient.post("/conversations/messages", {
        type: ch,
        contactId: recipient.contact_id,
        message,
      });
    try {
      await trySend(ghlType);
      return { ok: true };
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      if (
        ghlType === "WhatsApp" &&
        /no active whatsapp subscription|whatsapp.*not.*active|whatsapp.*disabled/i.test(m)
      ) {
        console.warn(
          `[bulk-runner] WhatsApp API inativo pro job ${job.id} — fallback SMS (Stevo)`,
        );
        try {
          await trySend("SMS");
          return { ok: true };
        } catch (fbErr) {
          throw fbErr;
        }
      }
      throw err;
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: errMsg.slice(0, 500) };
  }
}

/**
 * Recalcula sent_count / failed_count / skipped_count do job.
 * Se todos os recipients estão completados (sent + failed + skipped + cancelled),
 * marca job.status='completed' e completed_at=now.
 *
 * Returns true se job foi marcado completed nesta call.
 *
 * H37 (Pedro 2026-06-10): aceita deps injetáveis (supabase + notify) pra teste
 * hermético do reclaim→completed. Em prod os call-sites não passam nada — usa
 * createAdminClient() + o notifier real (comportamento idêntico ao anterior).
 */
export async function refreshJobCounters(
  jobId: string,
  deps: {
    supabase?: ReturnType<typeof createAdminClient>;
    notify?: (jobId: string) => Promise<void>;
  } = {},
): Promise<boolean> {
  const supabase = deps.supabase ?? createAdminClient();

  // Fix Track 7 M3 (review 2026-05-05): antes fazia 6 queries (head count
  // por status). Agora 1 query select all rows + agregação JS. Em scale,
  // 50 jobs × 6 queries = 300 queries/tick → 50 queries.
  const { data: rows } = await supabase
    .from("bulk_message_recipients")
    .select("status")
    .eq("job_id", jobId);

  const counts: Record<string, number> = {
    pending: 0, sending: 0, sent: 0, failed: 0, skipped: 0, cancelled: 0,
  };
  for (const row of (rows || []) as Array<{ status: string }>) {
    if (counts[row.status] !== undefined) counts[row.status]++;
  }
  const total =
    counts.pending + counts.sending + counts.sent +
    counts.failed + counts.skipped + counts.cancelled;
  const allDone = counts.pending === 0 && counts.sending === 0;

  const update: Record<string, unknown> = {
    sent_count: counts.sent,
    failed_count: counts.failed,
    skipped_count: counts.skipped,
    total_contacts: total,
    updated_at: new Date().toISOString(),
  };
  let completed = false;
  if (allDone) {
    update.status = "completed";
    update.completed_at = new Date().toISOString();
    completed = true;
  }
  // Atomic: só promove pra completed se ainda estava running. Retorna rows
  // afetadas — se 0, alguém já fez transition antes (race entre 2 ticks).
  const { data: affected } = await supabase
    .from("bulk_message_jobs")
    .update(update)
    .eq("id", jobId)
    .eq("status", "running")
    .select("id");

  // Pedro 2026-05-18: dispara notif pro rep quando JUST transitioned to
  // completed (atomic check garante 1 só notif). Async/silent — não bloqueia
  // tick se notifier falhar.
  if (completed && affected && affected.length > 0) {
    const notify =
      deps.notify ??
      (async (id: string) => {
        const { notifyRepJobCompleted } = await import("./bulk-completion-notifier");
        await notifyRepJobCompleted(id);
      });
    try {
      await notify(jobId);
    } catch (err) {
      console.warn(
        `[bulk-runner] completion notify falhou job=${jobId}:`,
        err instanceof Error ? err.message.slice(0, 200) : err,
      );
    }
  }

  return completed;
}
