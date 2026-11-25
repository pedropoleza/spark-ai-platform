/**
 * Data por extenso no texto do lead (H127, chamado 492 da Alves Cury, 06/11/2026).
 *
 * O lead mora nos EUA e lia "terça, 10/11" como 11 de outubro ("coloca o mês
 * primeiro e o dia depois, porque aqui é ao contrário"). Com barra, DD/MM e MM/DD
 * são a mesma coisa sempre que os dois números vão até 12. Por extenso não há o
 * que trocar: "terça, 10 de novembro".
 *
 * Quem escreve é o código (mesma escola do H50/H85): o modelo e as instruções de
 * cada agente podem continuar em DD/MM, a saída é trocada antes do envio. E como
 * o modelo copia a própria fala do histórico, os leitores de data dos guardas
 * entendem os DOIS formatos.
 *
 * Fica como está: data com ano (nascimento, que o lead pode ter digitado no
 * formato americano), fração ("2/3 da renda"), "24/7", hora ("às 7/8") e texto em
 * inglês. Em espanhol o mês sai em espanhol.
 *
 * Puro e testável: sem I/O; "agora" e o fuso entram por parâmetro.
 */

import { parseWeekdayPt } from "@/lib/account-assistant/weekday-guard";

export interface DiaMes {
  d: number;
  m: number;
}

export type Idioma = "pt" | "es" | "en";

const MESES: Record<"pt" | "es", string[]> = {
  pt: ["janeiro", "fevereiro", "março", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};

/** Meses em português para montar regex (com e sem cedilha). */
export const MES_ALT =
  "janeiro|fevereiro|mar[çc]o|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro";

/** Data por extenso sem ano: "10 de novembro", "1º de novembro". Grupos: dia, mês. */
export const DATA_EXTENSO_SRC = `(\\d{1,2})\\s?[ºo°]?\\s+de\\s+(${MES_ALT})(?![\\p{L}])(?!\\s+(?:de\\s+)?\\d{4})`;

const semAcento = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

/** "novembro" → 11; null se não for mês. */
export function numeroDoMes(nome: string): number | null {
  const i = MESES.pt.findIndex((m) => semAcento(m) === semAcento(nome));
  return i >= 0 ? i + 1 : null;
}

/** "10 de novembro", "1º de novembro" (em espanhol, "10 de noviembre"). */
export function diaEMes(data: DiaMes, idioma: Idioma = "pt"): string {
  const lista = idioma === "es" ? MESES.es : MESES.pt;
  const dia = data.d === 1 && idioma !== "es" ? "1º" : String(data.d);
  return `${dia} de ${lista[data.m - 1] ?? "?"}`;
}

export interface DataNoTexto extends DiaMes {
  inicio: number;
  fim: number;
}

/**
 * Datas do texto, em qualquer dos dois formatos ("10/11", "10.11", "10/11/2026",
 * "10 de novembro"), na ordem em que aparecem. É a leitura que os guardas já
 * faziam (dia/mês) mais o extenso.
 */
export function lerDatas(texto: string): DataNoTexto[] {
  const out: DataNoTexto[] = [];
  let m: RegExpExecArray | null;
  const num = /\b(\d{1,2})[\/.](\d{1,2})(?:[\/.]\d{2,4})?\b/g;
  while ((m = num.exec(texto)) !== null) {
    const d = parseInt(m[1], 10);
    const mes = parseInt(m[2], 10);
    if (d < 1 || d > 31 || mes < 1 || mes > 12) continue;
    out.push({ d, m: mes, inicio: m.index, fim: m.index + m[0].length });
  }
  const ext = new RegExp(`(?<![\\p{L}\\d])${DATA_EXTENSO_SRC}`, "giu");
  while ((m = ext.exec(texto)) !== null) {
    const d = parseInt(m[1], 10);
    const mes = numeroDoMes(m[2]);
    if (d < 1 || d > 31 || mes === null) continue;
    out.push({ d, m: mes, inicio: m.index, fim: m.index + m[0].length });
  }
  return out.sort((a, b) => a.inicio - b.inicio);
}

/**
 * Esconde as datas com um caractere do MESMO tamanho (posições preservadas).
 * `soBarra`: não trata "9.30" como data (quem procura hora precisa dela inteira).
 */
export function mascararDatas(texto: string, com = "#", soBarra = false): string {
  const num = soBarra ? /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g : /\b\d{1,2}[\/.]\d{1,2}(?:[\/.]\d{2,4})?\b/g;
  return texto
    .replace(num, (s) => com.repeat(s.length))
    .replace(new RegExp(`(?<![\\p{L}\\d])${DATA_EXTENSO_SRC}`, "giu"), (s) => com.repeat(s.length));
}

// ---------------------------------------------------------------------------
// Escrita: "10/11" vira "10 de novembro"
// ---------------------------------------------------------------------------

const RE_SO_ES =
  /[¿¡ñ]|\b(?:lunes|martes|mi[ée]rcoles|jueves|viernes|usted|hola|gracias|tengo|puedes?|cu[áa]l|ma[ñn]ana|hoy)(?![\p{L}])|(?<![\p{L}])a\s+las\s+\d/iu;
const RE_SO_PT =
  /[ãõç]|(?<![\p{L}])(?:voc[êe]|vc|[àa]s\s+\d|segunda|ter[çc]a|quarta|quinta|sexta|tenho|hor[áa]rio\s+do\s+leste|qual|n[ãa]o)(?![\p{L}])/iu;
const RE_SO_EN =
  /\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday|would|which|works|your|you|available|i\s+have|at\s+\d)\b/i;

/** Idioma da fala do agente. Sem pista, português (o padrão da frota). */
export function idiomaDoTexto(texto: string): Idioma {
  if (RE_SO_PT.test(texto)) return "pt";
  if (RE_SO_ES.test(texto)) return "es";
  if (RE_SO_EN.test(texto)) return "en";
  return "pt";
}

const DIA_SEMANA_SRC =
  "(?:segunda|ter[çc]a|quarta|quinta|sexta)(?:-feira)?|s[áa]bado|domingo|lunes|martes|mi[ée]rcoles|jueves|viernes|seg|ter|qua|qui|sex|s[áa]b|dom";
const RE_DIA_SEMANA_ANTES = new RegExp(
  `(?<![\\p{L}])(${DIA_SEMANA_SRC})\\*{0,2}\\s*[,:]?\\s*(?:dia\\s+)?\\(?\\*{0,2}$`,
  "iu",
);
const RE_DIA_SEMANA_DEPOIS = new RegExp(`^\\*{0,2}\\s*[,(]\\s*(${DIA_SEMANA_SRC})(?![\\p{L}])`, "iu");
const RE_DIA_ANTES = /(?<![\p{L}])d[ií]a\s+\(?$/iu;
/** "às 7/8": é hora, não data. */
const RE_HORA_ANTES = /(?<![\p{L}])[àa]s?\s+$/iu;
/** "7/8 da noite", "10/20 anos", "2/3 pessoas": não é data. */
const RE_NAO_E_DATA_DEPOIS =
  /^\s*(?:%|am\b|pm\b|a\.m|p\.m|h\b|horas?\b|anos?\b|meses\b|m[êe]s(?![\p{L}])|dias\b|semanas?\b|x\b|vezes\b|pessoas?\b|filhos?\b|da\s+(?:manh|tarde|noite|renda|sua|minha))/iu;

const DIAS_ES: Record<string, number> = { lunes: 1, martes: 2, miercoles: 3, jueves: 4, viernes: 5 };

function diaDaSemanaDito(nome: string): number | null {
  const es = DIAS_ES[semAcento(nome)];
  return es !== undefined ? es : parseWeekdayPt(nome);
}

interface Ymd extends DiaMes {
  y: number;
}

function hojeNoFuso(agora: Date, tz: string): Ymd | null {
  try {
    const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
    const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "", 10);
    const r = { y: g("year"), m: g("month"), d: g("day") };
    return [r.y, r.m, r.d].some((n) => isNaN(n)) ? null : r;
  } catch {
    return null;
  }
}

/** A data (dia/mês) no ano que a deixa mais perto de hoje, com a distância em dias. */
function maisPerto(dm: DiaMes, hoje: Ymd): { dias: number; diaSemana: number } | null {
  let melhor: { dias: number; diaSemana: number } | null = null;
  const hojeMs = Date.UTC(hoje.y, hoje.m - 1, hoje.d);
  for (const y of [hoje.y - 1, hoje.y, hoje.y + 1]) {
    const dt = new Date(Date.UTC(y, dm.m - 1, dm.d));
    if (dt.getUTCMonth() !== dm.m - 1 || dt.getUTCDate() !== dm.d) continue; // 31/11 não existe
    const dias = Math.round((dt.getTime() - hojeMs) / 86400000);
    if (!melhor || Math.abs(dias) < Math.abs(melhor.dias)) melhor = { dias, diaSemana: dt.getUTCDay() };
  }
  return melhor;
}

/**
 * Qual data "a/b" quer dizer. DD/MM é o formato das instruções e ganha no empate;
 * MM/DD só vence quando é a leitura que cai perto de hoje (e, na dúvida, a que bate
 * com o dia da semana dito): "terça (8/4)" escrito em 1º de agosto é 4 de agosto.
 * null = não é data de agenda.
 */
function interpretar(a: number, b: number, diaSemana: number | null, ancorada: boolean, hoje: Ymd): DiaMes | null {
  const ler = (d: number, m: number) => (d >= 1 && d <= 31 && m >= 1 && m <= 12 ? maisPerto({ d, m }, hoje) : null);
  const br = ler(a, b);
  if (diaSemana === null) {
    return br && (ancorada || (br.dias >= -7 && br.dias <= 120)) ? { d: a, m: b } : null;
  }
  const us = ler(b, a);
  const peso = (x: { dias: number; diaSemana: number } | null, desde: number) =>
    x ? (x.dias >= desde && x.dias <= 60 ? 2 : 0) + (x.diaSemana === diaSemana ? 1 : 0) : -1;
  // Data recente já passada ("segunda 10/08" citada no dia 12) ainda é DD/MM.
  if (peso(us, -1) >= 2 && peso(us, -1) > peso(br, -10)) return { d: b, m: a };
  return br ? { d: a, m: b } : null;
}

/**
 * Troca as datas com barra por extenso: "terça, 10/11" → "terça, 10 de novembro".
 * Não mexe no que não é data de agenda (ver o cabeçalho).
 */
export function escreverDatasPorExtenso(
  texto: string,
  tz: string,
  agora: Date = new Date(),
  idioma: Idioma = idiomaDoTexto(texto),
): string {
  if (!texto || idioma === "en" || !texto.includes("/")) return texto;
  const hoje = hojeNoFuso(agora, tz) || hojeNoFuso(agora, "America/New_York");
  if (!hoje) return texto;
  const re = /(?<![\d\/:$]|\d[.,])(\d{1,2})\/(\d{1,2})(?![\d\/]|[.,:]\d)/g;
  let out = "";
  let cursor = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(texto)) !== null) {
    const antes = texto.slice(0, m.index);
    const depois = texto.slice(m.index + m[0].length);
    if (m[0] === "24/7" || RE_HORA_ANTES.test(antes) || RE_NAO_E_DATA_DEPOIS.test(depois)) continue;
    if (/(?:https?:\/\/|www\.)\S*$/i.test(antes)) continue; // dentro de link
    const wdAntes = RE_DIA_SEMANA_ANTES.exec(antes);
    const wdDepois = wdAntes ? null : RE_DIA_SEMANA_DEPOIS.exec(depois);
    const nomeDia = (wdAntes ?? wdDepois)?.[1] ?? null;
    const ancorada = !!nomeDia || RE_DIA_ANTES.test(antes);
    // Sem dia da semana nem "dia" ao lado, só vale com dois dígitos dos dois lados ("06/11").
    if (!ancorada && (m[1].length < 2 || m[2].length < 2)) continue;
    const dm = interpretar(parseInt(m[1], 10), parseInt(m[2], 10), nomeDia ? diaDaSemanaDito(nomeDia) : null, ancorada, hoje);
    if (!dm) continue;
    let trecho = texto.slice(cursor, m.index);
    // "sexta 28/08" → "sexta, 28 de agosto"
    if (wdAntes && /[\p{L}*] $/u.test(trecho) && !/dia $/iu.test(trecho)) trecho = trecho.slice(0, -1) + ", ";
    out += trecho + diaEMes(dm, idioma);
    cursor = m.index + m[0].length;
  }
  return out + texto.slice(cursor);
}
