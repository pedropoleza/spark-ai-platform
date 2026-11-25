/**
 * Guardas de agenda do turno lead-facing, aplicadas na resposta do modelo ANTES
 * de executar ações e enviar (H115, caso Alves Cury 03/11/2026). Compartilhado
 * entre o queue-processor e o laboratório (/api/agents/test), para o teste
 * medir o mesmo que roda em produção.
 *
 * 1. Oferta de horário: cada "dia + hora" do texto tem que existir na agenda do
 *    turno (ver slot-offer-guard.ts). Data errada com o dia da semana certo é
 *    corrigida na hora; oferta inventada faz o turno ser refeito 1 vez com a
 *    lista; se insistir, a bolha vira a oferta determinística (ou a frase sai,
 *    quando o turno não tem horário nenhum).
 * 2. Fuso no agendamento: se o lead disse a hora junto do fuso, estado ou
 *    cidade dele ("sexta 2 PM DE AUSTIN"), o start_time do book/reschedule tem
 *    que cair nessa hora NAQUELE fuso. Senão, refaz 1 vez explicando a
 *    conversão; se insistir, NÃO agenda e pergunta ao lead confirmando os dois
 *    fusos. Agendar errado é pior que confirmar.
 * 3. Conversão de fuso na oferta (H130, chamado 548): "X no seu horário (Y ET)" é
 *    conferido par a par e corrigido (ver conversao-fuso-guard.ts), antes de 1.
 * 4. Mover reunião (H129, chamado 527): quem já tem reunião marcada só tem a
 *    agenda mexida quando ELE escolheu o horário novo (escolha-de-horario.ts). Sem
 *    escolha a ação sai do turno; se o texto afirma a mudança, refaz 1 vez e, se
 *    insistir, vira pergunta.
 */

import type { AIResponse, AIAction } from "@/types/ai";
import { conferirConversaoDeFuso } from "@/lib/queue/conversao-fuso-guard";
import { falaDeRecusa, horasDitas, leadEscolheuHorario, normalizarFala, type FalaAnterior } from "@/lib/queue/escolha-de-horario";
import { lerDatas } from "@/lib/queue/datas-lead";
import { conferirOfertasDeHorario, ofertaDeterministica } from "@/lib/queue/slot-offer-guard";
import {
  diferencaMinutos,
  fusoNaFalaDoLead,
  lugarNaFalaDoLead,
  horaEmIngles,
  horaFalada,
  horaMinutoNoFuso,
  horariosCitados,
  mesmoFuso,
  nomeDoFuso,
  siglaDoFuso,
} from "@/lib/queue/lead-timezone";
import { rotuloDoSlot } from "@/lib/queue/lead-day-guard";

export interface AgendaGuardInput {
  resposta: AIResponse;
  /** Horários reais do turno (ISO). undefined = agente sem agenda: nada a conferir. */
  slotsIso: string[] | undefined;
  /** Fuso em que a lista foi gerada (o da conta). */
  fusoLista: string;
  /** Fuso do lead, quando conhecido. */
  fusoLead: string | null;
  /** O que o lead escreveu neste turno (vazio em turno proativo). */
  mensagemDoLead: string;
  /** Conversa já agendada e o turno não reagenda: não confere oferta (citar a reunião marcada é legítimo). */
  pularOferta: boolean;
  preferirTardeNoite?: boolean;
  agora?: Date;
  /**
   * H129: reunião FUTURA do lead, a que uma ação de agenda moveria. Só é consultada
   * quando o turno traz ação de agenda. Ausente = guarda 4 desligada.
   */
  reuniaoMarcada?: () => Promise<{ inicioIso: string } | null>;
  /** O que saiu para o lead antes deste turno, da mais nova para a mais velha. */
  falasAnteriores?: readonly FalaAnterior[];
  /** Mensagem nossa que o lead citou ao responder. */
  citadoPeloLead?: string;
  /** Refaz o turno com uma diretiva extra; null = falhou. */
  regenerar: (diretiva: string) => Promise<AIResponse | null>;
}

export interface AgendaGuardResult {
  resposta: AIResponse;
  notas: string[];
  regenerou: boolean;
  /** Oferta trocada pela determinística ou frase removida. */
  ofertaSubstituida: boolean;
  /** Agendamento retirado porque o fuso não batia. */
  agendamentoRetirado: boolean;
  /** H129: reunião que ia ser movida sem o lead escolher (a ação saiu do turno). */
  movimentoRetirado: { reuniao: string; tentou: string[] } | null;
  ofertasInvalidas: string[];
}

function bolhas(r: AIResponse): string[] {
  if (Array.isArray(r.message)) return r.message.filter((m): m is string => typeof m === "string");
  return r.message ? [String(r.message)] : [];
}

function acoesDeAgenda(r: AIResponse): AIAction[] {
  return (r.actions || []).filter((a) => (a.type === "book_appointment" || a.type === "reschedule_appointment") && !!a.start_time);
}

interface FusoErrado {
  acao: AIAction;
  /** Fuso do lead (o que ele citou) e a hora que ele disse. */
  tzLead: string;
  origem: string;
  h: number;
  min: number;
  trecho: string;
}

interface Diagnostico {
  messages: string[];
  /** Conversões de fuso corrigidas no texto (H130). */
  conversoes: string[];
  correcoes: string[];
  invalidas: Array<{ bolha: number; trecho: string }>;
  fusoErrado: FusoErrado | null;
  /** Horários válidos oferecidos de MANHÃ no fuso do lead, quando ele não pediu manhã. */
  manhaDoLead: string[];
}

/**
 * O erro clássico do fuso: o lead disse "2 PM de Austin" e o agendamento caiu
 * às 2 PM do fuso da LISTA (ET), não às 2 PM do fuso DELE. Só acusa quando a
 * hora agendada bate com o número que o lead disse lido no fuso da lista e NÃO
 * bate lido no fuso dele: nada de falso positivo com outras horas da mensagem.
 */
function fusoDoAgendamento(r: AIResponse, input: AgendaGuardInput): FusoErrado | null {
  const fuso = fusoNaFalaDoLead(input.mensagemDoLead);
  if (!fuso || mesmoFuso(fuso.tz, input.fusoLista, input.agora ?? new Date())) return null;
  const horas = horariosCitados(input.mensagemDoLead);
  if (horas.length === 0) return null;
  for (const acao of acoesDeAgenda(r)) {
    const noLead = horaMinutoNoFuso(acao.start_time!, fuso.tz);
    const naLista = horaMinutoNoFuso(acao.start_time!, input.fusoLista);
    if (!noLead || !naLista) continue;
    const bateNoLead = horas.some((x) => x.leituras.includes(noLead.h) && x.min === noLead.min);
    const citada = horas.find((x) => x.leituras.includes(naLista.h) && x.min === naLista.min);
    if (!bateNoLead && citada) {
      return { acao, tzLead: fuso.tz, origem: fuso.origem, h: naLista.h, min: naLista.min, trecho: citada.trecho };
    }
  }
  return null;
}

function diagnosticar(r: AIResponse, input: AgendaGuardInput): Diagnostico {
  // O cadastro diz um estado e o lead acabou de citar outro: na dúvida não se afirma conversão.
  const lugar = lugarNaFalaDoLead(input.mensagemDoLead);
  const fusoEmDuvida = !!lugar && !!input.fusoLead && !mesmoFuso(lugar.tz, input.fusoLead, input.agora ?? new Date());
  const fuso = conferirConversaoDeFuso(bolhas(r), {
    fusoLista: input.fusoLista,
    fusoLead: fusoEmDuvida ? null : input.fusoLead,
    slotsIso: input.slotsIso,
    agora: input.agora,
  });
  const msgs = fuso.messages;
  let messages = msgs;
  let correcoes: string[] = [];
  let invalidas: Array<{ bolha: number; trecho: string }> = [];
  let manhaDoLead: string[] = [];
  const agendando = acoesDeAgenda(r).length > 0;
  if (input.slotsIso !== undefined && (!input.pularOferta || agendando)) {
    const g = conferirOfertasDeHorario(msgs, input.slotsIso, input.fusoLista, {
      fusoLead: input.fusoLead,
      agora: input.agora,
    });
    messages = g.messages;
    correcoes = g.correcoes;
    invalidas = g.invalidas;
    // H121 (laboratório 04/11, lead da Califórnia): "tarde ou noite" vale no relógio
    // do LEAD. Oferta de manhã no fuso dele, sem ele ter pedido manhã, refaz 1x.
    const pediuManha = /manh[ãa]|cedo|am|\d\s*a\.?m\.?/i.test(input.mensagemDoLead || "");
    if (input.preferirTardeNoite && input.fusoLead && !pediuManha && !agendando) {
      manhaDoLead = g.validas.filter((iso) => (horaMinutoNoFuso(iso, input.fusoLead!)?.h ?? 12) < 12);
    }
  }
  return { messages, conversoes: fuso.correcoes, correcoes, invalidas, fusoErrado: fusoDoAgendamento(r, input), manhaDoLead };
}

/** A hora que o lead disse, no fuso dele, convertida para o fuso da lista. */
function convertida(f: FusoErrado, fusoLista: string, agora: Date): { h: number; min: number } {
  const total = f.h * 60 + f.min + diferencaMinutos(f.tzLead, fusoLista, agora);
  const t = ((total % 1440) + 1440) % 1440;
  return { h: Math.floor(t / 60), min: t % 60 };
}

// ---------------------------------------------------------------------------
// H129: mover reunião sem o lead escolher
// ---------------------------------------------------------------------------

interface MoverSemEscolha {
  acoes: AIAction[];
  reuniaoIso: string;
}

/** Mesmo relógio de parede no fuso da conta (o offset do modelo não vale, H66). */
function mesmoHorarioDaConta(startIso: string, reuniaoIso: string, tz: string): boolean {
  const w = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(startIso);
  const d = new Date(reuniaoIso);
  if (!w || isNaN(d.getTime())) return false;
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => p.find((x) => x.type === t)?.value || "";
  return w[1] === `${g("year")}-${g("month")}-${g("day")}` && w[2] === `${g("hour")}:${g("minute")}`;
}

/**
 * Ações de agenda que moveriam a reunião existente para um horário que o lead não
 * escolheu. Repetir o horário que ele já tem não move nada e passa.
 */
async function moverSemEscolha(
  r: AIResponse,
  input: AgendaGuardInput,
  reuniao: () => Promise<{ inicioIso: string } | null>,
): Promise<MoverSemEscolha | null> {
  const acoes = acoesDeAgenda(r);
  if (acoes.length === 0) return null;
  const marcada = await reuniao();
  if (!marcada) return null;
  const ruins = acoes.filter(
    (a) =>
      !mesmoHorarioDaConta(a.start_time!, marcada.inicioIso, input.fusoLista) &&
      !leadEscolheuHorario({
        mensagem: input.mensagemDoLead,
        citado: input.citadoPeloLead,
        startIso: a.start_time!,
        fusoLista: input.fusoLista,
        fusoLead: input.fusoLead,
        falasAnteriores: input.falasAnteriores || [],
        slotsIso: input.slotsIso,
        reuniaoIso: marcada.inicioIso,
        agora: input.agora ?? new Date(),
      }).escolheu,
  );
  return ruins.length > 0 ? { acoes: ruins, reuniaoIso: marcada.inicioIso } : null;
}

const RE_AFIRMA_MUDANCA =
  /(?<![\p{L}])(?:fechad[oa]|fechei|remarquei|reagendei|remarcad[oa]|reagendad[oa]|remarco|reagendo|agendad[oa]|marcad[oa]|confirmad[oa]|confirmei|agendei|agendando|marquei|mudei|transferi|adiei|ficou|fica\s+(?:para|pra)|vou\s+(?:remarcar|reagendar|confirmar|agendar|registrar|passar|mudar|marcar)|prontinho|te\s+(?:coloco|reagendo|remarco))(?![\p{L}])/iu;

function frasesDe(b: string): string[] {
  return b.match(/[^.!?\n]+[.!?]*/g) || [];
}

const citaHorario = (b: string) => lerDatas(b).length > 0 || horasDitas(normalizarFala(b)).length > 0;

/** Alguma frase (que não é pergunta) dá a mudança como feita? */
function afirmaMudanca(bs: readonly string[]): boolean {
  if (bs.some((b) => frasesDe(b).some((f) => !f.includes("?") && RE_AFIRMA_MUDANCA.test(f)))) return true;
  return !bs.some((b) => b.includes("?")) && bs.some(citaHorario);
}

/** Troca as bolhas que afirmam a mudança pela pergunta; as outras ficam. */
function perguntarNoLugar(bs: readonly string[], pergunta: string): string[] {
  const out: string[] = [];
  let posta = false;
  for (const b of bs) {
    if (!afirmaMudanca([b]) && !(citaHorario(b) && !b.includes("?"))) {
      out.push(b);
      continue;
    }
    if (!posta) out.push(pergunta);
    posta = true;
  }
  if (!posta) out.push(pergunta);
  return out;
}

function opcoesReais(input: AgendaGuardInput, max = 6): string {
  const agora = input.agora ?? new Date();
  const futuros = (input.slotsIso || []).filter((s) => Date.parse(s) > agora.getTime()).sort((a, b) => Date.parse(a) - Date.parse(b));
  const porDia = new Map<string, string[]>();
  for (const iso of futuros) {
    const r = rotuloDoSlot(iso, input.fusoLista);
    if (!r) continue;
    const [dia, hora] = r.split(", às ");
    const lista = porDia.get(dia) || [];
    if (lista.length < 4) lista.push(hora);
    porDia.set(dia, lista);
    if (porDia.size > max) break;
  }
  return [...porDia.entries()].slice(0, max).map(([d, hs]) => `${d}: ${hs.join(", ")}`).join("; ");
}

export async function aplicarGuardasDeAgenda(input: AgendaGuardInput): Promise<AgendaGuardResult> {
  const notas: string[] = [];
  let resposta: AIResponse = { ...input.resposta };
  let diag = diagnosticar(resposta, input);
  if (diag.conversoes.length > 0) notas.push(...diag.conversoes.map((c) => `fuso: ${c}`));
  if (diag.correcoes.length > 0) notas.push(...diag.correcoes.map((c) => `oferta: ${c}`));
  resposta.message = diag.messages;

  // H129: a reunião é buscada no máximo 1 vez por turno, e só se houver ação de agenda.
  let reuniaoMemo: Promise<{ inicioIso: string } | null> | null = null;
  const reuniao = () => (reuniaoMemo ??= input.reuniaoMarcada ? input.reuniaoMarcada().catch(() => null) : Promise.resolve(null));
  const rotulo = (iso: string) => `${rotuloDoSlot(iso, input.fusoLista) ?? iso} ${siglaDoFuso(input.fusoLista)}`;
  const recusou = falaDeRecusa(input.mensagemDoLead);
  let mover = await moverSemEscolha(resposta, input, reuniao);
  const moverInicial = mover;
  const tirarMovimento = () => {
    if (!mover) return;
    const ruins = new Set(mover.acoes);
    resposta.actions = (resposta.actions || []).filter((x) => !ruins.has(x));
    if (recusou && resposta.conversation_status === "booked") resposta.conversation_status = "active";
  };
  // O texto já pergunta ou oferece (só a ação estava errada): a ação sai e o texto fica.
  if (mover && !afirmaMudanca(bolhas(resposta))) {
    tirarMovimento();
    notas.push("reunião não movida: o lead não escolheu o horário (a ação saiu, o texto já perguntava)");
    mover = null;
  }

  let regenerou = false;
  if (diag.invalidas.length > 0 || diag.fusoErrado || diag.manhaDoLead.length > 0 || mover) {
    const partes: string[] = [];
    if (diag.manhaDoLead.length > 0 && diag.invalidas.length === 0) {
      partes.push(
        `você ofereceu horário de MANHÃ no horário do lead (${diag.manhaDoLead.length} opção ou opções). Ofereça 2 horários de TARDE ou NOITE no horário DELE (o que está entre parênteses na lista), sem pedir preferência.`,
      );
    }
    if (diag.invalidas.length > 0) {
      const semHorario = (input.slotsIso || []).length === 0;
      partes.push(
        semHorario
          ? `você citou dia e hora ("${diag.invalidas.map((i) => i.trecho).join('", "')}"), mas NESTE turno não há horário liberado na agenda. NÃO cite dia nem hora; siga as instruções sobre o próximo passo.`
          : `você ofereceu horário que NÃO existe na agenda: "${diag.invalidas.map((i) => i.trecho).join('", "')}". Ofereça SOMENTE horários da lista HORÁRIOS DISPONÍVEIS, copiando dia da semana, data e hora exatamente. Horários reais: ${opcoesReais(input)}.`,
      );
    }
    if (diag.fusoErrado) {
      const f = diag.fusoErrado;
      const c = convertida(f, input.fusoLista, input.agora ?? new Date());
      partes.push(
        `o lead pediu "${f.trecho}" no fuso DELE (${f.origem}, ${siglaDoFuso(f.tzLead)}), que é ${horaEmIngles(c.h, c.min)} ${siglaDoFuso(input.fusoLista)}. O seu agendamento caiu em ${horaEmIngles(f.h, f.min)} ${siglaDoFuso(input.fusoLista)}, uma hora diferente. Agende ${horaEmIngles(c.h, c.min)} ${siglaDoFuso(input.fusoLista)} se estiver na lista; se não estiver, diga que esse horário não está livre e ofereça os mais próximos. Ao confirmar, fale no horário do lead com o ${siglaDoFuso(input.fusoLista)} entre parênteses.`,
      );
    }
    if (mover) {
      partes.push(
        `o lead tem reunião marcada para ${rotulo(mover.reuniaoIso)} e NÃO escolheu outro horário: quem escolheu ${mover.acoes.map((a) => rotulo(a.start_time!)).join(" e ")} foi você. NESTE turno NÃO mexa na agenda: sem reschedule_appointment, sem book_appointment, e sem dizer que remarcou, fechou, agendou ou confirmou. ${
          recusou
            ? "Ele avisou que não vai ou não pode: diga em 1 frase que tudo bem e pergunte se prefere outro dia ou se quer deixar para depois."
            : "Responda o que ele disse e, se ele quiser mudar, pergunte o dia e a hora."
        } Se oferecer horário, no máximo 2 da lista e como PERGUNTA. A agenda só muda quando ele disser qual horário quer.`,
      );
    }
    const nova = await input.regenerar(`[SISTEMA: ${partes.join(" ")} Mesmo formato JSON.]`);
    if (nova) {
      regenerou = true;
      const d2 = diagnosticar(nova, input);
      notas.push(
        `refeito: ${diag.invalidas.length} oferta(s) inválida(s)${diag.fusoErrado ? " + fuso do agendamento" : ""}${diag.manhaDoLead.length ? " + manhã no horário do lead" : ""}${mover ? " + reunião movida sem o lead escolher" : ""}`,
      );
      resposta = { ...nova, message: d2.messages };
      if (d2.conversoes.length > 0) notas.push(...d2.conversoes.map((c) => `fuso (refeito): ${c}`));
      if (d2.correcoes.length > 0) notas.push(...d2.correcoes.map((c) => `oferta (refeito): ${c}`));
      diag = d2;
      mover = await moverSemEscolha(resposta, input, reuniao);
    }
  }

  // Fallback determinístico do que sobrou.
  let ofertaSubstituida = false;
  let agendamentoRetirado = false;
  const msgs = bolhas(resposta);
  if (diag.invalidas.length > 0) {
    const ruins = new Set(diag.invalidas.map((i) => i.bolha));
    const oferta =
      (input.slotsIso || []).length > 0
        ? ofertaDeterministica(input.slotsIso!, input.fusoLista, {
            fusoLead: input.fusoLead,
            agora: input.agora,
            preferirTardeNoite: input.preferirTardeNoite,
          })
        : null;
    const novas: string[] = [];
    let ofertaPosta = false;
    msgs.forEach((b, i) => {
      if (!ruins.has(i)) return novas.push(b);
      if (oferta) {
        if (!ofertaPosta) novas.push(oferta);
        ofertaPosta = true;
        return;
      }
      // sem horário no turno: tira só as frases que citam o horário
      const frases = b.split(/(?<=[.!?])\s+/).filter((f) => !diag.invalidas.some((x) => x.bolha === i && f.includes(x.trecho.slice(0, 12))));
      const resto = frases.join(" ").trim();
      if (resto) novas.push(resto);
    });
    resposta.message = novas.length > 0 ? novas : msgs;
    ofertaSubstituida = true;
    notas.push(`oferta inválida mantida após refazer: ${oferta ? "trocada pela oferta determinística" : "frase com horário removida"}`);
    // oferta inventada + agendamento no mesmo turno: o slot-guard do executor decide o agendamento.
  }
  if (diag.fusoErrado) {
    const f = diag.fusoErrado;
    const c = convertida(f, input.fusoLista, input.agora ?? new Date());
    resposta.actions = (resposta.actions || []).filter((x) => x !== f.acao);
    resposta.message = [
      `Só para eu marcar certinho: ${f.trecho} no seu horário (${f.origem}) é ${horaFalada(c.h, c.min)} no ${nomeDoFuso(input.fusoLista)}. Posso confirmar nesse horário?`,
    ];
    if (resposta.conversation_status === "booked") resposta.conversation_status = "active";
    agendamentoRetirado = true;
    notas.push("agendamento retirado: o fuso não batia com o horário que o lead disse");
  }
  // H129: insistiu em mover (ou refez sem a ação, mas com "fechado para sexta"): a
  // ação sai e a afirmação vira pergunta.
  if (moverInicial && (mover || (regenerou && acoesDeAgenda(resposta).length === 0 && afirmaMudanca(bolhas(resposta))))) {
    const insistiu = !!mover;
    tirarMovimento();
    const pergunta = recusou
      ? "Você prefere que eu veja outro dia para a nossa conversa ou quer deixar para depois?"
      : `Antes de mexer na sua reunião de ${rotulo(moverInicial.reuniaoIso)}: qual dia e horário ficam melhores para você?`;
    if (afirmaMudanca(bolhas(resposta))) resposta.message = perguntarNoLugar(bolhas(resposta), pergunta);
    notas.push(
      insistiu
        ? "reunião não movida: o lead não escolheu o horário (ação retirada e pergunta no lugar)"
        : "reunião não movida: o texto refeito ainda afirmava a mudança (pergunta no lugar)",
    );
  }

  return {
    resposta,
    notas,
    regenerou,
    ofertaSubstituida,
    agendamentoRetirado,
    movimentoRetirado: moverInicial
      ? { reuniao: moverInicial.reuniaoIso, tentou: moverInicial.acoes.map((a) => String(a.start_time)) }
      : null,
    ofertasInvalidas: diag.invalidas.map((i) => i.trecho),
  };
}
