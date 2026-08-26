/**
 * Lock de turno por rep — um turno do SparkBot de cada vez (review 2026-08-25).
 *
 * O CASO (Daniely Jones, 24/08 23:51): 4 mensagens em 27s viraram 4 lambdas
 * concorrentes. O turno da 4ª mensagem leu um histórico em que a pergunta "qual
 * Thaty?" estava sem resposta, escolheu sozinho e AGENDOU — 4 segundos antes de
 * a rep responder qual era. Resultado: 3 reuniões no mesmo horário.
 *
 * As defesas que existiam não alcançam: o debounce está desligado
 * (STEVO_DEBOUNCE_MS=0) e o `shouldStillRespond` só corre PRÉ-ENVIO — quando
 * ele percebe que outro turno respondeu, a tool de escrita já rodou (e o código
 * se recusa, com razão, a descartar turno com efeito colateral: jogar o texto
 * fora não desmarca a reunião). A trava precisa vir ANTES da tool.
 *
 * FILOSOFIA: espera, não descarta. Quem não pega o lock aguarda e SEMPRE roda —
 * só que depois, quando o histórico já tem a resposta do turno anterior. Nenhuma
 * mensagem de rep é engolida; o que muda é que ninguém age com meio contexto.
 *
 * FAIL-OPEN: qualquer erro de banco → segue processando. Um bot que responde com
 * risco de corrida é muito melhor que um bot mudo (lição do "inbound MUDO").
 */

import { createAdminClient } from "@/lib/supabase/admin";

/** TTL do lock. Maior que maxDuration=60 pra lambda morta não segurar o rep. */
const TTL_MS = 75_000;
/** Intervalo entre tentativas enquanto espera o lock. */
const POLL_MS = 700;

export type TurnLockOutcome =
  /** Peguei o lock: sou o único turno rodando pra este rep. */
  | { status: "acquired"; waitedMs: number }
  /** Esperei o teto e segui mesmo assim (fail-open). Pode haver concorrência. */
  | { status: "timeout"; waitedMs: number }
  /** Banco indisponível — segui sem lock (fail-open). */
  | { status: "unavailable"; waitedMs: number };

/** Tenta pegar o lock UMA vez. `null` = erro de banco (indeterminado). */
async function tentarClaim(repId: string, messageId: string): Promise<boolean | null> {
  const sb = createAdminClient();
  const agora = new Date();
  const expira = new Date(agora.getTime() + TTL_MS).toISOString();

  const ins = await sb
    .from("sparkbot_turn_locks")
    .insert({
      rep_id: repId,
      message_id: messageId,
      claimed_at: agora.toISOString(),
      expires_at: expira,
    })
    .select("rep_id")
    .maybeSingle();

  if (!ins.error) return true;
  // 23505 = já existe linha pra esse rep → alguém está com o lock (ou ele venceu).
  if (ins.error.code !== "23505") {
    console.warn(`[turn-lock] insert falhou (segue sem lock): ${ins.error.message}`);
    return null;
  }

  // Rouba lock VENCIDO de forma atômica: o `.lt(expires_at, agora)` é a
  // condição do UPDATE, então dois competidores não podem roubar os dois.
  const upd = await sb
    .from("sparkbot_turn_locks")
    .update({
      message_id: messageId,
      claimed_at: agora.toISOString(),
      expires_at: expira,
    })
    .eq("rep_id", repId)
    .lt("expires_at", agora.toISOString())
    .select("rep_id")
    .maybeSingle();

  if (upd.error) {
    console.warn(`[turn-lock] steal falhou (segue sem lock): ${upd.error.message}`);
    return null;
  }
  return !!upd.data;
}

/**
 * Teto de espera pelo lock: 15s.
 *
 * Medido em 4.732 turnos reais (01→25/08): p50 5,7s · p90 8,5s · p95 9,5s ·
 * p99 13,3s · máximo 41,4s. Ou seja, 15s cobre 99% dos turnos anteriores — e no
 * pior caso (esperar os 15 + o turno de 41s) ainda cabe no maxDuration=60 da
 * lambda. Esperar mais que isso inverteria o remédio: o turno ficaria sem tempo
 * de responder e o rep levaria silêncio, que é pior que a corrida.
 *
 * Estourou o teto → segue mesmo assim (fail-open), que é exatamente o
 * comportamento de hoje. O lock nunca deixa a situação pior; na esmagadora
 * maioria das vezes deixa melhor.
 */
const MAX_WAIT_MS = 15_000;

/**
 * Espera até conseguir o lock do rep, ou até estourar `maxWaitMs`.
 */
export async function acquireTurnLock(
  repId: string,
  messageId: string,
  maxWaitMs = MAX_WAIT_MS,
): Promise<TurnLockOutcome> {
  const inicio = Date.now();
  let houveErro = false;

  for (;;) {
    const r = await tentarClaim(repId, messageId);
    if (r === true) return { status: "acquired", waitedMs: Date.now() - inicio };
    if (r === null) {
      houveErro = true;
      break; // banco fora: não adianta insistir
    }
    if (Date.now() - inicio >= maxWaitMs) break;
    await new Promise((res) => setTimeout(res, POLL_MS));
  }

  const waitedMs = Date.now() - inicio;
  if (houveErro) return { status: "unavailable", waitedMs };
  return { status: "timeout", waitedMs };
}

/**
 * Solta o lock. Só apaga se o `message_id` for o MEU — senão um turno lento que
 * já perdeu o lock por TTL apagaria o lock de quem o roubou depois.
 */
export async function releaseTurnLock(repId: string, messageId: string): Promise<void> {
  try {
    const sb = createAdminClient();
    const { error } = await sb
      .from("sparkbot_turn_locks")
      .delete()
      .eq("rep_id", repId)
      .eq("message_id", messageId);
    if (error) console.warn(`[turn-lock] release falhou (TTL cobre): ${error.message}`);
  } catch (e) {
    console.warn(`[turn-lock] release lançou (TTL cobre): ${e instanceof Error ? e.message : e}`);
  }
}
