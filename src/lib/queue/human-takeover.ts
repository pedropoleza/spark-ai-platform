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
import { AUTOMATION_SOURCES, isChatMessageType } from "@/lib/ghl/message-sources";

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
 * IDs das mensagens GHL que a IA registrou ter enviado (2026-07-23, caso Marina).
 * O `action-executor`/`follow-up-scheduler` gravam `message_ids` no payload do
 * send_message (o `sendMessageToContact` retorna o messageId do GHL). Se o último
 * outbound da conversa tem um desses ids → fomos NÓS, com certeza — sem depender
 * do anti-eco por texto (que falha em IG: canal mangleia o corpo + userId vazio).
 */
export function extractAiSentIds(
  rows: Array<{ action_payload: unknown }> | null | undefined,
): string[] {
  const out: string[] = [];
  for (const row of rows || []) {
    const ids = (row?.action_payload as { message_ids?: unknown } | null)?.message_ids;
    if (Array.isArray(ids)) {
      out.push(...ids.filter((x): x is string => typeof x === "string" && !!x));
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
  /**
   * ID da mensagem no GHL (2026-07-23): sinal DETERMINÍSTICO de "fui eu que
   * enviei". Se este id está entre os que a IA registrou ter enviado (sentIds),
   * a msg é NOSSA com certeza — imune ao problema do anti-eco por texto (em IG o
   * canal mangleia o corpo e `userId` nunca vem, então o texto falhava e a IA se
   * auto-pausava achando que um humano assumiu — caso Marina, 152 falsos).
   */
  id?: string | null;
  body?: string | null;
  userId?: string | null;
  source?: string | null;
  /** Quando a mensagem entrou no CRM — usado pra atribuir mídia à nossa automação. */
  dateAdded?: string | null;
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
 *   2b. MERGE FIELD NÃO-INTERPOLADO ("Oi Nome do Cliente", "{{contact.name}}",
 *      "[nome]") → NÃO é humano. É automação/workflow do GHL com o campo
 *      quebrado — humano nunca digita isso. Vem ANTES do userId porque a
 *      automação roda "como" um user (caso Jussara 2026-07-16: numa conta
 *      Stevo tudo é source="api", então o passo 1 não pega a automação e o
 *      "Oi Nome do Cliente" caía no userId → humano → auto-pause indevido).
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
/**
 * `true` se o corpo tem um MERGE FIELD não-interpolado — sinal forte de automação
 * do GHL com o campo quebrado ("Oi Nome do Cliente", "{{contact.name}}", "[nome]").
 * Humano digitando no inbox nunca manda isso. Conservador: só tokens conhecidos +
 * `{{...}}` (handlebars), pra ZERO falso-positivo de humano de verdade.
 */
export function hasUnfilledMergeField(body: string): boolean {
  if (!body) return false;
  if (/\{\{[^}]{1,60}\}\}/.test(body)) return true; // {{contact.name}} etc
  if (/\bnome do cliente\b/i.test(body)) return true; // default PT do GHL quando 1º nome vazio
  if (/\[(nome|nome do cliente|name|first_name|primeiro_nome)\]/i.test(body)) return true;
  return false;
}

/** Janela em que uma mídia outbound ainda é atribuível à nossa automação. */
export const JANELA_NOSSA_MIDIA_MS = 10 * 60_000;

/** O outbound sem corpo saiu junto de uma automação nossa? PURO, testável. */
export function ehNossaMidia(
  outboundAtIso: string | undefined | null,
  ourMediaAtIso?: string[],
): boolean {
  if (!outboundAtIso || !ourMediaAtIso?.length) return false;
  const t = Date.parse(String(outboundAtIso));
  if (Number.isNaN(t)) return false;
  return ourMediaAtIso.some((iso) => {
    const m = Date.parse(String(iso));
    return !Number.isNaN(m) && Math.abs(m - t) <= JANELA_NOSSA_MIDIA_MS;
  });
}

export function classifyLastOutbound(args: {
  lastOutbound: LastOutboundForClassify;
  aiTexts: string[];
  /**
   * IDs das msgs que a IA registrou ter enviado (2026-07-23). Discriminador de
   * MAIOR confiança: se o id do último outbound está aqui, fomos nós — decide
   * ANTES do anti-eco por texto (imune ao mangle do IG). Opcional: callers
   * antigos que não passam caem no comportamento anterior (só texto).
   */
  sentIds?: string[];
  /**
   * Instantes (ISO) em que a NOSSA automação mandou mídia pra este contato —
   * áudio de abertura, PDF, foto. Elas saem por outro caminho que o
   * `send_message` da IA, então não estão em `sentIds` nem em `aiTexts`, e
   * chegam ao histórico como outbound de corpo VAZIO "de um user do CRM".
   *
   * Fix bug observado em prod 2026-08-09 (H73, caso Márcia): o áudio de
   * abertura que a própria conta dispara era lido como "um humano assumiu a
   * conversa" e CANCELAVA a sequência de follow-up inteira no primeiro toque.
   * 46 leads em 14 dias nessa conta — e ela é justamente a que usa áudio na
   * abertura, então praticamente nenhum follow-up dela saía.
   */
  ourMediaAtIso?: string[];
}): { isHuman: boolean } {
  const { lastOutbound, aiTexts, sentIds, ourMediaAtIso } = args;
  const body = (lastOutbound.body || "").trim();
  const sentByGhlUser = !!lastOutbound.userId;
  const outboundSource = String(lastOutbound.source || "").toLowerCase();
  const isAutomationOutbound = AUTOMATION_SOURCES.has(outboundSource);
  // Match determinístico por ID (2026-07-23, caso Marina/152 falsos): o último
  // outbound é uma mensagem que NÓS enviamos → NUNCA é handoff humano.
  const idEcho = !!lastOutbound.id && !!sentIds?.includes(String(lastOutbound.id));
  // Mídia NOSSA: outbound sem corpo que saiu junto com uma automação nossa
  // (±10min). A janela é o que distingue o áudio de abertura de um áudio que a
  // pessoa da equipe mandou de verdade horas depois — esse continua pausando.
  const nossaMidia = !body && !!lastOutbound.dateAdded && ehNossaMidia(lastOutbound.dateAdded, ourMediaAtIso);
  const aiEcho = idEcho || (!!body && isAiEcho(body, aiTexts));

  let isHuman: boolean;
  if (idEcho) {
    isHuman = false; // certeza: é uma msg NOSSA (id bate com o que a IA enviou)
  } else if (nossaMidia) {
    isHuman = false; // áudio/mídia disparado pela nossa própria automação
  } else if (isAutomationOutbound) {
    isHuman = false; // automação/workflow do GHL não é humano (mesmo com userId)
  } else if (aiEcho) {
    isHuman = false; // é a própria msg da IA → NÃO auto-pausa pelo próprio eco
  } else if (hasUnfilledMergeField(body)) {
    // 2b (caso Jussara 2026-07-16): merge field quebrado = automação, não humano.
    // ANTES do userId porque a automação roda "como" um user (source="api" na conta
    // Stevo, então o passo 1 não pega). Sem isto, "Oi Nome do Cliente" auto-pausava.
    isHuman = false;
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

// ─────────────────────────────────────────────────────────────────────────────
// H105 (2026-10-16, ticket #445, caso Jussara/Thiago): quem conduz a conversa
// ─────────────────────────────────────────────────────────────────────────────
//
// Fix bug observado em prod 2026-10-16: a IA seguiu falando com o Thiago depois
// que a Thamires (equipe) ligou, mandou a ficha e MARCOU a reunião (15/10 22:50
// a 22:53 UTC), e no dia seguinte o follow-up perguntou "posso te mandar uma
// cotação hoje?" com a reunião marcada pra 12pm. Três furos, todos medidos no
// histórico dele:
//  1. Só a ÚLTIMA saída era classificada. A reunião marcada dispara o fluxo de
//     confirmação (source "workflow"), que vira a última saída e esconde a
//     mensagem da equipe logo antes dela. O lembrete do Zoom fez o mesmo com o
//     "não sei por que o robô te mandou essa mensagem" das 13:10.
//  2. O guarda de eco (≤120s depois de um envio nosso) engolia a equipe que
//     entra pra corrigir o robô, que é exatamente quando ela escreve rápido:
//     "Pode desconsiderar essas mensagens, elas estão sendo mandadas pelo robô"
//     saiu 1s depois da IA e foi lido como eco da própria IA.
//  3. A equipe da Jussara responde pelo CELULAR. O Spark OS espelha essa
//     mensagem no Spark Leads como saída `api` SEM userId (postOutbound do
//     spark-os/src/lib/wa/ghl.ts), e o webhook F51 descarta toda saída `api`.

/** Campos que as funções de histórico abaixo leem de cada mensagem do Spark Leads. */
export interface MensagemDoHistoricoGhl extends LastOutboundForClassify {
  direction?: string;
  messageType?: string;
}

/** Ligação (feita ou recebida). Não é mensagem de chat, mas é contato humano. */
function ehLigacao(messageType?: string | null): boolean {
  const mt = String(messageType || "").toUpperCase();
  return mt.includes("CALL");
}

/**
 * A saída é de AUTOMAÇÃO (não diz nada sobre quem conduz a conversa)?
 * Fluxo/campanha do Spark Leads, merge field quebrado (automação com campo
 * vazio) e a mídia que a nossa própria automação mandou (±10min).
 */
export function ehSaidaAutomatica(m: MensagemDoHistoricoGhl, ourMediaAtIso?: string[]): boolean {
  if (AUTOMATION_SOURCES.has(String(m.source || "").toLowerCase())) return true;
  const body = (m.body || "").trim();
  if (body && hasUnfilledMergeField(body)) return true;
  if (!body && !!m.dateAdded && ehNossaMidia(m.dateAdded, ourMediaAtIso)) return true;
  return false;
}

/**
 * A saída que DECIDE quem conduz agora: a mais recente saída de CHAT que não é
 * automação. É ela que vai pra `classifyLastOutbound` (furo 1 acima). Atividade
 * do CRM e ligação ficam de fora, como já era (`isChatMessageType`).
 */
export function saidaQueDecide<T extends MensagemDoHistoricoGhl>(
  mensagens: T[],
  opts?: { ourMediaAtIso?: string[] },
): T | undefined {
  return [...mensagens]
    .filter((m) => m.direction === "outbound" && isChatMessageType(m.messageType))
    .sort((a, b) => Date.parse(String(b.dateAdded)) - Date.parse(String(a.dateAdded)))
    .find((m) => !ehSaidaAutomatica(m, opts?.ourMediaAtIso));
}

/** Janela em que uma saída logo depois de um envio nosso pode ser o eco dele. */
export const JANELA_ECO_DO_ENVIO_MS = 120_000;

/**
 * A saída chegou logo depois de um envio nosso: dá pra presumir que é o eco
 * dele? (guarda do F52, Fix review 2026-06-18)
 *
 * O guarda existe pro eco que o classificador não reconhece (canal que mexe no
 * corpo, envio sem id no log). Quando a saída TEM texto e o nosso último envio
 * gravou os ids, não há o que presumir: se fosse eco, o id teria batido (o
 * classificador confere id antes de tudo). Id diferente é outra pessoa
 * escrevendo, e foi assim que a equipe da Jussara ficou invisível (furo 2).
 * Sem texto (mídia) ou sem ids no log, o guarda segue como era.
 */
export function pareceEcoDoEnvio(args: {
  saida: { id?: string | null; body?: string | null; dateAdded?: string | null };
  ultimoEnvioEmMs: number;
  idsDoUltimoEnvio: string[];
  janelaMs?: number;
}): boolean {
  const { saida, ultimoEnvioEmMs, idsDoUltimoEnvio } = args;
  if (!ultimoEnvioEmMs) return false;
  const t = Date.parse(String(saida.dateAdded));
  if (Number.isNaN(t)) return false;
  const delta = t - ultimoEnvioEmMs;
  if (delta > (args.janelaMs ?? JANELA_ECO_DO_ENVIO_MS) || delta < -5_000) return false;
  if (!(saida.body || "").trim()) return true;
  if (saida.id && idsDoUltimoEnvio.length > 0) return false;
  return true;
}

/**
 * Modo "equipe falou, a IA não entra" (`agent_configs.skip_if_team_contacted`,
 * opt-in por agente): existe QUALQUER contato da equipe no histórico visível?
 *
 * Mais duro que o F52 de propósito, porque é o combinado com a conta (Jussara,
 * 16/10: "ficou acordado que ela não iria mais entrar em conversas que já
 * tiveram interação nossa"):
 *  - vale ANTES de a IA falar (o F52 não pausa quando a IA nunca falou, pra não
 *    confundir a boas-vindas de automação com humano);
 *  - não tem prazo de validade (o F52 ignora humano com mais de 72h);
 *  - conta ligação feita por alguém da equipe (o F52 não conta, a IA é dona do
 *    texto e ligação não cala ela).
 * Fica de fora: automação (`ehSaidaAutomatica`), atividade do CRM e o que é
 * nosso (id ou texto de um envio que a IA registrou).
 */
export function contatoDaEquipe<T extends MensagemDoHistoricoGhl>(
  mensagens: T[],
  ia: { textos: string[]; ids: string[]; midiaNossaEm?: string[] },
): T | null {
  const saidas = [...mensagens]
    .filter((m) => m.direction === "outbound")
    .sort((a, b) => Date.parse(String(b.dateAdded)) - Date.parse(String(a.dateAdded)));
  for (const m of saidas) {
    if (ehLigacao(m.messageType)) {
      if (m.userId) return m;
      continue;
    }
    if (!isChatMessageType(m.messageType)) continue;
    if (ehSaidaAutomatica(m, ia.midiaNossaEm)) continue;
    if (m.id && ia.ids.includes(String(m.id))) continue;
    const body = (m.body || "").trim();
    if (body && isAiEcho(body, ia.textos)) continue;
    return m;
  }
  return null;
}

/** MC-7 (caso Geralda, 2026-07-28): humano com mais de 72h não pausa no F52. */
export const HUMANO_VELHO_MS = 72 * 60 * 60 * 1000;

export interface DecisaoDePausa {
  /** `ai_paused_reason` a gravar; null = a IA segue. */
  motivo: string | null;
  gatilho: "H105_team_contact" | "F52_history_fallback" | null;
  detalhe: Record<string, unknown>;
  /** F52 achou humano mas velho demais (MC-7): o processor só registra. */
  humanoVelhoEm: string | null;
}

/**
 * Decisão PURA da pausa pelo histórico, antes de gastar tokens (F52 + H105).
 * O queue-processor busca os dados e grava; a decisão mora aqui pra o teste
 * rodar o mesmo código da produção (scripts/test-equipe-assumiu.ts).
 *
 * `enviosDaIa` em ordem decrescente (o 1º é o envio mais recente), com
 * `created_at`: é dele que sai a janela do guarda de eco.
 */
export function decidirPausaPeloHistorico(args: {
  mensagens: MensagemDoHistoricoGhl[];
  enviosDaIa: Array<{ action_payload: unknown; created_at?: string | null }>;
  autoPause: boolean;
  estrito: boolean;
  /** `ai_resumed_at` em ms (0 = nunca religada à mão). GU-6: religou depois, a IA fala. */
  retomadaManualEmMs: number;
  agoraMs: number;
}): DecisaoDePausa {
  const { mensagens, enviosDaIa, autoPause, estrito, retomadaManualEmMs, agoraMs } = args;
  const segue: DecisaoDePausa = { motivo: null, gatilho: null, detalhe: {}, humanoVelhoEm: null };
  const textos = extractAiSentTexts(enviosDaIa);
  const ids = extractAiSentIds(enviosDaIa);
  const religadaDepois = (iso?: string | null) =>
    retomadaManualEmMs > 0 && Date.parse(String(iso)) <= retomadaManualEmMs;

  if (estrito) {
    const equipe = contatoDaEquipe(mensagens, { textos, ids });
    if (equipe && !religadaDepois(equipe.dateAdded)) {
      return {
        motivo: "auto_pause:human_message:team_contact",
        gatilho: "H105_team_contact",
        detalhe: { team_contact_at: equipe.dateAdded, team_contact_kind: String(equipe.messageType || "") },
        humanoVelhoEm: null,
      };
    }
  }

  if (!autoPause) return segue;
  const saida = saidaQueDecide(mensagens);
  if (!saida) return segue;
  const { isHuman } = classifyLastOutbound({ lastOutbound: saida, aiTexts: textos, sentIds: ids });
  if (!isHuman) return segue;
  const ultimoEnvioEmMs = enviosDaIa[0]?.created_at ? Date.parse(String(enviosDaIa[0].created_at)) : 0;
  const eco = pareceEcoDoEnvio({
    saida,
    ultimoEnvioEmMs: Number.isNaN(ultimoEnvioEmMs) ? 0 : ultimoEnvioEmMs,
    idsDoUltimoEnvio: extractAiSentIds(enviosDaIa.slice(0, 1)),
  });
  if (eco || religadaDepois(saida.dateAdded)) return segue;
  if (agoraMs - Date.parse(String(saida.dateAdded)) > HUMANO_VELHO_MS) {
    return { ...segue, humanoVelhoEm: saida.dateAdded ? String(saida.dateAdded) : null };
  }
  return { motivo: "auto_pause:human_message:history", gatilho: "F52_history_fallback", detalhe: {}, humanoVelhoEm: null };
}
