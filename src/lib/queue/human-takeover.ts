/**
 * Detecção de "humano assumiu a conversa" (handoff) — lógica compartilhada.
 *
 * Usada em dois pontos (DRY — antes a heurística anti-eco vivia inline só no
 * webhook e corria risco de divergir):
 *   1. Webhook /api/webhooks/inbound-message (branch outbound, tempo real) —
 *      depende do GHL assinar OutboundMessage (F51).
 *   2. queue-processor (fallback por histórico, F52) — funciona mesmo sem o
 *      webhook: ao processar um inbound, olha se a última msg outbound da
 *      conversa foi de um humano (não da IA) e pausa antes de responder.
 *
 * Como o GHLMessage não traz userId/source, distinguir "msg da IA" de "msg de
 * humano" é feito por ANTI-ECO: a mensagem bate com algo que a IA registrou ter
 * enviado (execution_log send_message)? Se não bate → humano.
 *
 * `classifyLastOutbound` é a ladder COMPLETA do F52 (anti-eco + source de
 * automação + userId + "IA nunca falou" + mídia). FONTE ÚNICA: chamada tanto pelo
 * runtime (queue-processor, que pausa a IA de verdade) quanto pelo pill "quem
 * dirige a conversa" (contact-controls, read-only) — assim o pill conclui sempre
 * o MESMO que o runtime, sem cópias divergindo.
 */
import { AUTOMATION_SOURCES } from "@/lib/ghl/message-sources";

/** Normaliza pra comparação tolerante (colapsa espaços, lower-case). */
function normalize(s: string): string {
  return (s || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * `body` é eco de ALGUMA mensagem que a IA enviou?
 *
 * Match tolerante (fix ultra-review 2026-05-26): além de igualdade exata, aceita
 * prefixo/contém quando ambos têm ≥20 chars — o canal pode truncar, alterar
 * emoji ou anexar sufixo em trânsito, e só-exato gerava FALSO-POSITIVO de
 * "humano" (pausa indevida). <20 chars exige match exato (evita falso-eco curto).
 */
export function isAiEcho(body: string, aiMessages: string[]): boolean {
  const bodyNorm = normalize(body);
  if (!bodyNorm) return false;
  for (const ai of aiMessages) {
    const cn = normalize(ai);
    if (!cn) continue;
    if (cn === bodyNorm) return true;
    const shorter = Math.min(cn.length, bodyNorm.length);
    if (shorter < 20) continue;
    if (
      cn.startsWith(bodyNorm) ||
      bodyNorm.startsWith(cn) ||
      cn.includes(bodyNorm) ||
      bodyNorm.includes(cn)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Extrai os textos que a IA enviou a partir de linhas de execution_log
 * (action_type='send_message'). O payload.message pode ser string ou string[].
 */
export function extractAiSentTexts(
  rows: Array<{ action_payload: unknown }> | null | undefined,
): string[] {
  const out: string[] = [];
  for (const row of rows || []) {
    const msg = (row?.action_payload as { message?: unknown } | null)?.message;
    if (Array.isArray(msg)) {
      out.push(...msg.filter((m): m is string => typeof m === "string"));
    } else if (typeof msg === "string") {
      out.push(msg);
    }
  }
  return out;
}

/**
 * Campos do último OUTBOUND que a ladder consome. O GHLMessage NÃO tipa
 * `userId`/`source` (chegam via cast nos call sites), por isso são opcionais aqui
 * — quando ausentes, a ladder cai nos discriminadores que não dependem deles.
 */
export interface LastOutboundForClassify {
  body?: string | null;
  userId?: string | null;
  source?: string | null;
}

// AUTOMATION_SOURCES (fontes de automação do GHL — welcome/campanha/bulk; NÃO é
// handoff humano mesmo carimbado com userId) vem da fonte ÚNICA em
// @/lib/ghl/message-sources, compartilhada com o gate do should-respond e o
// rótulo do histórico no prompt. Fix bug observado em prod 2026-06-10 (Alves
// Cury): o welcome da automação tinha userId → era lido como humano e pausava a
// IA em todo lead novo. Ver discriminador 1 da ladder abaixo.

/**
 * Ladder de discriminação F52 — "humano assumiu a conversa?" a partir do ÚLTIMO
 * outbound da conversa + os textos que a IA registrou ter enviado (anti-eco).
 *
 * Sinal PRIMÁRIO = ANTI-ECO, NÃO userId (Fix bug observado em prod 2026-06-18,
 * caso Marina): neste canal (Instagram via Stevo) o GHL carimba TUDO — nosso envio,
 * o do 2º atendente e o humano — como source="app" SEM userId. Então userId não
 * discrimina nada aqui. O que separa "fui eu" de "foi outro" é o anti-eco contra o
 * que a IA registrou ter enviado. (O commit c2ee2a6 exigiu userId pra pausar — ERRADO
 * pra esse canal: como userId nunca vem, a IA deixou de recuar do 2º atendente e
 * passou a atropelá-lo. Revertido.)
 *
 * Discriminadores, em ordem de confiança:
 *   1. source = automação → NÃO é humano (welcome/campanha/workflow). Alves Cury.
 *   2. eco da própria IA (anti-eco) → NÃO é humano. É o que impede a IA de se
 *      auto-pausar pelo próprio envio multi-parte (caso das 39 / Vandinha).
 *   3. userId de user do GHL presente → humano (sinal forte; reforço, não requisito).
 *   4. IA NUNCA falou nesta conversa (aiTexts vazio) → NÃO pausa: é lead de anúncio/
 *      automação de entrada, não há de quem "assumir". Marcela Lana 2026-06-05.
 *   5. outbound sem texto (mídia/áudio) DEPOIS da IA já ativa → humano (a IA só texto).
 *   6. caso geral (a IA já falou, tem texto, NÃO bate eco) → OUTRO assumiu (humano
 *      OU 2ª automação) → recua. É a regra que faz a IA não atropelar quem já atende.
 *
 * Recência é aplicada pelos CHAMADORES: should-respond usa
 * skip_if_human_replied_within_minutes; o webhook F51 reforça com janela anti-eco
 * (se a IA enviou nos ~90s, presume eco e não pausa). Assim, outbound antigo de
 * outro não cala a IA pra sempre — só recua quando o outro falou recentemente.
 */
export function classifyLastOutbound(args: {
  lastOutbound: LastOutboundForClassify;
  aiTexts: string[];
}): { isHuman: boolean } {
  const { lastOutbound, aiTexts } = args;
  const body = (lastOutbound.body || "").trim();
  const sentByGhlUser = !!lastOutbound.userId;
  const outboundSource = String(lastOutbound.source || "").toLowerCase();
  const isAutomationOutbound = AUTOMATION_SOURCES.has(outboundSource);
  const aiEcho = !!body && isAiEcho(body, aiTexts);

  let isHuman: boolean;
  if (isAutomationOutbound) {
    isHuman = false; // automação/workflow do GHL não é humano (mesmo com userId)
  } else if (aiEcho) {
    isHuman = false; // é a própria msg da IA → NÃO auto-pausa pelo próprio eco
  } else if (sentByGhlUser) {
    isHuman = true; // user GHL mandou manual (sinal forte de humano)
  } else if (aiTexts.length === 0) {
    isHuman = false; // IA nunca falou → ad/automação de entrada, não pausa (Marcela Lana)
  } else if (!body) {
    isHuman = true; // mídia/áudio depois da IA já ativa = outro atende
  } else {
    isHuman = true; // texto, IA já falou, não bate eco → OUTRO assumiu → recua
  }
  return { isHuman };
}
