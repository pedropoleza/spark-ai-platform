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
