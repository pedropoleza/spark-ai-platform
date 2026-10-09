/**
 * H103 (2026-10-09, ticket #434 da Alves Cury, aprovado pelo Marcos em 08/10):
 * remarcação depois que a equipe assume a conversa.
 *
 * Quando um humano da equipe assume (a IA pausa pela mensagem dele, ou pausa
 * depois de agendar no `stop_and_handoff`), a IA fica quieta. O cliente pediu
 * uma exceção: se o lead pedir pra remarcar ou desmarcar a reunião, a IA volta
 * SÓ pra isso, move a reunião na agenda e avisa a equipe na hora. Fora disso
 * continua quieta, e a pausa NUNCA é desfeita (quem religa a IA é a equipe).
 *
 * Opt-in por agente (`agent_configs.reschedule_after_handoff`, default false).
 * Kill-switch global: `REMARCACAO_POS_HANDOFF_DISABLED=1`.
 *
 * Travas, nesta ordem, antes de a IA falar:
 *  1. A pausa é da EQUIPE (mensagem humana ou pós-agendamento). Desligar na mão
 *     (switch do painel), regra de automação, opt-out e teto de mensagens NÃO
 *     abrem exceção: desligar tem que valer (H99).
 *  2. O lead pediu pra remarcar/desmarcar (detector abaixo, medido contra as
 *     30.020 mensagens de lead da frota) OU já existe uma janela de remarcação
 *     aberta (a troca de horário leva 2 turnos: oferta e escolha).
 *  3. O contato tem reunião FUTURA no calendário DESTE agente, e nenhum humano
 *     escreveu dentro da janela de "humano conduzindo" do agente.
 * Depois disso o modelo ainda pode ficar em silêncio se a mensagem não for
 * sobre a reunião: o detector erra pra mais de propósito, quem fecha é o turno.
 */
import { classifyLastOutbound, type LastOutboundForClassify } from "@/lib/queue/human-takeover";
import { isChatMessageType } from "@/lib/ghl/message-sources";
import type { AIAction } from "@/types/ai";

/** Janela em que a troca de horário continua depois do 1º turno. */
export const JANELA_REMARCACAO_MS = 24 * 60 * 60 * 1000;
/** Humano escreveu há menos que isso → ele está conduzindo, a IA não entra. */
export const HUMANO_ATIVO_PADRAO_MIN = 30;
/** Reunião nas próximas horas: um "não vou conseguir" solto é sobre ela. */
export const REUNIAO_EM_BREVE_MS = 36 * 60 * 60 * 1000;

export type TipoPedidoRemarcacao = "remarcar" | "desmarcar" | "nao_vai";

export interface PedidoDeRemarcacao {
  tipo: TipoPedidoRemarcacao;
  /**
   * `explicito`: o texto sozinho já diz ("quero remarcar", "hoje não consigo ir").
   * `contextual`: só vale se a conversa estiver falando da reunião ("não vou
   * conseguir" respondendo ao lembrete).
   */
  forca: "explicito" | "contextual";
  /** Qual padrão casou, pra auditoria no execution_log. */
  regra: string;
}

export interface ReuniaoFutura {
  id: string;
  calendarId: string;
  startTime: string;
  title?: string;
}

export function remarcacaoHabilitada(
  config: { reschedule_after_handoff?: boolean | null } | null | undefined,
): boolean {
  if (process.env.REMARCACAO_POS_HANDOFF_DISABLED === "1") return false;
  return config?.reschedule_after_handoff === true;
}

/** Pausas que significam "a equipe assumiu". Todo o resto mantém a IA quieta. */
export function pausaEhDaEquipe(motivo: string | null | undefined): boolean {
  const m = String(motivo || "");
  return m.startsWith("auto_pause:human_message") || m === "post_booking:stop_and_handoff";
}

// ─────────────────────────────────────────────────────────────────────────────
// Texto do lead
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resposta citando outra mensagem chega como
 * "↩️ Reply menssage: <citada>\n\n➡️ Message: <texto do lead>". Só o texto do
 * lead é pedido; a citada é CONTEXTO (o lembrete que ele está respondendo).
 * Sem isso, "Se não conseguir comparecer, nos avise" do lembrete citado virava
 * pedido de desmarcar.
 */
export function separarTextoDoLead(bruto: string): { proprio: string; citado: string } {
  const s = String(bruto ?? "");
  const m = s.match(/↩️\s*Reply\s*mens+age:\s*([\s\S]*?)\n\s*➡️\s*Message:\s*([\s\S]*)$/i);
  let proprio = m ? m[2] : s;
  const citado = m ? m[1] : "";
  proprio = proprio
    .replace(/^\s*\[Áudio do contato, transcrito\]\s*/i, "")
    .replace(/^\s*Audio Message\.\s*Transcription:\s*/i, "");
  // Mensagem de entrada de anúncio/formulário nunca é pedido de remarcação, nem
  // repasse de grupo interno ("👤 Fulana (+55…) Ju, pede pra remarcar…").
  if (/^\s*🔵\s*AD MESSAGE|\*Headline:\*|^\s*👤/i.test(proprio)) proprio = "";
  return { proprio, citado };
}

export function normalizarTexto(t: string): string {
  return String(t ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9?\s]/g, " ")
    .replace(/\bhj\b/g, "hoje")
    .replace(/\bamanh\b/g, "amanha")
    .replace(/\b(pra|pro)\b/g, "para")
    .replace(/\bq\b/g, "que")
    .replace(/\bvc\b/g, "voce")
    .replace(/\bn\b/g, "nao")
    .replace(/\s+/g, " ")
    .trim();
}

// Pedido direto de outro horário.
const REMARCAR = /\b(re ?marc\w*|re ?agend\w*|reprogram\w*|resched\w*)/;
const DESMARCAR = /\bdesmarc\w*/;
const PEDIDO_OUTRO_DIA =
  /\b(tem|teria|tens|tiver|ha|pode ser|podemos|poderiamos|podia|vamos|marcar|marcamos|agendar|mudar|passar|deixar|deixa|pensar|prefiro|preferia|seria possivel|consegue|conseguimos|da para|daria para|gostaria|queria|quero)\b(?:\s+\S+){0,4}\s+outr[oa]s? (dia|horario|data|hora|semana)s?\b/;
const MUDAR_O_HORARIO =
  /\b(mudar|trocar|alterar|passar|transferir|mover|adiar|empurrar)\b(?:\s+\S+){0,4}\s+(horario|hora|dia|data|reuniao|encontro|call|zoom|agendamento|apontamento|compromisso|ligacao|chamada|videochamada|conversa)s?\b/;
const DEIXAR_PARA =
  /\b(deixar|passar|jogar|empurrar|marcar|agendar)\b(?:\s+\S+){0,2}\s+para (segunda|terca|quarta|quinta|sexta|sabado|domingo|amanha|semana que vem|a proxima semana|proxima semana|outro dia)\b/;
// "não precisa remarcar", "não vou cancelar": é o contrário de pedido.
const NEGA_O_PEDIDO =
  /\bnao (precisa|precisamos|quero|vou|vamos|tem que|temos que|e necessario|e preciso)\b(?:\s+\S+){0,2}\s+(re ?marc|re ?agend|desmarc|cancel)/;

// Desmarcar. Presente/imperativo é pedido; passado só com o objeto reunião.
const CANCELA_AGORA = /\bcancel(a|ar|e|o|amos|aria|em)\b/;
const CANCELOU = /\bcancel(ei|ou|amos|ado|ada|ando)\b/;
const OBJETO_REUNIAO =
  /^(reuniao|reunioes|encontro|agendamento|apontamento|compromisso|call|chamada|ligacao|videochamada|zoom|horario|consulta|vaga|aula|evento|meeting|conversa|visita)s?$/;
const OBJETO_OUTRO =
  /^(seguro|apolice|plano|contrato|cobranca|pagamento|assinatura|cartao|pedido|aplicacao|processo|licenca|curso|matricula|servico|policy)s?$/;
// Intenção de cancelar sem objeto ("terei que cancelar, assim que me organizar
// eu volto"). Vale em qualquer posição; o objeto, quando vem, decide antes.
const INTENCAO_CANCELAR =
  /^(cancela|cancelar)\b|\b(terei que|teremos que|tenho que|temos que|vou ter que|vamos ter que|vou precisar|preciso|pode|podemos|vamos|quero|gostaria de|vou|pedi para)\s+cancelar\b/;
// Cancelar o seguro/contrato não é desmarcar reunião, em nenhuma posição da frase.
const FALA_DE_PRODUTO = /\b(seguro|apolice|contrato|cobranca|cobrancas|pagamento|plano|assinatura|policy)\b/;

// Não vai comparecer.
const NAO_PRESENCA =
  /\bnao (vou|vai|irei|iremos|vamos|vou mais) (poder|conseguir|dar)\b|\bnao (poderei|conseguirei|poderemos|conseguiremos|podera|conseguira)\b|\bnao (posso|consigo|podemos|conseguimos)\b|\bnao (vou|irei|vamos) (estar|ter tempo|participar|comparecer|ir|entrar)\b|\bnao (estarei|estaremos|terei tempo|teremos tempo)\b|\b(vou|vamos) (ter que|ter de|precisar) faltar\b|\bvou faltar\b/;
const REF_REUNIAO =
  /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|(essa|esta|nessa|nesta) semana|semana que vem|proxima semana|(nesse|neste|esse|este|nesses|nestes|esses|estes|no|nos) (horario|dia|data)s?|a noite|de noite|a tarde|de tarde|ir|comparecer|participar|entrar|aparecer|reuniao|encontro|call|chamada|ligacao|videochamada|zoom|link|consulta|exame|apontamento|agendamento|compromisso)\b/;
// "Não posso falar agora" é ocupado AGORA, não falta na reunião.
const OCUPADO_AGORA = /\b(agora|no momento|neste momento|nesse momento|por agora|por enquanto|ainda)\b/;
// "Não posso pagar", "não consigo contratar": a negação é de outro assunto.
const OUTRO_ASSUNTO =
  /\b(pagar|gastar|contratar|fechar|assumir|comprar|baixar|abrir|acessar|ouvir|investir|cotacao|valor|preco|dinheiro|documento|documentos|social|ssn|permissao|licenca|seguro|apolice|responder|sinal|internet|garantir)\b/;
// Tentando entrar AGORA e não consegue: problema técnico na hora da reunião, é
// a equipe que resolve ("não consigo entrar, endereço inválido").
const TECNICO =
  /\bnao (consigo|consegui|estou conseguindo|to conseguindo|conseguimos) (entrar|acessar|abrir|ouvir|ver|baixar)\b|\bendereco invalido\b/;
// "Não posso falar" / "não consigo atender" sem dia: ocupado agora, não falta.
const OCUPADO_SEM_DIA = /\bnao (posso|consigo|podemos|conseguimos) (falar|atender|conversar|ficar|mexer|responder)\b/;
// Dia ou presença explícitos vencem o "agora": "fiquei sabendo agora que não
// posso fazer a ligação hoje" é falta, não ocupado no momento.
const DIA_FORTE =
  /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|comparecer|participar)\b|\bentrar n[ao] (reuniao|chamada|call|zoom|ligacao|videochamada)\b/;
const DIA_REF =
  /\b(hoje|amanha|segunda|terca|quarta|quinta|sexta|sabado|domingo|semana|horario|horarios|dia|dias|data|datas|noite|tarde)\b/;
const IMPREVISTO =
  /\b(tive|tivemos|surgiu|aconteceu|deu|houve|ouve|ocorreu|apareceu)\b(?:\s+\S+){0,3}\s+(imprevisto|emprevisto|emergencia|contratempo|intercorrencia)\b/;

/** Primeira palavra de conteúdo depois de "cancel*" decide o objeto. */
function objetoDoCancelamento(t: string): "reuniao" | "outro" | null {
  const m = t.match(/\bcancel\w*\s+(.*)$/);
  if (!m) return null;
  const palavras = m[1].split(" ").filter(Boolean).slice(0, 5);
  for (const p of palavras) {
    if (OBJETO_REUNIAO.test(p)) return "reuniao";
    if (OBJETO_OUTRO.test(p)) return "outro";
  }
  return null;
}

/**
 * Detecta pedido de remarcar/desmarcar/não comparecer no texto do lead.
 * Puro. Medido contra as 30.020 mensagens de lead da frota (H103); o teste
 * `scripts/test-remarcacao-pos-handoff.ts` guarda os casos reais.
 */
export function detectarPedidoDeRemarcacao(bruto: string): PedidoDeRemarcacao | null {
  const { proprio } = separarTextoDoLead(bruto);
  const t = normalizarTexto(proprio);
  if (!t) return null;
  if (NEGA_O_PEDIDO.test(t)) return null;

  if (DESMARCAR.test(t)) return { tipo: "desmarcar", forca: "explicito", regra: "desmarcar" };
  if (REMARCAR.test(t)) return { tipo: "remarcar", forca: "explicito", regra: "remarcar" };
  if (PEDIDO_OUTRO_DIA.test(t)) return { tipo: "remarcar", forca: "explicito", regra: "outro_dia" };
  if (MUDAR_O_HORARIO.test(t)) return { tipo: "remarcar", forca: "explicito", regra: "mudar_horario" };
  if (DEIXAR_PARA.test(t)) return { tipo: "remarcar", forca: "explicito", regra: "deixar_para" };

  if (CANCELA_AGORA.test(t) || CANCELOU.test(t)) {
    const objeto = objetoDoCancelamento(t);
    if (objeto === "reuniao") return { tipo: "desmarcar", forca: "explicito", regra: "cancelar_reuniao" };
    if (objeto === "outro") return null;
    // Sem objeto: só o pedido curto no presente ("Cancela", "vou ter que
    // cancelar"). Pergunta ("caso eu queira cancelar, como funciona?") e
    // passado solto ("eu cancelei") não são pedido.
    if (CANCELA_AGORA.test(t) && !t.includes("?") && !FALA_DE_PRODUTO.test(t) && INTENCAO_CANCELAR.test(t)) {
      return { tipo: "desmarcar", forca: "contextual", regra: "cancelar_solto" };
    }
    return null;
  }

  if (NAO_PRESENCA.test(t)) {
    if (OUTRO_ASSUNTO.test(t) || TECNICO.test(t)) return null;
    if (OCUPADO_AGORA.test(t) && !DIA_FORTE.test(t)) return null;
    if (OCUPADO_SEM_DIA.test(t) && !DIA_REF.test(t)) return null;
    if (REF_REUNIAO.test(t)) return { tipo: "nao_vai", forca: "explicito", regra: "nao_vai_com_referencia" };
    return { tipo: "nao_vai", forca: "contextual", regra: "nao_vai_solto" };
  }
  if (IMPREVISTO.test(t) && !OUTRO_ASSUNTO.test(t)) {
    return { tipo: "nao_vai", forca: "contextual", regra: "imprevisto" };
  }
  return null;
}

/** O texto fala da reunião? Usado como contexto do pedido `contextual`. */
export function falaDaReuniao(texto: string): boolean {
  return /\b(reuniao|encontro|zoom|call|chamada|ligacao|videochamada|agendad\w*|agendamento|apontamento|lembrete|confirm\w*|horario|link|consulta|compromisso)\b/.test(
    normalizarTexto(texto),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Decisões (puras)
// ─────────────────────────────────────────────────────────────────────────────

export interface EntradaPreGate {
  habilitado: boolean;
  /** `ai_paused_reason` da conversa, ou o motivo da pausa que o F52 acabou de gravar. */
  motivoPausa: string | null | undefined;
  pedido: PedidoDeRemarcacao | null;
  janelaAte: string | null | undefined;
  agora: Date;
}

export interface DecisaoPreGate {
  candidato: boolean;
  via: "pedido" | "janela" | null;
  motivo: string;
}

/**
 * Primeira trava, barata (só texto e estado): roda no gate de pausa, antes de
 * qualquer chamada ao CRM. `candidato` = vale a pena buscar a reunião.
 */
export function avaliarPreGate(e: EntradaPreGate): DecisaoPreGate {
  if (!e.habilitado) return { candidato: false, via: null, motivo: "desligado" };
  if (!pausaEhDaEquipe(e.motivoPausa)) return { candidato: false, via: null, motivo: "pausa_nao_e_da_equipe" };
  const ate = e.janelaAte ? Date.parse(e.janelaAte) : NaN;
  if (!Number.isNaN(ate) && ate > e.agora.getTime()) return { candidato: true, via: "janela", motivo: "janela_aberta" };
  if (e.pedido) return { candidato: true, via: "pedido", motivo: `pedido:${e.pedido.regra}` };
  return { candidato: false, via: null, motivo: "sem_pedido" };
}

export interface EntradaConfirmacao {
  via: "pedido" | "janela";
  pedido: PedidoDeRemarcacao | null;
  reuniao: ReuniaoFutura | null;
  /** `agent_configs.calendar_id`: a IA só move reunião do PRÓPRIO calendário. */
  calendarioDoAgente: string | null | undefined;
  /** Última mensagem de saída que NÃO foi da IA nem de automação. */
  ultimaSaidaHumanaEm: string | null;
  janelaAbertaEm: string | null | undefined;
  /** `handoff_policy.skip_if_human_replied_within_minutes` do agente (0 = padrão). */
  humanoAtivoMin: number;
  /** Texto citado, últimas saídas ou reunião em breve falam da reunião? */
  contextoFalaDaReuniao: boolean;
  agora: Date;
}

export interface DecisaoConfirmacao {
  entra: boolean;
  motivo: string;
  /** A janela aberta não vale mais (reunião sumiu ou humano retomou). */
  fecharJanela: boolean;
}

/** Segunda trava, depois de buscar a reunião e o histórico no CRM. Pura. */
export function confirmarEntrada(e: EntradaConfirmacao): DecisaoConfirmacao {
  const agora = e.agora.getTime();
  if (!e.reuniao) return { entra: false, motivo: "sem_reuniao_futura", fecharJanela: e.via === "janela" };
  if (e.calendarioDoAgente && e.reuniao.calendarId && e.reuniao.calendarId !== e.calendarioDoAgente) {
    return { entra: false, motivo: "reuniao_de_outro_calendario", fecharJanela: e.via === "janela" };
  }
  const humanoMs = e.ultimaSaidaHumanaEm ? Date.parse(e.ultimaSaidaHumanaEm) : NaN;
  if (!Number.isNaN(humanoMs)) {
    if (e.via === "janela" && e.janelaAbertaEm) {
      const abertaMs = Date.parse(e.janelaAbertaEm);
      if (!Number.isNaN(abertaMs) && humanoMs > abertaMs) {
        return { entra: false, motivo: "humano_retomou", fecharJanela: true };
      }
    }
    const janelaHumano = (e.humanoAtivoMin > 0 ? e.humanoAtivoMin : HUMANO_ATIVO_PADRAO_MIN) * 60_000;
    if (agora - humanoMs < janelaHumano) return { entra: false, motivo: "humano_ativo", fecharJanela: false };
  }
  if (e.via === "pedido" && e.pedido?.forca === "contextual" && !e.contextoFalaDaReuniao) {
    return { entra: false, motivo: "pedido_sem_contexto", fecharJanela: false };
  }
  return { entra: true, motivo: "ok", fecharJanela: false };
}

/** A reunião é nas próximas 36h? Um "não vou conseguir" solto é sobre ela. */
export function reuniaoEmBreve(reuniao: ReuniaoFutura | null, agora: Date): boolean {
  if (!reuniao) return false;
  const t = Date.parse(reuniao.startTime);
  return !Number.isNaN(t) && t - agora.getTime() <= REUNIAO_EM_BREVE_MS;
}

/**
 * No modo remarcação a IA só MOVE a reunião que existe. `book_appointment`
 * vira `reschedule_appointment` da reunião certa (o modelo às vezes usa o book
 * pro horário novo, e isso criaria uma 2ª reunião); qualquer outra ação
 * (campo, tag, funil) é descartada: a conversa é da equipe.
 */
export function restringirAcoes(
  actions: AIAction[] | null | undefined,
  reuniao: Pick<ReuniaoFutura, "id" | "calendarId">,
): { acoes: AIAction[]; descartadas: string[] } {
  const acoes: AIAction[] = [];
  const descartadas: string[] = [];
  for (const a of actions || []) {
    const ehAgenda = a.type === "reschedule_appointment" || a.type === "book_appointment";
    if (ehAgenda && a.start_time && acoes.length === 0) {
      acoes.push({
        ...a,
        type: "reschedule_appointment",
        appointment_id: reuniao.id,
        calendar_id: reuniao.calendarId || a.calendar_id,
      });
    } else {
      descartadas.push(a.type);
    }
  }
  return { acoes, descartadas };
}

// ─────────────────────────────────────────────────────────────────────────────
// Texto pro modelo e pra equipe
// ─────────────────────────────────────────────────────────────────────────────

export function rotuloFuso(tz: string): string {
  return tz === "America/New_York" ? "horário do leste" : tz;
}

/** "quinta-feira, 15/10 às 15:00", no fuso da conta. Determinístico (escola H50). */
export function rotuloReuniao(startIso: string, tz: string): string {
  const d = new Date(startIso);
  if (Number.isNaN(d.getTime())) return startIso;
  const dia = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, weekday: "long" }).format(d);
  const data = new Intl.DateTimeFormat("pt-BR", { timeZone: tz, day: "2-digit", month: "2-digit" }).format(d);
  const hora = new Intl.DateTimeFormat("pt-BR", {
    timeZone: tz,
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(d);
  return `${dia}, ${data} às ${hora}`;
}

export interface ModoRemarcacao {
  via: "pedido" | "janela";
  tipo: TipoPedidoRemarcacao | null;
  reuniao: ReuniaoFutura;
  rotulo: string;
  fuso: string;
}

/**
 * Bloco do runtime context no turno de remarcação. Vai por ÚLTIMO, perto da
 * mensagem do lead: é a instrução que manda neste turno, acima do fluxo de
 * qualificação das instruções do administrador.
 */
export function secaoModoRemarcacao(m: ModoRemarcacao): string {
  const id = m.reuniao.id;
  const cal = m.reuniao.calendarId;
  return `### MODO REMARCAÇÃO (vale acima de tudo neste turno)
A equipe assumiu esta conversa e você está em silêncio. Você só voltou porque o lead pode estar pedindo pra remarcar ou desmarcar a reunião dele. Fora disso, quem responde é a equipe.

Reunião marcada: ${m.rotulo} (${m.fuso}). appointment_id: "${id}". calendar_id: "${cal}".

Faça SÓ isto:
1. A mensagem do lead NÃO é sobre não poder ir, remarcar ou desmarcar esta reunião (outro assunto, dúvida, preço, documento, conversa com a equipe)? Fique em silêncio: "should_send_message": false e "message": "". Sem explicar nada.
2. Ele não pode ir ou quer outro horário: diga em 1 frase que tudo bem e ofereça 2 horários da lista HORÁRIOS DISPONÍVEIS, com dia da semana, data e hora como estão na lista (${m.fuso}). Sem action neste turno.
3. Ele escolheu um horário da lista: action "reschedule_appointment" com appointment_id "${id}", calendar_id "${cal}" e o start_time do horário escolhido. Confirme em 1 balão com dia da semana, data e hora (${m.fuso}) e conversation_status "booked". NUNCA use book_appointment: é sempre mover a reunião que já existe.
4. Ele quer desmarcar sem remarcar: ofereça remarcar 1 vez. Se ele confirmar que não quer, agradeça em 1 frase, diga que a equipe fica sabendo e use conversation_status "handed_off". Não tente convencer.
5. Não puxe outro assunto, não faça perguntas de qualificação, não fale de preço nem de produto, não se apresente. No máximo 2 balões curtos.`;
}

/**
 * Substitui as regras 1 e 2 do formato de resposta no turno de remarcação: o
 * resto do sistema exige mensagem sempre, e aqui o silêncio é a resposta certa
 * quando a mensagem não é sobre a reunião.
 */
export const REGRA_FORMATO_MODO_REMARCACAO = `1. "message": string curta ou array de no máximo 2 bolhas curtas. PODE ser "" quando você ficar em silêncio (veja a regra 2).
2. "should_send_message": NESTE TURNO você está no MODO REMARCAÇÃO. Use false (com "message": "") quando a mensagem do lead não for sobre não poder ir, remarcar ou desmarcar a reunião. Nos outros casos, true.`;

// ─────────────────────────────────────────────────────────────────────────────
// Leitura do histórico (pura sobre o que o processor já buscou)
// ─────────────────────────────────────────────────────────────────────────────

export interface MensagemDoHistorico extends LastOutboundForClassify {
  direction?: string;
  messageType?: string;
}

/**
 * Instante da última saída HUMANA da conversa: percorre as saídas de chat da
 * mais nova pra mais velha e usa o MESMO classificador do F52 (eco da IA por id
 * e texto, automação, merge field quebrado, mídia nossa).
 */
export function ultimaSaidaHumanaEm(
  mensagens: MensagemDoHistorico[],
  ia: { textos: string[]; ids: string[]; midiaNossaEm?: string[] },
): string | null {
  const saidas = mensagens
    .filter((m) => m.direction === "outbound" && isChatMessageType(m.messageType))
    .sort((a, b) => Date.parse(String(b.dateAdded)) - Date.parse(String(a.dateAdded)));
  for (const m of saidas) {
    const { isHuman } = classifyLastOutbound({
      lastOutbound: m,
      aiTexts: ia.textos,
      sentIds: ia.ids,
      ourMediaAtIso: ia.midiaNossaEm,
    });
    if (isHuman) return m.dateAdded ? String(m.dateAdded) : null;
  }
  return null;
}

/** Corpo das últimas saídas de chat (qualquer remetente) das últimas 72h. */
export function ultimasSaidas(mensagens: MensagemDoHistorico[], agora: Date, n = 2): string[] {
  const limite = agora.getTime() - 72 * 60 * 60 * 1000;
  return mensagens
    .filter(
      (m) =>
        m.direction === "outbound" &&
        isChatMessageType(m.messageType) &&
        Date.parse(String(m.dateAdded)) >= limite,
    )
    .sort((a, b) => Date.parse(String(b.dateAdded)) - Date.parse(String(a.dateAdded)))
    .slice(0, n)
    .map((m) => String(m.body || ""));
}

/** Texto da nota interna no contato (vai pro CRM, a equipe lê no painel). */
export function textoDaNota(p: {
  agente: string;
  evento: "pedido" | "remarcada" | "desmarcar";
  rotuloAntes: string;
  rotuloDepois?: string | null;
  fuso: string;
  mensagemDoLead?: string | null;
}): string {
  const fala = (p.mensagemDoLead || "").trim().slice(0, 300);
  const citacao = fala ? `\nMensagem do lead: "${fala}"` : "";
  if (p.evento === "remarcada") {
    return `🤖 ${p.agente} (remarcação): reunião remarcada a pedido do lead.\nEra: ${p.rotuloAntes} (${p.fuso})\nAgora: ${p.rotuloDepois} (${p.fuso})${citacao}\nA conversa segue com a equipe; a IA voltou a ficar em silêncio.`;
  }
  if (p.evento === "desmarcar") {
    return `🤖 ${p.agente} (remarcação): o lead não vai à reunião de ${p.rotuloAntes} (${p.fuso}) e não quis remarcar agora. A reunião continua na agenda: cancelar ou retomar fica com a equipe.${citacao}`;
  }
  return `🤖 ${p.agente} (remarcação): o lead pediu pra remarcar a reunião de ${p.rotuloAntes} (${p.fuso}). Como a equipe tinha assumido, a IA voltou só pra isso e ofereceu novos horários.${citacao}`;
}

const MARCADOR_SILENCIO = /\[\[\s*N[AÃ]O_ENVIAR\s*\]\]/gi;

/**
 * Ajusta a resposta do modelo pro turno de remarcação, antes do executor.
 *  - ações: só o reagendamento da reunião certa (`restringirAcoes`);
 *  - dados coletados: nenhum (a conversa é da equipe, nada vai pro CRM);
 *  - silêncio: o modelo pediu (flag ou marcador) ou não escreveu nada, e não há
 *    reagendamento. No modo normal o vazio vira "Pode me contar mais sobre
 *    isso?"; aqui seria a IA falando sem motivo numa conversa da equipe;
 *  - reagendou sem texto: confirmação mínima, que a guarda C7 do executor
 *    completa com dia e hora reais.
 */
export function prepararRespostaDaRemarcacao(
  resp: { message: string | string[]; should_send_message?: boolean; actions?: AIAction[] | null },
  reuniao: Pick<ReuniaoFutura, "id" | "calendarId">,
): { message: string[]; actions: AIAction[]; descartadas: string[]; silencio: boolean } {
  const { acoes, descartadas } = restringirAcoes(resp.actions, reuniao);
  const brutas = Array.isArray(resp.message) ? resp.message : [resp.message];
  const temMarcador = brutas.some((m) => {
    MARCADOR_SILENCIO.lastIndex = 0;
    return MARCADOR_SILENCIO.test(String(m ?? ""));
  });
  const bolhas = brutas
    .map((m) => String(m ?? "").replace(MARCADOR_SILENCIO, "").trim())
    .filter((m) => m.length > 0);
  if (acoes.length > 0) {
    return {
      message: bolhas.length > 0 ? bolhas : ["Pronto, remarquei sua reunião."],
      actions: acoes,
      descartadas,
      silencio: false,
    };
  }
  const silencio = resp.should_send_message === false || temMarcador || bolhas.length === 0;
  return { message: silencio ? [] : bolhas, actions: [], descartadas, silencio };
}
