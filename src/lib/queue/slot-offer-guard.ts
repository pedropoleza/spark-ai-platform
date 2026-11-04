/**
 * Guarda de OFERTA de horário lead-facing (H115, caso Alves Cury 03/11/2026).
 *
 * O slot-guard do H58 só protege o AGENDAMENTO (start_time fora da lista não é
 * gravado). O que a IA OFERECE no texto era livre. Na Izolismaria a IA quis
 * oferecer "quarta 04/11 3 PM" e "quinta 05/11 8 PM" (os dois livres), escreveu
 * as datas com um dia a mais ("quarta, 05/11", "quinta, 06/11") e o
 * outbound_day_guard, que conserta o NOME do dia pela DATA, transformou isso em
 * "quinta 05/11 3 PM" e "sexta 06/11 8 PM", dois horários que não existiam. A
 * lead escolheu "sexta à noite" e ouviu que não havia.
 *
 * Aqui cada menção "dia + hora" do texto é conferida contra os horários reais do
 * turno (os mesmos ISO que alimentam o slot-guard):
 *  - a data dita existe na agenda com aquela hora: ok;
 *  - a data não existe, mas o DIA DA SEMANA dito existe com aquela hora: a data
 *    estava errada, e é ela que se corrige (não o nome do dia);
 *  - nenhuma leitura existe: a oferta é inventada e vai para o processor, que
 *    refaz o turno com a lista e, se insistir, troca pela oferta determinística.
 * Menção negada ("sexta às 8 não está disponível") não é oferta.
 *
 * Puro e testável: sem I/O; "agora" e fusos entram por parâmetro.
 */

import { parseWeekdayPt } from "@/lib/account-assistant/weekday-guard";
import { rotuloDoSlot } from "@/lib/queue/lead-day-guard";
import { detectarFusoNoTexto, diferencaMinutos, horaFalada, horaEmIngles, horaMinutoNoFuso, mesmoFuso, siglaDoFuso } from "@/lib/queue/lead-timezone";

interface Ymd {
  y: number;
  m: number;
  d: number;
}

function ymdNoFuso(instante: Date, tz: string): Ymd {
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(instante);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
  return { y: g("year"), m: g("month"), d: g("day") };
}

function somarDias(b: Ymd, n: number): Ymd {
  const dt = new Date(Date.UTC(b.y, b.m - 1, b.d + n));
  return { y: dt.getUTCFullYear(), m: dt.getUTCMonth() + 1, d: dt.getUTCDate() };
}

function diaDaSemana(b: Ymd): number {
  return new Date(Date.UTC(b.y, b.m - 1, b.d)).getUTCDay();
}

function chave(b: Ymd, h: number, min: number): string {
  return `${b.y}-${String(b.m).padStart(2, "0")}-${String(b.d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
}

/** Índice "YYYY-MM-DD HH:MM" (no fuso da lista) dos horários reais do turno. */
export function indexarSlots(isoList: readonly string[], tz: string): Map<string, string> {
  const idx = new Map<string, string>();
  for (const iso of isoList) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) continue;
    const hm = horaMinutoNoFuso(iso, tz);
    if (!hm) continue;
    idx.set(chave(ymdNoFuso(d, tz), hm.h, hm.min), iso);
  }
  return idx;
}

// "quinta-feira, 05/11" · "sexta" · "dia 06/11" · "amanhã" · "segunda (09/11)"
const RE_DIA =
  /\b(?:(depois\s+de\s+amanh[ãa]|amanh[ãa]|hoje)|((?:segunda|ter[çc]a|quarta|quinta|sexta)(?:-feira)?|s[áa]bado|domingo)(?:\s*,?\s*(?:dia\s+)?\(?(\d{1,2})\/(\d{1,2})\)?)?|(?:dia\s+)?(\d{1,2})\/(\d{1,2}))(?![\p{L}\d])/giu;

// "às 3 da tarde" · "8 da noite" · "2 PM" · "2:30 PM" · "15h" · "15h30" · "15:30" · "meio-dia"
const RE_HORA =
  /(?:(?<![\p{L}\d])[àa]s\s+)?\b(\d{1,2})(?:(?::(\d{2}))|h(\d{2})?(?![\p{L}\d]))?(?:\s*(am|pm|a\.m\.|p\.m\.|da\s+manh[ãa]|da\s+tarde|da\s+noite))?|\b(meio[-\s]dia)\b/giu;

const RE_NEGACAO =
  /\b(n[ãa]o\s+(est[áa]|tenho|tem|temos|h[áa]|consigo|fica|d[áa]|vai\s+dar)|indispon[íi]ve|ocupad|lotad|j[áa]\s+(foi|est[áa]\s+(tomad|ocupad|preenchid))|sem\s+vaga|n[ãa]o\s+abriu)/iu;

const RE_SEU_HORARIO = /\b(no\s+)?seu\s+(hor[áa]rio|fuso)(?![\p{L}])|\bhor[áa]rio\s+(de\s+)?a[íi](?![\p{L}])|\bhor[áa]rio\s+local(?![\p{L}])/iu;

interface MencaoDia {
  inicio: number;
  fim: number;
  relativo: number | null;
  diaSemana: number | null;
  data: { d: number; m: number } | null;
  /** posição da data no texto (para corrigir só ela) */
  dataInicio: number;
  dataFim: number;
}

interface MencaoHora {
  inicio: number;
  fim: number;
  leituras: number[];
  min: number;
}

export interface OfertaInvalida {
  bolha: number;
  trecho: string;
}

export interface SlotOfferGuardResult {
  messages: string[];
  /** Datas corrigidas pelo dia da semana (determinístico, sem refazer o turno). */
  correcoes: string[];
  /** Ofertas sem nenhuma leitura que exista na agenda do turno. */
  invalidas: OfertaInvalida[];
  /** Quantas menções dia + hora foram conferidas. */
  conferidas: number;
}

function lerDias(frase: string): MencaoDia[] {
  const out: MencaoDia[] = [];
  const re = new RegExp(RE_DIA.source, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(frase)) !== null) {
    const rel = m[1] ? (/depois/i.test(m[1]) ? 2 : /amanh/i.test(m[1]) ? 1 : 0) : null;
    const wd = m[2] ? parseWeekdayPt(m[2]) : null;
    const dd = m[3] ?? m[5];
    const mm = m[4] ?? m[6];
    let data: { d: number; m: number } | null = null;
    let dataInicio = -1;
    let dataFim = -1;
    if (dd && mm) {
      const d = parseInt(dd, 10);
      const mo = parseInt(mm, 10);
      if (d >= 1 && d <= 31 && mo >= 1 && mo <= 12) {
        data = { d, m: mo };
        const txt = `${dd}/${mm}`;
        const rel0 = m[0].lastIndexOf(txt);
        dataInicio = m.index + rel0;
        dataFim = dataInicio + txt.length;
      }
    }
    if (rel === null && wd === null && !data) continue;
    out.push({ inicio: m.index, fim: m.index + m[0].length, relativo: rel, diaSemana: wd, data, dataInicio, dataFim });
  }
  return out;
}

function lerHoras(frase: string): MencaoHora[] {
  // Datas viram "#" do MESMO tamanho (posições preservadas; "06/11" não vira hora).
  const semDatas = frase.replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, (s) => "#".repeat(s.length));
  const out: MencaoHora[] = [];
  const re = new RegExp(RE_HORA.source, "giu");
  let m: RegExpExecArray | null;
  while ((m = re.exec(semDatas)) !== null) {
    if (m[5]) {
      out.push({ inicio: m.index, fim: m.index + m[0].length, leituras: [12], min: 0 });
      continue;
    }
    const h = parseInt(m[1], 10);
    const min = parseInt(m[2] ?? m[3] ?? "0", 10) || 0;
    const marcador = (m[4] || "").toLowerCase();
    const temAs = /^[àa]s\s/i.test(m[0]);
    const temH = /\d{1,2}h/i.test(m[0]);
    // Número solto ("10 a 20 anos", "30 minutos") não é hora.
    if (!marcador && !temAs && !m[2] && !temH) continue;
    if (isNaN(h) || h > 23 || min > 59) continue;
    let leituras: number[];
    if (/p\.?m|tarde|noite/.test(marcador)) leituras = [h < 12 ? h + 12 : h];
    else if (/a\.?m|manh/.test(marcador)) leituras = [h === 12 ? 0 : h];
    else leituras = h < 12 ? [h, h + 12] : [h];
    out.push({ inicio: m.index, fim: m.index + m[0].length, leituras, min });
  }
  return out;
}

/** Fuso do rótulo logo depois da hora ("ET", "no seu horário", "CT"); null = sem rótulo. */
function fusoDoRotulo(depois: string, fusoLead: string | null): string | null {
  const janela = depois.slice(0, 32);
  const seu = RE_SEU_HORARIO.exec(janela);
  const det = detectarFusoNoTexto(janela);
  // o rótulo mais próximo da hora vence
  let idxDet = -1;
  if (det) {
    const alvo = det.origem.split(" ")[0];
    idxDet = janela.toLowerCase().indexOf(alvo.toLowerCase());
    if (idxDet < 0) idxDet = 0;
  }
  if (seu && fusoLead && (idxDet < 0 || seu.index <= idxDet)) return fusoLead;
  return det ? det.tz : null;
}

function resolverData(data: { d: number; m: number }, hoje: Ymd): Ymd | null {
  // A data mais próxima entre ontem e +60 dias (vira o ano em dezembro).
  for (const y of [hoje.y, hoje.y + 1]) {
    const cand = { y, m: data.m, d: data.d };
    const dt = Date.UTC(cand.y, cand.m - 1, cand.d);
    const check = new Date(dt);
    if (check.getUTCMonth() !== cand.m - 1) continue; // 31/11 não existe
    const dias = Math.round((dt - Date.UTC(hoje.y, hoje.m - 1, hoje.d)) / 86400000);
    if (dias >= -1 && dias <= 60) return cand;
  }
  return null;
}

/** As duas próximas datas com esse dia da semana (esta semana, inclusive hoje, e a seguinte). */
function proximasComDia(diaSemana: number, hoje: Ymd): Ymd[] {
  for (let i = 0; i < 7; i++) {
    const c = somarDias(hoje, i);
    if (diaDaSemana(c) === diaSemana) return [c, somarDias(c, 7)];
  }
  return [];
}

/** Converte (dia, hora) do fuso do rótulo para o fuso da lista e procura no índice. */
function existe(
  idx: Map<string, string>,
  dia: Ymd,
  leituras: number[],
  min: number,
  fusoTexto: string,
  fusoLista: string,
  agora: Date,
): boolean {
  const delta = mesmoFuso(fusoTexto, fusoLista, agora) ? 0 : diferencaMinutos(fusoTexto, fusoLista, agora);
  for (const h of leituras) {
    let total = h * 60 + min + delta;
    let d = dia;
    if (total < 0) {
      total += 1440;
      d = somarDias(dia, -1);
    } else if (total >= 1440) {
      total -= 1440;
      d = somarDias(dia, 1);
    }
    if (idx.has(chave(d, Math.floor(total / 60), total % 60))) return true;
  }
  return false;
}

/**
 * Confere as ofertas de horário das bolhas contra os horários reais do turno.
 * `fusoLista` é o fuso em que a lista foi gerada (o da conta); `fusoLead` é o do
 * lead quando conhecido (para "2 da tarde no seu horário").
 */
export function conferirOfertasDeHorario(
  bolhas: readonly string[],
  slotsIso: readonly string[],
  fusoLista: string,
  opts: { fusoLead?: string | null; agora?: Date } = {},
): SlotOfferGuardResult {
  const agora = opts.agora ?? new Date();
  const fusoLead = opts.fusoLead ?? null;
  const hoje = ymdNoFuso(agora, fusoLista);
  const idx = indexarSlots(slotsIso, fusoLista);
  const correcoes: string[] = [];
  const invalidas: OfertaInvalida[] = [];
  let conferidas = 0;

  const messages = bolhas.map((bolha, bi) => {
    let texto = bolha;
    // Frases: a referência de dia só vale dentro da mesma frase.
    const frases: Array<{ ini: number; txt: string }> = [];
    {
      const re = /[^.!?\n]+[.!?]*/g;
      let fm: RegExpExecArray | null;
      while ((fm = re.exec(bolha)) !== null) frases.push({ ini: fm.index, txt: fm[0] });
    }
    // Correções de data guardadas para aplicar de trás para frente (posições estáveis).
    const trocas: Array<{ ini: number; fim: number; novo: string }> = [];
    for (const f of frases) {
      const dias = lerDias(f.txt);
      if (dias.length === 0) continue;
      const horas = lerHoras(f.txt);
      for (const h of horas) {
        // dia: o último antes da hora; sem nenhum antes, o 1º depois ("às 10h na quinta")
        let dia = [...dias].reverse().find((d) => d.fim <= h.inicio) ?? dias.find((d) => d.inicio >= h.fim);
        if (!dia) continue;
        // a hora não pode estar DENTRO da menção de dia (a data já foi mascarada, mas por garantia)
        if (h.inicio >= dia.inicio && h.fim <= dia.fim) continue;
        const depois = f.txt.slice(h.fim);
        const antes = f.txt.slice(Math.max(0, dia.inicio - 40), dia.inicio);
        if (RE_NEGACAO.test(depois.slice(0, 48)) || /\bn[ãa]o\s+(tenho|temos|tem|h[áa])\b[^.!?]*$/iu.test(antes)) continue;
        const fusoTexto = fusoDoRotulo(depois, fusoLead) ?? fusoLista;
        conferidas++;

        const candData = dia.data ? resolverData(dia.data, hoje) : null;
        const okData = candData ? existe(idx, candData, h.leituras, h.min, fusoTexto, fusoLista, agora) : false;
        if (okData) continue;
        const candSemana =
          dia.diaSemana !== null
            ? proximasComDia(dia.diaSemana, hoje).find((c) => existe(idx, c, h.leituras, h.min, fusoTexto, fusoLista, agora)) ?? null
            : null;
        const okSemana = !!candSemana;
        const candRel = dia.relativo !== null ? somarDias(hoje, dia.relativo) : null;
        const okRel = candRel ? existe(idx, candRel, h.leituras, h.min, fusoTexto, fusoLista, agora) : false;

        if (!dia.data && (okSemana || okRel)) continue;
        if (dia.data && okSemana && candSemana && dia.dataInicio >= 0) {
          // a data estava errada e o nome do dia certo: corrige a DATA
          const novo = `${String(candSemana.d).padStart(2, "0")}/${String(candSemana.m).padStart(2, "0")}`;
          trocas.push({ ini: f.ini + dia.dataInicio, fim: f.ini + dia.dataFim, novo });
          correcoes.push(`data "${f.txt.slice(dia.dataInicio, dia.dataFim)}" → "${novo}" (o dia da semana dito existe na agenda com essa hora)`);
          continue;
        }
        invalidas.push({ bolha: bi, trecho: f.txt.slice(Math.min(dia.inicio, h.inicio), Math.max(dia.fim, h.fim)).trim() });
      }
    }
    // aplica as correções de data (sem repetir a mesma posição)
    const vistos = new Set<number>();
    for (const t of trocas.sort((a, b) => b.ini - a.ini)) {
      if (vistos.has(t.ini)) continue;
      vistos.add(t.ini);
      texto = texto.slice(0, t.ini) + t.novo + texto.slice(t.fim);
    }
    return texto;
  });

  return { messages, correcoes, invalidas, conferidas };
}

/**
 * Oferta determinística de 2 horários reais, espaçados (dias diferentes quando
 * dá), para quando a IA insiste em horário que não existe. Prefere tarde/noite
 * se `preferirTardeNoite`. Fala no fuso do lead quando ele é conhecido e
 * diferente do da lista: "quinta-feira, 05/11, às 1 da tarde no seu horário (2 PM ET)".
 */
export function ofertaDeterministica(
  slotsIso: readonly string[],
  fusoLista: string,
  opts: { fusoLead?: string | null; agora?: Date; preferirTardeNoite?: boolean } = {},
): string | null {
  const agora = opts.agora ?? new Date();
  const futuros = slotsIso
    .filter((s) => Date.parse(s) > agora.getTime() + 2 * 3600_000)
    .sort((a, b) => Date.parse(a) - Date.parse(b));
  if (futuros.length === 0) return null;
  const tardeNoite = (iso: string) => (horaMinutoNoFuso(iso, fusoLista)?.h ?? 0) >= 13;
  const pool = opts.preferirTardeNoite && futuros.some(tardeNoite) ? futuros.filter(tardeNoite) : futuros;
  const primeiro = pool[0];
  const diaDe = (iso: string) => {
    const y = ymdNoFuso(new Date(iso), fusoLista);
    return `${y.y}-${y.m}-${y.d}`;
  };
  const segundo = pool.find((s) => diaDe(s) !== diaDe(primeiro)) ?? pool.find((s) => Date.parse(s) - Date.parse(primeiro) >= 2 * 3600_000);
  const fala = (iso: string): string => {
    const fusoLead = opts.fusoLead;
    if (fusoLead && !mesmoFuso(fusoLead, fusoLista, new Date(iso))) {
      const local = rotuloDoSlot(iso, fusoLead);
      const hm = horaMinutoNoFuso(iso, fusoLista);
      if (local && hm) return `${local} no seu horário (${horaEmIngles(hm.h, hm.min)} ${siglaDoFuso(fusoLista)})`;
    }
    const r = rotuloDoSlot(iso, fusoLista);
    return r ? `${r} ${siglaDoFuso(fusoLista)}` : "";
  };
  const a = fala(primeiro);
  const b = segundo ? fala(segundo) : "";
  if (!a) return null;
  return b ? `Tenho ${a} ou ${b}. Qual fica melhor para você?` : `Tenho ${a}. Fica bom para você?`;
}

export { horaFalada };
