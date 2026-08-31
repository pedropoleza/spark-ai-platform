/**
 * Guarda determinística de DATA no texto lead-facing (caso Alves Cury, 2026-08-31).
 *
 * Dois passes, mesma escola do H50/H85 ("o nome do dia é derivável da data —
 * quem produz é o código, nunca o modelo"):
 *
 *  1. `fixWeekdayDatePairs` (H85, reuso): par "dia-da-semana + data" com o nome
 *     do dia errado é corrigido PELA data ("amanhã, quinta 28/08" → "amanhã,
 *     sexta 28/08"). O modelo mapeia dia↔data pelo calendário do ano de treino
 *     (H68); medido 7/84 nos lead-facing.
 *
 *  2. Rótulo RELATIVO ("hoje"/"amanhã"/"depois de amanhã") colado em horário:
 *     - com data/dia explícito ao lado que NÃO bate com o rótulo → o rótulo é
 *       REMOVIDO ("amanhã, sexta 28/08" dito NA sexta 28/08 → "sexta 28/08").
 *       A data é a âncora; o rótulo relativo errado é o que já saiu errado em
 *       produção (bateria v3 17/08 + envio real de 27/08).
 *     - SEM data ao lado (só horário: "hoje às 7 da noite") → vira ABSOLUTO
 *       ("quinta-feira, 27/08, às 7 da noite"). O follow-up recicla texto de
 *       horas atrás; o absoluto nunca envelhece.
 *     - "amanhã" conversacional sem horário por perto fica em paz ("a gente se
 *       fala amanhã" é verdadeiro no momento do envio).
 *
 * Puro e testável (sem I/O). Fuso via Intl; aritmética de dias no CALENDÁRIO
 * (Date.UTC), imune a DST.
 */

import { fixWeekdayDatePairs } from "@/lib/account-assistant/weekday-text-guard";
import { weekdayNamePt, parseWeekdayPt } from "@/lib/account-assistant/weekday-guard";

interface Ymd {
  y: number;
  m: number;
  d: number;
}

/** {y,m,d} de HOJE no fuso dado (calendário local, não UTC). */
function hojeNoFuso(now: Date, tz: string): Ymd | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "", 10);
    const y = get("year");
    const m = get("month");
    const d = get("day");
    if (isNaN(y) || isNaN(m) || isNaN(d)) return null;
    return { y, m, d };
  } catch {
    return null;
  }
}

/** Soma dias no plano do CALENDÁRIO (não do relógio) — imune a DST. */
function somarDias(ymd: Ymd, n: number): Ymd {
  const dt = new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function weekdayDeYmd(ymd: Ymd): number {
  return new Date(Date.UTC(ymd.y, ymd.m - 1, ymd.d)).getUTCDay();
}

/** "quinta-feira, 27/08" — rótulo absoluto que substitui o relativo. */
function rotuloAbsoluto(ymd: Ymd): string {
  const nome = weekdayNamePt(weekdayDeYmd(ymd));
  return `${nome}, ${String(ymd.d).padStart(2, "0")}/${String(ymd.m).padStart(2, "0")}`;
}

// ⚠️ \b do JS é ASCII-only: depois de "ã" ele NUNCA casa ("amanhã\b" falha
// sempre). Lookarounds unicode no lugar — pego no replay do corpus real.
const RE_RELATIVO =
  /(?<![\p{L}\p{N}_])(depois\s+de\s+amanh[ãa]|amanh[ãa]|hoje)(?![\p{L}\p{N}_])/giu;

// Horário por perto: "às 7", "as 19h", "7 da noite", "2 PM", "14:30", "19h30".
const RE_HORA =
  /\b(às?\s+\d{1,2}(?::\d{2}|h\d{0,2})?\b|\d{1,2}\s*(?:am|pm)\b|\d{1,2}(?::\d{2})?\s*(?:da\s+(?:manh[ãa]|tarde|noite)|horas?\b|h\b|h\d{2}\b))/i;

const RE_DATA = /\b(\d{1,2})[\/.](\d{1,2})(?:[\/.](\d{2,4}))?\b/;

const DIA_ALT =
  "domingo|segunda(?:-feira)?|ter[çc]a(?:-feira)?|quarta(?:-feira)?|quinta(?:-feira)?|sexta(?:-feira)?|s[áa]bado|dom|seg|ter|qua|qui|sex|s[áa]b";
const RE_DIA_NOME = new RegExp(`\\b(${DIA_ALT})\\b`, "i");

/** Janela de contexto ao redor do rótulo relativo. */
const JANELA = 45;

export interface LeadDayGuardResult {
  messages: string[];
  changed: boolean;
  /** Descrições curtas do que mudou (pra audit/log). */
  notes: string[];
}

function quantosDias(rotulo: string): number {
  const r = rotulo.toLowerCase();
  if (r.startsWith("depois")) return 2;
  if (r.startsWith("amanh")) return 1;
  return 0;
}

/**
 * Processa UMA bolha. Exportada pra teste.
 */
export function corrigirDiaRelativo(
  texto: string,
  tz: string,
  now: Date = new Date(),
): { texto: string; notes: string[] } {
  const notes: string[] = [];
  if (!texto) return { texto, notes };
  const hoje = hojeNoFuso(now, tz) || hojeNoFuso(now, "America/New_York");
  if (!hoje) return { texto, notes };

  let out = "";
  let cursor = 0;
  const re = new RegExp(RE_RELATIVO.source, "gi");
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const rotulo = m[0];
    const ini = m.index;
    const fim = ini + rotulo.length;

    // Idiomas ("hoje em dia") ficam em paz.
    if (/^\s*em\s+dia\b/i.test(texto.slice(fim))) continue;

    // Janela de contexto CORTADA no vizinho: numa oferta de 2 opções ("hoje às
    // 7 ou amanhã, sexta 28/08"), a data da opção do lado não pode contaminar o
    // julgamento deste rótulo. Corta no "ou" e no próximo rótulo relativo.
    const RE_CORTE = /(?<![\p{L}\p{N}_])(?:ou|hoje|amanh[ãa])(?![\p{L}\p{N}_])/iu;
    const depoisRaw = texto.slice(fim, fim + JANELA);
    const corteD = depoisRaw.search(RE_CORTE);
    const depois = corteD >= 0 ? depoisRaw.slice(0, corteD) : depoisRaw;
    const antesRaw = texto.slice(Math.max(0, ini - JANELA), ini);
    const partesAntes = antesRaw.split(RE_CORTE);
    const antes = partesAntes[partesAntes.length - 1];
    const contexto = antes + " " + depois;

    const temHora = RE_HORA.test(contexto);
    const dataAdj = RE_DATA.exec(depois) || RE_DATA.exec(antes);
    const diaAdj = RE_DIA_NOME.exec(depois) || RE_DIA_NOME.exec(antes);

    // Sem horário nem data/dia por perto: uso conversacional, não mexe.
    if (!temHora && !dataAdj && !diaAdj) continue;

    const esperado = somarDias(hoje, quantosDias(rotulo));

    let acao: "manter" | "remover" | "absolutizar" = "manter";
    if (dataAdj) {
      // A data explícita é a âncora: rótulo só sobrevive se apontar pra ela.
      const d = parseInt(dataAdj[1], 10);
      const mm = parseInt(dataAdj[2], 10);
      acao = d === esperado.d && mm === esperado.m ? "manter" : "remover";
    } else if (diaAdj) {
      const dito = parseWeekdayPt(diaAdj[1]);
      acao = dito !== null && dito === weekdayDeYmd(esperado) ? "manter" : "remover";
    } else {
      // Só horário por perto ("hoje às 7 da noite") → absolutiza.
      acao = "absolutizar";
    }

    if (acao === "manter") continue;

    out += texto.slice(cursor, ini);
    if (acao === "absolutizar") {
      // Vírgula depois do rótulo ("quinta-feira, 27/08, às 7") — a menos que o
      // texto seguinte já traga pontuação própria.
      const virgula = /^\s*[,;.]/.test(texto.slice(fim)) ? "" : ",";
      out += rotuloAbsoluto(esperado) + virgula;
      notes.push(`"${rotulo}" → "${rotuloAbsoluto(esperado)}"`);
      cursor = fim;
    } else {
      // remover: come o rótulo + separador colado ("amanhã, " / ", amanhã").
      let novoFim = fim;
      const sepDepois = /^[,]?\s+/.exec(texto.slice(fim));
      if (sepDepois) novoFim = fim + sepDepois[0].length;
      // vírgula pendurada antes ("sexta 28/08, amanhã") — remove também.
      out = out.replace(/[,]\s*$/, " ");
      notes.push(`"${rotulo}" removido (não bate com a data/dia ao lado)`);
      cursor = novoFim;
    }
  }
  out += texto.slice(cursor);
  // Espaços duplos que a remoção possa ter deixado.
  out = out.replace(/ {2,}/g, " ").replace(/\s+([,.!?])/g, "$1");
  return { texto: out, notes };
}

// ============================================================================
// Recap de agendamento (C7 — rodada 2 do estudo 17/08: lead escolheu 6 PM, o
// modelo recapitulou "10 AM, certo?" e o booking caiu às 6 PM. O slot-guard H58
// garante o SLOT; a NARRAÇÃO era livre). Escola booked_label do H50: depois de
// um booking REAL, toda bolha que cita horário/data/dia incompatível com o slot
// agendado é trocada pelo rótulo determinístico.
// ============================================================================

function partesNoFuso(iso: string, tz: string): (Ymd & { hh: number; mi: number }) | null {
  const dt = new Date(iso);
  if (isNaN(dt.getTime())) return null;
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(dt);
    const get = (t: string) => parseInt(parts.find((p) => p.type === t)?.value || "", 10);
    const y = get("year");
    const m = get("month");
    const d = get("day");
    let hh = get("hour");
    const mi = get("minute");
    if ([y, m, d, hh, mi].some((n) => isNaN(n))) return null;
    if (hh === 24) hh = 0;
    return { y, m, d, hh, mi };
  } catch {
    return null;
  }
}

/** "sexta-feira, 28/08, às 2 da tarde" — rótulo falado do slot agendado. */
export function rotuloDoSlot(iso: string, tz: string): string | null {
  const p = partesNoFuso(iso, tz);
  if (!p) return null;
  const dia = rotuloAbsoluto(p);
  const h12 = p.hh % 12 || 12;
  const periodo = p.hh < 12 ? "da manhã" : p.hh < 18 ? "da tarde" : "da noite";
  const hora = p.mi === 0 ? `${h12}` : `${h12}:${String(p.mi).padStart(2, "0")}`;
  return `${dia}, às ${hora} ${periodo}`;
}

/** Leituras 24h possíveis de uma menção de horário no texto. */
function leituras(h: number, marcador: string | undefined): number[] {
  const m = (marcador || "").toLowerCase();
  if (/pm|tarde|noite/.test(m)) return [h < 12 ? h + 12 : h];
  if (/am|manh/.test(m)) return [h === 12 ? 0 : h];
  // sem marcador ("às 7", "19h"): ambíguo — aceita as duas leituras.
  return h < 12 ? [h, h + 12] : [h];
}

const RE_MENCAO_HORA =
  /(?:às|as)\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm|da\s+manh[ãa]|da\s+tarde|da\s+noite|h\b)?|\b(\d{1,2})(?::(\d{2}))?\s*(am|pm|h\b)|\b(\d{1,2})(?::(\d{2}))?\s+(da\s+manh[ãa]|da\s+tarde|da\s+noite)/giu;

export interface RecapGuardResult {
  messages: string[];
  changed: boolean;
  notes: string[];
}

/**
 * Depois de um booking REAL em `bookedIso`: bolha que menciona horário/data/dia
 * que NÃO bate com o slot é substituída pelo rótulo determinístico. Se nenhuma
 * bolha citar horário, o rótulo é anexado (confirmação sempre com dia+data+hora).
 */
export function aplicarGuardaDeRecapAgendado(
  bubbles: string[],
  bookedIso: string,
  tz: string,
  opts: { sufixoFuso?: string } = {},
): RecapGuardResult {
  const notes: string[] = [];
  const booked = partesNoFuso(bookedIso, tz);
  const label = rotuloDoSlot(bookedIso, tz);
  if (!booked || !label) return { messages: bubbles, changed: false, notes };
  const confirmacao = `Fechado: ${label}${opts.sufixoFuso ? `, ${opts.sufixoFuso}` : ""}. A confirmação chega por aqui.`;

  let algumaCitaHora = false;
  const messages = bubbles.map((b) => {
    // Datas saem antes do scan de hora (senão "28/08" vira menção de hora).
    const semDatas = b.replace(/\b\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b/g, "§");

    let ofende = false;
    // 1. Menções de horário incompatíveis com o slot.
    const re = new RegExp(RE_MENCAO_HORA.source, "giu");
    let m: RegExpExecArray | null;
    while ((m = re.exec(semDatas)) !== null) {
      const h = parseInt(m[1] || m[4] || m[7] || "", 10);
      const min = parseInt(m[2] || m[5] || m[8] || "0", 10) || 0;
      const marcador = m[3] || m[6] || m[9];
      if (isNaN(h) || h > 23) continue;
      algumaCitaHora = true;
      const ok = leituras(h, marcador).some((hh) => hh === booked.hh) && min === booked.mi;
      if (!ok) ofende = true;
    }
    // 2. Data explícita diferente da agendada.
    const reData = /\b(\d{1,2})[\/.](\d{1,2})(?:[\/.]\d{2,4})?\b/g;
    let dm: RegExpExecArray | null;
    while ((dm = reData.exec(b)) !== null) {
      const d = parseInt(dm[1], 10);
      const mo = parseInt(dm[2], 10);
      if (d === booked.d && mo === booked.m) continue;
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) ofende = true;
    }
    // 3. Dia-da-semana nomeado diferente do agendado.
    const wdMatch = RE_DIA_NOME.exec(b);
    if (wdMatch) {
      const dito = parseWeekdayPt(wdMatch[1]);
      if (dito !== null && dito !== weekdayDeYmd(booked)) ofende = true;
    }

    if (ofende) {
      notes.push(`bolha com horário/data divergente do slot agendado trocada pelo rótulo real`);
      return confirmacao;
    }
    return b;
  });

  if (!algumaCitaHora && !messages.includes(confirmacao)) {
    messages.push(confirmacao);
    notes.push("nenhuma bolha citava o horário agendado — rótulo determinístico anexado");
  }

  return { messages, changed: notes.length > 0, notes };
}

/**
 * Ponto de entrada: passa cada bolha pelos DOIS guards (pares dia↔data do H85 +
 * rótulo relativo). Ordem importa: primeiro o nome do dia é corrigido pela
 * data, depois o rótulo relativo é julgado contra o par já correto.
 */
export function aplicarGuardaDeDataLead(
  bubbles: string[],
  tz: string,
  now: Date = new Date(),
): LeadDayGuardResult {
  const notes: string[] = [];
  const messages = bubbles.map((b) => {
    const pares = fixWeekdayDatePairs(b, tz, now);
    for (const c of pares.corrections) notes.push(`par corrigido: "${c.original}" → "${c.fixed}"`);
    const rel = corrigirDiaRelativo(pares.text, tz, now);
    notes.push(...rel.notes);
    return rel.texto;
  });
  return { messages, changed: notes.length > 0, notes };
}
