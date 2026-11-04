import type { FollowUpConfig } from "@/types/agent";

/**
 * Entrada pela automação: a IA cala na PRIMEIRA mensagem do lead e assume da
 * segunda em diante.
 *
 * H90 (decisão do Pedro, 2026-09-03, conta da Márcia): quem abre a conversa é
 * o workflow do Spark Leads ("Incoming Lead > Message": saudação + áudio +
 * pedido de dados) e ele adiciona a tag que liga o agente; a IA continua a
 * partir da RESPOSTA do lead. A coluna `agent_configs.entry_by_automation`
 * existia desde 24/07 exatamente pra isso (healthcheck desta conta) e nenhum
 * código a lia — era a 7ª config "salva e ignorada" achada nesta conta.
 *
 * Por que um gate e não só a ordem dos nós do workflow: se a tag for
 * adicionada no 1º nó, o turno do clique no anúncio já passa no targeting e a
 * IA responderia junto com a saudação da automação (as "7 mensagens"). O gate
 * torna o comportamento independente da ordem que alguém editar no painel.
 *
 * Decisão PURA — quem busca os dados é o processor:
 *  - só com a flag ligada;
 *  - só na primeira mensagem do lead (nenhum inbound anterior deste contato na
 *    fila): a resposta ao workflow NÃO é entrada, é continuação;
 *  - nunca em turno proativo nosso (syntheticTrigger) nem depois de "Ativar
 *    IA" no painel (ai_resumed_at) — o operador mandou falar;
 *  - nunca duas vezes (entry_suppressed_at) nem em conversa já ativa.
 */
export interface EntradaInput {
  entryByAutomation: boolean;
  manuallyResumed: boolean;
  syntheticTrigger: boolean;
  conversationActive: boolean;
  entrySuppressedAt: string | null | undefined;
  /** Inbounds deste contato recebidos ANTES do grupo atual. */
  inboundsAnteriores: number;
}

export function deveSilenciarEntrada(i: EntradaInput): boolean {
  if (!i.entryByAutomation) return false;
  if (i.manuallyResumed || i.syntheticTrigger) return false;
  if (i.conversationActive || i.entrySuppressedAt) return false;
  return i.inboundsAnteriores === 0;
}

/**
 * "Este contato já ATRAVESSOU o gate de ativação?" — usado pelo `trigger_once`
 * pra decidir se re-avalia o targeting no turno seguinte.
 *
 * H96 (bug observado em prod 2026-09-24): a entrada suprimida atravessou o gate
 * (o webhook só enfileirou porque o targeting casou), mas não deixa nenhum dos
 * dois rastros que `conversationActive` procura — não há resposta da IA nem
 * mensagem contada, justamente porque a IA calou de propósito. Sem contar o
 * `entry_suppressed_at`, o turno 2 é re-avaliado contra a folha `message` e a
 * resposta do lead ("2") nunca casa a frase do anúncio → `targeting_skip`.
 */
export function entradaJaPassouPeloGate(i: {
  conversationActive: boolean;
  entrySuppressedAt: string | null | undefined;
}): boolean {
  return i.conversationActive || !!i.entrySuppressedAt;
}

/**
 * H110 (caso Márcia, 29/10/2026): a entrada silenciada também abre a sequência
 * de follow-ups? Sem isso, quem não responde à boas-vindas do workflow nunca
 * entra na cadeia: `scheduleFollowUps` só roda depois de um turno da IA, e na
 * entrada pela automação esse turno não existe de propósito. Medido na conta:
 * dos leads de 27 e 28/10 que não responderam, 20 de 20 ficaram sem toque.
 * Opt-in por agente (`follow_up_config.start_on_entry`), com o follow-up ligado.
 * As travas de sempre continuam no runner (lead respondeu, equipe assumiu,
 * regra de desativação, janela de envio).
 */
export function deveIniciarFollowUpsNaEntrada(
  cfg: FollowUpConfig | null | undefined,
): cfg is FollowUpConfig {
  return !!cfg && cfg.enabled === true && cfg.start_on_entry === true;
}

/**
 * H111 (Alves Cury, 03/11/2026): entrada pela automação POR ETIQUETA.
 *
 * Na Márcia todo lead novo passa pela saudação do workflow, então a regra vale
 * pra todos. No Bruno não: só o lead do formulário de carreira é saudado pela
 * automação (com o link do vídeo da landing). Quem chega por anúncio direto no
 * WhatsApp, pelo Instagram, ou é ligado à mão pelo campo "AI" continua sendo
 * aberto pela IA, como antes. Com `agent_configs.entry_by_automation_tag`
 * preenchido, o silêncio da 1ª mensagem e o descarte do turno proativo valem SÓ
 * pro contato que tem a etiqueta (o workflow põe a etiqueta antes de ligar a IA).
 *
 *  - sem etiqueta configurada: vale pra todos (comportamento do H90);
 *  - etiqueta configurada e o contato tem: a automação abre, a IA cala;
 *  - etiqueta configurada e o contato não tem: a IA atende normal;
 *  - não deu pra ler as etiquetas: a IA atende (lead sem resposta é pior que
 *    uma mensagem a mais).
 *
 * Comparação sem caixa e sem espaço nas pontas: o Spark Leads guarda etiqueta
 * em minúsculas, mas quem digita a config pode não guardar.
 */
export function entradaVaiPelaAutomacao(
  etiquetaConfigurada: string | null | undefined,
  etiquetasDoContato: readonly string[] | null | undefined,
): boolean {
  const alvo = normalizarEtiqueta(etiquetaConfigurada);
  if (!alvo) return true;
  if (!etiquetasDoContato) return false;
  return etiquetasDoContato.some((t) => normalizarEtiqueta(t) === alvo);
}

/** Etiqueta da entrada pela automação na config (vazia/espaços = null). */
export function etiquetaDaEntrada(config: { entry_by_automation_tag?: string | null } | null | undefined): string | null {
  return normalizarEtiqueta(config?.entry_by_automation_tag) || null;
}

function normalizarEtiqueta(t: string | null | undefined): string {
  return (t ?? "").trim().toLowerCase();
}

/**
 * H113 (bug observado em prod 2026-11-04 01:12 UTC, 1º lead real do fluxo da landing
 * da Alves Cury): o formulário do Facebook cria o contato e a mensagem automática do
 * WhatsApp chega 2 s depois. O gatilho do campo "AI" e essa mensagem caíram no MESMO
 * lote (debounce de 15 s), e o descarte do turno proativo engoliu o lote inteiro: a
 * entrada não foi registrada (entry_suppressed_at) e os follow-ups da entrada (H110)
 * não nasceram. No teste de ponta a ponta não aparecia porque as duas coisas chegaram
 * com 18 s de diferença, em lotes separados.
 *
 * Regra: se o lote do gatilho também traz mensagem DO LEAD (texto que não é o corpo
 * sintético, áudio ou anexo), o gatilho sai e o lote segue como a 1ª mensagem do lead,
 * pelo caminho normal da entrada pela automação. É o mesmo princípio do H102 para o
 * lead novo: o gatilho não pode engolir o que o lead disse.
 */
export function loteTemMensagemDoLead(
  mensagens: ReadonlyArray<{
    message_body?: string | null;
    audio_url?: string | null;
    media_attachments?: unknown[] | null;
  }>,
  ehCorpoSintetico: (corpo: string) => boolean,
): boolean {
  return mensagens.some((m) => {
    const corpo = (m.message_body ?? "").trim();
    if (corpo && !ehCorpoSintetico(corpo)) return true;
    return !!m.audio_url || (Array.isArray(m.media_attachments) && m.media_attachments.length > 0);
  });
}
