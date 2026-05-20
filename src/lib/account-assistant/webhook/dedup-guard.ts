/**
 * Dedup-guard do SparkBot — defesas anti-reprocessamento da ingestão.
 *
 * Extraído de webhook-handler.ts na V2.2 (decomposição do god-file, ver
 * _planning/_review-2026-05-19/B1-arquitetura.md §4 e B2-tools-loop.md §3 P0 #2).
 *
 * ⚠️ ESTE É O CÓDIGO MAIS CRÍTICO DA INGESTÃO. As 7 camadas de idempotência
 * (CLAUDE.md "Sparkbot — Idempotency") são o coração de "cada msg física do
 * rep gera no máximo 1 resposta". Mexer aqui sem smoke E2E é o maior risco do
 * sistema.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * O QUE VIVE AQUI (movido do handler, BYTE-A-BYTE):
 *   • Camada 1 — Mutex em memória (`inFlightMessages` Map module-level).
 *     Chaveado por `ghl_message_id`, por-lambda. NÃO substitui a UNIQUE
 *     constraint (multi-lambda) — só evita 2× Whisper num dup-burst <1s
 *     dentro da MESMA lambda. Module-level state continua singleton-por-lambda
 *     exatamente como antes (ES module instancia uma vez por lambda,
 *     independente do arquivo).
 *
 * O QUE FOI ADICIONADO NA V2.2 (camada 8, ADITIVO — não substitui nenhuma):
 *   • `tryContentDedupLock` — lock atômico por `(rep_id + hash(content))` com
 *     janela CURTA (~2s), pra abortar webhooks CONCORRENTES com
 *     `ghl_message_id` DISTINTOS (caso da dupla-resposta quando a WhatsApp
 *     Business API volta + Stevo, 2 webhooks <3ms). Hoje (Stevo-only)
 *     raramente dispara, mas é a defesa correta na origem.
 *
 * O QUE NÃO FOI MOVIDO (continua INLINE no handler, de propósito):
 *   • Camadas 2–7 (SELECT por ghl_message_id, CONTENT-MATCH 15s,
 *     TIMING-MATCH 5s, INSERT minute-bucket em sparkbot_dedup_locks, UNIQUE
 *     23505 na insert de sparkbot_messages, rep_identity 23505 em identifyRep).
 *     Essas estão INTERLEAVADAS com o fluxo principal (referenciam `rep`,
 *     `supabase`, `messageBody`, têm early-returns no meio do pipeline). Movê-
 *     las mudaria ordem de execução / control-flow → risco inaceitável de
 *     alterar a ingestão. Ficam documentadas e intactas no handler.
 * ─────────────────────────────────────────────────────────────────────────
 */

import { createHash } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

// ===========================================================================
// CAMADA 1 — Mutex em memória (intra-lambda)
// ===========================================================================

/**
 * Mutex em memória pra dedup concorrente dentro de uma única lambda.
 * Não substitui a UNIQUE constraint (multi-lambda) mas evita 2× Whisper
 * quando GHL faz dup-burst em <1s (caso raro mas mostrável).
 * TTL: 60s — depois disso a UNIQUE constraint cobre.
 */
const inFlightMessages = new Map<string, number>();
const IN_FLIGHT_TTL_MS = 60_000;

export function tryClaimInFlight(ghlMessageId: string): boolean {
  const now = Date.now();
  // GC entries expiradas
  for (const [k, expiresAt] of inFlightMessages) {
    if (expiresAt < now) inFlightMessages.delete(k);
  }
  if (inFlightMessages.has(ghlMessageId)) return false;
  inFlightMessages.set(ghlMessageId, now + IN_FLIGHT_TTL_MS);
  return true;
}

export function releaseInFlight(ghlMessageId: string): void {
  inFlightMessages.delete(ghlMessageId);
}

// ===========================================================================
// CAMADA 8 (ADITIVA, V2.2) — Lock atômico por conteúdo, janela CURTA
// ===========================================================================

/**
 * Janela CURTA do content-dedup lock (camada 8).
 *
 * ⚠️ CRÍTICO mantê-la CURTA (≤2-3s): a única coisa que ela precisa pegar são
 * webhooks CONCORRENTES (2 providers disparam o MESMO evento físico em <3ms).
 * Um rep que manda "sim" 2× DE PROPÓSITO vem segundos depois — esse NÃO pode
 * ser descartado. 2s cobre a concorrência multi-provider com folga e está bem
 * abaixo do menor intervalo plausível de digitação humana repetida.
 *
 * NÃO confundir com as janelas das camadas 4 (CONTENT-MATCH 15s) e 5
 * (TIMING-MATCH 5s) que rodam DEPOIS, contra o histórico persistido. Esta é a
 * primeira barreira atômica, antes de qualquer processamento pesado.
 */
const CONTENT_LOCK_WINDOW_MS = 2_000;

/** Prefixo de namespace pra NÃO colidir com a key da camada 4 (minute-bucket). */
const CONTENT_LOCK_PREFIX = "ch";

function contentHash(repId: string, content: string): string {
  // sha1 truncado — só precisa ser estável e colisão-improvável dentro do
  // par (rep, janela 2s). Não é segurança, é dedup.
  const h = createHash("sha1").update(content).digest("hex").slice(0, 24);
  return `${CONTENT_LOCK_PREFIX}:${repId}:${h}`;
}

export interface ContentDedupResult {
  /** true = este webhook deve ABORTAR (um concorrente já pegou o lock <2s). */
  isDuplicate: boolean;
  /** Pra log: a key usada. */
  dedupKey: string;
}

/**
 * CAMADA 8 — Lock atômico por (rep_id + hash(content)), janela CURTA ~2s.
 *
 * Roda logo APÓS identificar o rep e ANTES de extrair/transcrever/processar.
 * Reusa a tabela `sparkbot_dedup_locks` existente (PK em `dedup_key`), com:
 *   • key com prefixo "ch:" (namespace separado da camada 4),
 *   • `expires_at` curto (now + 2s) — auto-libera rápido,
 *   • em 23505 (lock já existe), re-lê `created_at`: se o lock é FRESCO
 *     (<2s) → é um concorrente real → ABORTA; se é STALE (≥2s) → é um repeat
 *     LEGÍTIMO do rep → NÃO aborta (e refresca o lock pra cobrir um eventual
 *     terceiro webhook concorrente deste novo evento).
 *
 * Esse re-check em 23505 é o que garante ZERO falso-descarte: a expiração não
 * depende do cron de cleanup (que roda a cada 5min) — depende do `created_at`
 * lido na hora. Boundary-free (sem time-bucket na key).
 *
 * 100% defensivo: qualquer erro de DB → retorna isDuplicate=false (segue o
 * fluxo). As camadas 2–7 continuam cobrindo. NUNCA bloqueia por falha de infra.
 */
export async function tryContentDedupLock(args: {
  repId: string;
  content: string;
  ghlMessageId?: string;
}): Promise<ContentDedupResult> {
  const { repId, content, ghlMessageId } = args;
  const dedupKey = contentHash(repId, content);

  try {
    const supabase = createAdminClient();
    const nowMs = Date.now();
    const expiresAt = new Date(nowMs + CONTENT_LOCK_WINDOW_MS).toISOString();

    const lockRes = await supabase
      .from("sparkbot_dedup_locks")
      .insert({
        dedup_key: dedupKey,
        rep_id: repId,
        content_preview: content.slice(0, 100),
        expires_at: expiresAt,
      })
      .select("dedup_key")
      .maybeSingle();

    if (!lockRes.error) {
      // Ganhou o lock — primeiro a chegar. Segue normal.
      return { isDuplicate: false, dedupKey };
    }

    // 23505 = unique_violation — já existe um lock pra esse (rep, content).
    if (lockRes.error.code === "23505") {
      // Re-lê o lock existente pra distinguir CONCORRENTE (fresco) de
      // REPEAT LEGÍTIMO (stale). NÃO depende do cron de cleanup.
      const { data: existing } = await supabase
        .from("sparkbot_dedup_locks")
        .select("created_at")
        .eq("dedup_key", dedupKey)
        .maybeSingle();

      if (existing?.created_at) {
        const ageMs = nowMs - new Date(existing.created_at as unknown as string).getTime();
        if (ageMs <= CONTENT_LOCK_WINDOW_MS) {
          // Lock fresco → webhook concorrente do MESMO evento físico. ABORTA.
          console.warn(
            `[Sparkbot] CONTENT-HASH LOCK (camada 8): rep ${repId} msg ` +
            `"${content.slice(0, 30)}" já claim'd há ${ageMs}ms (<${CONTENT_LOCK_WINDOW_MS}ms) ` +
            `por webhook concorrente (current ghl_msg=${ghlMessageId}). Abortando dupla-resposta.`,
          );
          return { isDuplicate: true, dedupKey };
        }
        // Lock STALE (rep mandou de novo segundos depois, de propósito).
        // NÃO aborta. Refresca o lock pra cobrir um eventual terceiro webhook
        // concorrente deste novo disparo. Best-effort.
        await supabase
          .from("sparkbot_dedup_locks")
          .update({
            created_at: new Date(nowMs).toISOString(),
            expires_at: new Date(nowMs + CONTENT_LOCK_WINDOW_MS).toISOString(),
          })
          .eq("dedup_key", dedupKey);
        console.log(
          `[Sparkbot] CONTENT-HASH LOCK (camada 8): lock stale (${ageMs}ms) pra rep ${repId} ` +
          `msg "${content.slice(0, 30)}" — repeat legítimo, NÃO descarta.`,
        );
        return { isDuplicate: false, dedupKey };
      }

      // Não conseguiu reler o lock (race de cleanup, etc) — defensivo: NÃO
      // aborta. As camadas 2–7 cobrem. Preferimos uma rara dupla a um
      // falso-descarte de msg legítima.
      console.warn(
        `[Sparkbot] CONTENT-HASH LOCK (camada 8): 23505 mas não releu lock pra rep ${repId} — ` +
        `seguindo (camadas 2-7 cobrem).`,
      );
      return { isDuplicate: false, dedupKey };
    }

    // Outro erro de insert — não-bloqueante (defensivo).
    console.warn(
      "[Sparkbot] CONTENT-HASH LOCK (camada 8) insert falhou (não-bloqueante):",
      lockRes.error.message,
    );
    return { isDuplicate: false, dedupKey };
  } catch (err) {
    // Qualquer crash de infra → segue o fluxo. NUNCA bloqueia por falha de DB.
    console.warn(
      "[Sparkbot] CONTENT-HASH LOCK (camada 8) crashou (não-bloqueante):",
      err instanceof Error ? err.message : err,
    );
    return { isDuplicate: false, dedupKey };
  }
}
