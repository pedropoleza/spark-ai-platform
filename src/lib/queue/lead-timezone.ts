/**
 * Fuso do lead (H115, caso Alves Cury 03/11/2026, Izolismaria).
 *
 * A conta opera em ET e a lista de horários do turno é gerada no fuso da conta.
 * Até aqui o prompt dizia "presuma ET, não pergunte o fuso" e nada mandava
 * converter quando o estado do lead era conhecido. A lead escreveu "Pode ser
 * sexta 2 PM DE AUSTIN" (2 PM no horário central = 3 PM ET) e a IA agendou 2 PM
 * ET, porque 2 PM ET também estava livre e o slot-guard não tinha como saber.
 * Marcos (dono): "o fuso o robô não arruma, né?".
 *
 * Este módulo é a parte determinística: reconhece estado, cidade ou fuso citados
 * em texto livre (PT e EN), dá o rótulo curto do fuso e converte horário de
 * parede entre fusos. Puro, sem I/O.
 */

export interface FusoDetectado {
  /** Fuso IANA, ex.: "America/Chicago". */
  tz: string;
  /** O que no texto revelou o fuso (estado, cidade ou rótulo). */
  origem: string;
}

// Remove acento e normaliza espaços, para casar "Flórida", "Califórnia", "Nova Iorque".
function semAcento(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
}

const ET = "America/New_York";
const CT = "America/Chicago";
const MT = "America/Denver";
const PT = "America/Los_Angeles";
const AZ = "America/Phoenix";

/**
 * Estados por nome (EN e PT, sem acento). Nome composto antes do simples
 * ("west virginia" antes de "virginia", "new mexico" antes de "mexico" não existe
 * aqui de propósito: México não é estado americano).
 */
const ESTADOS: Array<[RegExp, string, string]> = [
  [/\b(west virginia|virginia ocidental)\b/, ET, "West Virginia"],
  [/\b(north carolina|carolina do norte)\b/, ET, "North Carolina"],
  [/\b(south carolina|carolina do sul)\b/, ET, "South Carolina"],
  [/\b(north dakota|dakota do norte)\b/, CT, "North Dakota"],
  [/\b(south dakota|dakota do sul)\b/, CT, "South Dakota"],
  [/\b(new jersey|nova jersey|nova jersei)\b/, ET, "New Jersey"],
  [/\b(new york|nova york|nova iorque|nyc)\b/, ET, "New York"],
  [/\b(new hampshire)\b/, ET, "New Hampshire"],
  [/\b(new mexico|novo mexico)\b/, MT, "New Mexico"],
  [/\b(rhode island)\b/, ET, "Rhode Island"],
  [/\b(washington,? ?d\.?c\.?|distrito de columbia)\b/, ET, "Washington DC"],
  [/\bflorida\b/, ET, "Florida"],
  [/\b(massachusetts|massachussets|massachusets|massachussetts)\b/, ET, "Massachusetts"],
  [/\b(georgia)\b/, ET, "Georgia"],
  [/\b(pennsylvania|pensilvania)\b/, ET, "Pennsylvania"],
  [/\bconnecticut\b/, ET, "Connecticut"],
  [/\bmaryland\b/, ET, "Maryland"],
  [/\b(virginia)\b/, ET, "Virginia"],
  [/\bdelaware\b/, ET, "Delaware"],
  [/\bvermont\b/, ET, "Vermont"],
  [/\bohio\b/, ET, "Ohio"],
  [/\bmichigan\b/, ET, "Michigan"],
  [/\bindiana\b/, ET, "Indiana"],
  [/\bkentucky\b/, ET, "Kentucky"],
  [/\btexas\b/, CT, "Texas"],
  [/\billinois\b/, CT, "Illinois"],
  [/\btennessee\b/, CT, "Tennessee"],
  [/\b(louisiana|luisiana)\b/, CT, "Louisiana"],
  [/\balabama\b/, CT, "Alabama"],
  [/\boklahoma\b/, CT, "Oklahoma"],
  [/\bmissouri\b/, CT, "Missouri"],
  [/\bwisconsin\b/, CT, "Wisconsin"],
  [/\bminnesota\b/, CT, "Minnesota"],
  [/\biowa\b/, CT, "Iowa"],
  [/\bkansas\b/, CT, "Kansas"],
  [/\bnebraska\b/, CT, "Nebraska"],
  [/\bmississippi\b/, CT, "Mississippi"],
  [/\barkansas\b/, CT, "Arkansas"],
  [/\b(california|calif)\b/, PT, "California"],
  [/\bnevada\b/, PT, "Nevada"],
  [/\boregon\b/, PT, "Oregon"],
  [/\bwashington\b/, PT, "Washington"],
  [/\barizona\b/, AZ, "Arizona"],
  [/\bcolorado\b/, MT, "Colorado"],
  [/\butah\b/, MT, "Utah"],
  [/\bidaho\b/, MT, "Idaho"],
  [/\bmontana\b/, MT, "Montana"],
  [/\bwyoming\b/, MT, "Wyoming"],
  [/\b(alaska|alasca)\b/, "America/Anchorage", "Alaska"],
  [/\b(hawaii|havai)\b/, "Pacific/Honolulu", "Hawaii"],
];

/** Cidades onde a comunidade brasileira mais mora (e as grandes de cada fuso). */
const CIDADES: Array<[RegExp, string, string]> = [
  [/\b(orlando|miami|tampa|kissimmee|jacksonville|boca raton|pompano( beach)?|fort lauderdale|ft\.? lauderdale|deerfield( beach)?|coral springs|naples|fort myers|sarasota|west palm( beach)?|palm beach|hollywood,? fl|davie|weston|sunrise,? fl|margate|coconut creek|doral|aventura|celebration|winter garden|clermont|sanford|daytona|st\.? petersburg|clearwater|tallahassee|gainesville)\b/, ET, "Flórida"],
  [/\b(boston|framingham|marlborough|marlboro|worcester|everett|somerville|malden|revere|lowell|hudson,? ma|milford,? ma|cambridge,? ma)\b/, ET, "Massachusetts"],
  [/\b(newark|elizabeth,? nj|long branch|kearny|harrison,? nj|union city|jersey city)\b/, ET, "New Jersey"],
  [/\b(manhattan|brooklyn|queens|bronx|mount vernon|yonkers)\b/, ET, "New York"],
  [/\b(atlanta|marietta|alpharetta|duluth,? ga|savannah)\b/, ET, "Georgia"],
  [/\b(charlotte|raleigh|durham)\b/, ET, "North Carolina"],
  [/\b(philadelphia|filadelfia|pittsburgh)\b/, ET, "Pennsylvania"],
  [/\b(baltimore)\b/, ET, "Maryland"],
  [/\b(danbury|bridgeport|stamford|hartford)\b/, ET, "Connecticut"],
  [/\b(austin|houston|dallas|san antonio|fort worth|plano|frisco|katy|sugar land|irving|arlington,? tx|el paso)\b/, CT, "Texas"],
  [/\b(chicago)\b/, CT, "Illinois"],
  [/\b(nashville|memphis)\b/, CT, "Tennessee"],
  [/\b(new orleans|nova orleans)\b/, CT, "Louisiana"],
  [/\b(los angeles|san francisco|san diego|san jose|sacramento|oakland|irvine|anaheim)\b/, PT, "Califórnia"],
  [/\b(las vegas)\b/, PT, "Nevada"],
  [/\b(seattle)\b/, PT, "Washington"],
  [/\b(phoenix|scottsdale|mesa,? az|tucson)\b/, AZ, "Arizona"],
  [/\b(denver)\b/, MT, "Colorado"],
  [/\b(salt lake( city)?)\b/, MT, "Utah"],
];

/** Rótulos de fuso ditos pelo lead ou pela IA. */
const ROTULOS: Array<[RegExp, string, string]> = [
  [/\b(horario|hora|fuso)\s+(do\s+leste|de\s+nova\s+york|eastern|da\s+costa\s+leste)\b|\beastern\b/, ET, "horário do leste"],
  [/\b(horario|hora|fuso)\s+(central|do\s+centro)\b|\bcentral\s+time\b/, CT, "horário central"],
  [/\b(horario|hora|fuso)\s+(da\s+montanha|mountain)\b|\bmountain\s+time\b/, MT, "horário da montanha"],
  [/\b(horario|hora|fuso)\s+(do\s+pacifico|pacific|da\s+costa\s+oeste)\b|\bpacific\s+time\b/, PT, "horário do pacífico"],
];
const SIGLAS: Array<[RegExp, string]> = [
  [/\b(ET|EST|EDT)\b/, ET],
  [/\b(CT|CST|CDT)\b/, CT],
  [/\b(MT|MST|MDT)\b/, MT],
  [/\b(PT|PST|PDT)\b/, PT],
];

/**
 * Reconhece um fuso em texto livre: rótulo explícito ("horário central", "CT"),
 * estado ("Texas", "Flórida") ou cidade ("Austin", "Orlando"). Siglas só em
 * MAIÚSCULAS (em PT "pt" e "et" seriam ruído). Devolve o 1º achado na ordem
 * rótulo > cidade > estado, que é a ordem do mais específico para o mais amplo.
 */
export function detectarFusoNoTexto(texto: string | null | undefined): FusoDetectado | null {
  if (!texto) return null;
  const norm = semAcento(texto);
  for (const [re, tz, nome] of ROTULOS) if (re.test(norm)) return { tz, origem: nome };
  for (const [re, tz] of SIGLAS) {
    const m = re.exec(texto);
    if (m) return { tz, origem: m[1] };
  }
  for (const [re, tz, nome] of CIDADES) {
    const m = re.exec(norm);
    if (m) return { tz, origem: `${titulo(m[1])}, ${nome}` };
  }
  for (const [re, tz, nome] of ESTADOS) if (re.test(norm)) return { tz, origem: nome };
  return null;
}

function titulo(s: string): string {
  return s.replace(/\b\p{L}/gu, (c) => c.toUpperCase());
}

/** "horário do leste (ET)", "horário central (CT)"... como se fala com o lead. */
export function nomeDoFuso(tz: string): string {
  const s = siglaDoFuso(tz);
  if (s === "ET") return "horário do leste (ET)";
  if (s === "CT") return "horário central (CT)";
  if (s === "MT") return "horário da montanha (MT)";
  if (s === "PT") return "horário do pacífico (PT)";
  return s;
}

/** Fuso a partir do estado coletado ("Texas (Austin)", "FL", "Flórida"). */
export function fusoDoEstado(estado: string | null | undefined): FusoDetectado | null {
  if (!estado || !estado.trim()) return null;
  const sigla = estado.trim().toUpperCase();
  const SIGLAS_ESTADO: Record<string, string> = {
    FL: ET, MA: ET, NJ: ET, NY: ET, GA: ET, NC: ET, SC: ET, PA: ET, MD: ET, VA: ET, DE: ET, VT: ET,
    NH: ET, RI: ET, ME: ET, OH: ET, MI: ET, IN: ET, KY: ET, WV: ET, DC: ET,
    TX: CT, IL: CT, TN: CT, LA: CT, AL: CT, OK: CT, MO: CT, WI: CT, MN: CT, IA: CT, KS: CT, NE: CT,
    MS: CT, AR: CT, ND: CT, SD: CT,
    CA: PT, NV: PT, OR: PT, WA: PT, AZ: AZ, CO: MT, UT: MT, ID: MT, MT: MT, WY: MT, NM: MT,
    AK: "America/Anchorage", HI: "Pacific/Honolulu",
  };
  if (SIGLAS_ESTADO[sigla]) return { tz: SIGLAS_ESTADO[sigla], origem: sigla };
  // "CT" sozinho como estado é Connecticut, mas como fuso é o central: no campo
  // de ESTADO, é Connecticut.
  if (sigla === "CT") return { tz: ET, origem: "Connecticut" };
  const norm = semAcento(estado);
  for (const [re, tz, nome] of CIDADES) {
    const m = re.exec(norm);
    if (m) return { tz, origem: `${titulo(m[1])}, ${nome}` };
  }
  for (const [re, tz, nome] of ESTADOS) if (re.test(norm)) return { tz, origem: nome };
  return null;
}

/** Rótulo curto que a IA fala: ET, CT, MT, PT, AZ. */
export function siglaDoFuso(tz: string): string {
  if (tz === ET || tz === "America/Detroit" || tz === "America/Indiana/Indianapolis") return "ET";
  if (tz === CT) return "CT";
  if (tz === MT || tz === "America/Boise") return "MT";
  if (tz === PT) return "PT";
  if (tz === AZ) return "horário do Arizona";
  if (tz === "America/Anchorage") return "horário do Alasca";
  if (tz === "Pacific/Honolulu") return "horário do Havaí";
  return tz;
}

/** Diferença em minutos entre dois fusos num instante (b - a). Ex.: ET→CT = -60. */
export function diferencaMinutos(tzA: string, tzB: string, instante: Date = new Date()): number {
  const off = (tz: string) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    }).formatToParts(instante);
    const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
    return Date.UTC(g("year"), g("month") - 1, g("day"), g("hour") % 24, g("minute")) - instante.getTime();
  };
  return Math.round((off(tzB) - off(tzA)) / 60000);
}

/** Mesmo fuso para efeitos de conversa (offset igual agora). */
export function mesmoFuso(tzA: string, tzB: string, instante: Date = new Date()): boolean {
  return diferencaMinutos(tzA, tzB, instante) === 0;
}

/** Hora e minuto de um instante ISO num fuso. */
export function horaMinutoNoFuso(iso: string, tz: string): { h: number; min: number } | null {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hourCycle: "h23",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(d);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "", 10);
  const h = g("hour");
  const min = g("minute");
  if (isNaN(h) || isNaN(min)) return null;
  return { h: h % 24, min };
}

/** "2 PM", "2:30 PM", "12 PM" (formato da lista de horários). */
export function horaEmIngles(h: number, min: number): string {
  const h12 = h % 12 || 12;
  const ap = h < 12 ? "AM" : "PM";
  return min === 0 ? `${h12} ${ap}` : `${h12}:${String(min).padStart(2, "0")} ${ap}`;
}

/** "2 da tarde", "10:30 da manhã", "8 da noite" (como o agente fala). */
export function horaFalada(h: number, min: number): string {
  const h12 = h % 12 || 12;
  const periodo = h < 12 ? "da manhã" : h < 18 ? "da tarde" : "da noite";
  return `${min === 0 ? h12 : `${h12}:${String(min).padStart(2, "0")}`} ${periodo}`;
}

// ---------------------------------------------------------------------------
// Horário que o LEAD citou com fuso ("sexta 2 PM DE AUSTIN", "14h horário do Texas")
// ---------------------------------------------------------------------------

export interface HorarioCitado {
  h: number;
  min: number;
  /** Leituras possíveis em 24 h quando o lead não disse manhã/tarde ("às 2"). */
  leituras: number[];
  fuso: FusoDetectado;
  trecho: string;
}

const RE_HORA_LEAD =
  /(?:(?<![\p{L}\d])[àa]s\s+)?\b(\d{1,2})(?:[:h](\d{2}))?\s*(am|pm|a\.m\.|p\.m\.|h(?![\p{L}\d])|horas?(?![\p{L}])|da\s+manh[ãa]|da\s+tarde|da\s+noite)?/giu;

function leiturasDaHora(h: number, marcador: string | undefined): number[] {
  const m = (marcador || "").toLowerCase();
  if (/p\.?m|tarde|noite/.test(m)) return [h < 12 ? h + 12 : h];
  if (/a\.?m|manh/.test(m)) return [h === 12 ? 0 : h];
  return h < 12 ? [h, h + 12] : [h];
}

/** Todas as menções de hora de um texto (sem fuso). Número solto não conta. */
export function horariosCitados(texto: string | null | undefined): Array<{ h: number; min: number; leituras: number[]; trecho: string }> {
  if (!texto) return [];
  const semDatas = texto.replace(/\b\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b/g, " ");
  const re = new RegExp(RE_HORA_LEAD.source, "giu");
  const out: Array<{ h: number; min: number; leituras: number[]; trecho: string }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(semDatas)) !== null) {
    const h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const marcador = m[3];
    const temAs = /^[àa]s\s/i.test(m[0].trim());
    if (!marcador && !temAs && !m[2]) continue;
    if (isNaN(h) || h > 23 || min > 59) continue;
    out.push({ h, min, leituras: leiturasDaHora(h, marcador), trecho: m[0].trim() });
  }
  return out;
}

/**
 * Procura, na mensagem do lead, um horário dito junto de um fuso, estado ou
 * cidade. Só vale quando os dois aparecem na MESMA mensagem: "2 PM de Austin",
 * "14h no horário do Texas", "2pm central". Horário sem fuso não entra (aí a
 * leitura é a da conversa, e quem decide é o prompt).
 */
export function horarioCitadoComFuso(texto: string | null | undefined): HorarioCitado | null {
  if (!texto) return null;
  const fuso = detectarFusoNoTexto(texto);
  if (!fuso) return null;
  // Datas fora antes de procurar hora (senão "06/11" vira "6").
  const semDatas = texto.replace(/\b\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b/g, " ");
  const re = new RegExp(RE_HORA_LEAD.source, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(semDatas)) !== null) {
    const h = parseInt(m[1], 10);
    const min = m[2] ? parseInt(m[2], 10) : 0;
    const marcador = m[3];
    const temAs = /^[àa]s\s/i.test(m[0].trim());
    // Número solto ("tenho 56 anos", "2 filhos") não é hora: exige marcador ou "às".
    if (!marcador && !temAs && !m[2]) continue;
    if (isNaN(h) || h > 23 || min > 59) continue;
    return { h, min, leituras: leiturasDaHora(h, marcador), fuso, trecho: m[0].trim() };
  }
  return null;
}
