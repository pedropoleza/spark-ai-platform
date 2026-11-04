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
 */

import type { AIResponse, AIAction } from "@/types/ai";
import { conferirOfertasDeHorario, ofertaDeterministica } from "@/lib/queue/slot-offer-guard";
import {
  detectarFusoNoTexto,
  diferencaMinutos,
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
  correcoes: string[];
  invalidas: Array<{ bolha: number; trecho: string }>;
  fusoErrado: FusoErrado | null;
}

/**
 * O erro clássico do fuso: o lead disse "2 PM de Austin" e o agendamento caiu
 * às 2 PM do fuso da LISTA (ET), não às 2 PM do fuso DELE. Só acusa quando a
 * hora agendada bate com o número que o lead disse lido no fuso da lista e NÃO
 * bate lido no fuso dele: nada de falso positivo com outras horas da mensagem.
 */
function fusoDoAgendamento(r: AIResponse, input: AgendaGuardInput): FusoErrado | null {
  const fuso = detectarFusoNoTexto(input.mensagemDoLead);
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
  const msgs = bolhas(r);
  let messages = msgs;
  let correcoes: string[] = [];
  let invalidas: Array<{ bolha: number; trecho: string }> = [];
  const agendando = acoesDeAgenda(r).length > 0;
  if (input.slotsIso !== undefined && (!input.pularOferta || agendando)) {
    const g = conferirOfertasDeHorario(msgs, input.slotsIso, input.fusoLista, {
      fusoLead: input.fusoLead,
      agora: input.agora,
    });
    messages = g.messages;
    correcoes = g.correcoes;
    invalidas = g.invalidas;
  }
  return { messages, correcoes, invalidas, fusoErrado: fusoDoAgendamento(r, input) };
}

/** A hora que o lead disse, no fuso dele, convertida para o fuso da lista. */
function convertida(f: FusoErrado, fusoLista: string, agora: Date): { h: number; min: number } {
  const total = f.h * 60 + f.min + diferencaMinutos(f.tzLead, fusoLista, agora);
  const t = ((total % 1440) + 1440) % 1440;
  return { h: Math.floor(t / 60), min: t % 60 };
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
  if (diag.correcoes.length > 0) notas.push(...diag.correcoes.map((c) => `oferta: ${c}`));
  resposta.message = diag.messages;

  let regenerou = false;
  if (diag.invalidas.length > 0 || diag.fusoErrado) {
    const partes: string[] = [];
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
    const nova = await input.regenerar(`[SISTEMA: ${partes.join(" ")} Mesmo formato JSON.]`);
    if (nova) {
      regenerou = true;
      const d2 = diagnosticar(nova, input);
      notas.push(`refeito: ${diag.invalidas.length} oferta(s) inválida(s)${diag.fusoErrado ? " + fuso do agendamento" : ""}`);
      resposta = { ...nova, message: d2.messages };
      if (d2.correcoes.length > 0) notas.push(...d2.correcoes.map((c) => `oferta (refeito): ${c}`));
      diag = d2;
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

  return {
    resposta,
    notas,
    regenerou,
    ofertaSubstituida,
    agendamentoRetirado,
    ofertasInvalidas: diag.invalidas.map((i) => i.trecho),
  };
}
