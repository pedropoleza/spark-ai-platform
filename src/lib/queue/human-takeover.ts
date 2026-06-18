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
 * Discriminadores, em ordem de confiança (igual ao runtime que pausa a IA):
 *   1. source = automação → NÃO é humano, mesmo com userId (welcome/campanha).
 *      Alves Cury 2026-06-10. Checado ANTES de tudo (mais confiável).
 *   2. eco da própria IA (anti-eco) → NÃO é humano. O GHL carimba o envio via API
 *      da IA com o userId do ADMIN da conta — sem isto a IA via a própria msg como
 *      "humano (user GHL)" e emudecia após 1 resposta. Alves Cury / F56 2026-06-10.
 *   3. SEM userId de um user do GHL → NÃO é humano. Pedro 2026-06-18 ("só pausa se
 *      o usuário enviar mensagem"): handoff humano EXIGE sinal positivo = um user
 *      do GHL mandou manual (userId). Sem userId = eco da IA / anúncio / automação
 *      sem source / artefato de canal → NUNCA pausa (era o que mutava 39 leads no
 *      caso Marina: outbound sem userId caía no "caso geral → humano"). Bias a
 *      NÃO-mutar: falso-pause silencia o agente (pior) > falso-no-pause (a IA pode
 *      falar junto, e o rep pausa manual no pill).
 *   4. userId presente, não-eco, não-automação → um USER do GHL mandou manual →
 *      humano (pausa). Cobre handoff real E mídia/áudio do rep (a IA só manda texto).
 *
 * NOTA (F51, webhook): o roteador AINDA reforça com uma janela anti-eco — se a IA
 * enviou nos últimos ~90s, o outbound é presumido eco (multi-parte do IG chega em
 * segundos, às vezes mangled + com o userId do admin) e NÃO pausa, nem com userId.
 * Ver inbound-message/route.ts. Aqui (ladder compartilhada com F52/pill) ficamos no
 * sinal de userId, que o histórico do GHL carrega pra envios humanos de verdade.
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
    isHuman = false; // é a própria msg da IA (userId do admin não é confiável)
  } else if (!sentByGhlUser) {
    isHuman = false; // sem user GHL = não é handoff humano confiável → não pausa
  } else {
    isHuman = true; // user GHL mandou manual (texto não-eco OU mídia) → humano
  }
  return { isHuman };
}
