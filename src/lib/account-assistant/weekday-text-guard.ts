/**
 * Guarda determinística do par "dia-da-semana + data" no TEXTO que sai pro rep
 * (review de uso 2026-08-25 — casos Ana Paula Rangel, Ana Gusmão, Matheus Curty).
 *
 * POR QUE EXISTE, se já temos H50 (weekday-guard) e H68 (calendar-grounding):
 *
 *  - O **weekday-guard** (H50) protege o que é GRAVADO: cruza `expected_weekday`
 *    com o ISO antes da tool escrever no CRM. Ele não olha o texto da conversa.
 *  - O **calendar-grounding** (H68) entrega a tabela pronta pra o modelo COPIAR,
 *    mas cobre só as próximas semanas. Medido no review de 13→25/08: das 265
 *    combinações "dia + data" que o bot escreveu, 7 saíram erradas — e **todas as
 *    7 estavam FORA da janela da tabela** (14/09, 15/09, 21/09, 24/09, 15/10).
 *    5 das 7 batiam exatamente com o calendário de 2025, a assinatura do H68.
 *    Ampliar a tabela empurra a fronteira; não a elimina.
 *
 * O dano não é cosmético. Caso Ana Paula (20/08): o bot afirmou que 24/09 era
 * domingo, depois quarta; a rep corrigiu QUATRO vezes ("Dia 24/09 é uma quinta",
 * "Você está tendo erros", "Você está me deixando preocupada") e o bot reafirmou
 * o erro em cada rodada. 24/09/2026 é quinta-feira.
 *
 * A SOLUÇÃO: o nome do dia é DERIVÁVEL da data — então quem produz é o código,
 * nunca o modelo (mesma escola do `booked_label` do H50 e das agendas
 * pré-renderizadas do H69). Este módulo varre o texto final, acha os pares e
 * corrige o NOME DO DIA pela data. Horizonte infinito, custo zero de token.
 *
 * POR QUE CORRIGIR O DIA E NÃO A DATA: a data é a âncora. Ela é o que já foi
 * (ou vai ser) gravado no CRM, e no caminho de escrita ela passou pelo
 * weekday-guard, que cruza com o dia que o REP nomeou. Aqui, no texto, o nome do
 * dia é rótulo — e rótulo errado é o que quebra a confiança do rep.
 *
 * Puro e testável (sem I/O). Fuso via Intl → DST-correct.
 */

import { parseWeekdayPt, weekdayNamePt } from "./weekday-guard";

/** Formas curtas, na ordem dom..sáb (espelha o calendar-grounding). */
const WD_CURTO_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];

/** Gênero de cada dia: domingo e sábado são masculinos; os "-feira" são femininos. */
const WD_MASCULINO = [true, false, false, false, false, false, true];

/**
 * Artigos que aparecem antes do dia-da-semana. Quando o dia corrigido troca de
 * gênero, o artigo troca junto — senão sai "cai num quinta-feira".
 */
const ARTIGO_PARA_FEMININO: Record<string, string> = {
  um: "uma",
  num: "numa",
  no: "na",
  o: "a",
};
const ARTIGO_PARA_MASCULINO: Record<string, string> = {
  uma: "um",
  numa: "num",
  na: "no",
  a: "o",
};

/** Alternativa de regex com todas as grafias de dia-da-semana que aceitamos. */
const DIA_ALT =
  "domingos?|segundas?(?:-feiras?)?|ter[çc]as?(?:-feiras?)?|quartas?(?:-feiras?)?|" +
  "quintas?(?:-feiras?)?|sextas?(?:-feiras?)?|s[áa]bados?|dom|seg|ter|qua|qui|sex|s[áa]b";

const ARTIGO_ALT = "um|uma|num|numa|no|na|o|a";

/**
 * Ordem A — o dia vem ANTES da data:
 *   "quinta-feira, 24/09"  ·  "sábado 15/10"  ·  "segunda-feira, 15/09/2026"
 *   "*quarta* 26/08"       ·  "qui 16/07"     ·  "sexta-feira, dia 28/08"
 */
const RE_DIA_DATA = new RegExp(
  `(\\b)(${DIA_ALT})(\\b\\*{0,2}[,]?\\s+(?:\\*{0,2})?(?:dia\\s+)?)(\\d{1,2})[\\/.-](\\d{1,2})(?:[\\/.-](\\d{2,4}))?`,
  "gi",
);

/**
 * Ordem B — a data vem ANTES do dia, ligada por verbo de identidade:
 *   "24/09 é uma quarta"  ·  "Dia 24/09 cai num domingo"  ·  "13/09 seria sábado"
 *
 * O verbo é OBRIGATÓRIO: sem ele, "reunião 28/08 sexta às 7" seria um par solto
 * e o risco de reescrever texto que não é afirmação de calendário sobe à toa.
 *
 * ⚠️ O "e" SOZINHO ficou de fora de propósito. Ele é a conjunção, não o verbo
 * sem acento — e a lista ("24/09 e quinta-feira 15/10") é justamente a forma em
 * que o bot enumera datas. Com "e" na alternância, o guard lia a enumeração como
 * afirmação e reescrevia o dia do item SEGUINTE pelo dia do item anterior
 * (pego pelo caso "múltiplos pares errados" na primeira rodada do teste).
 * A grafia sem acento fica coberta por "eh", que não colide com nada.
 */
const RE_DATA_DIA = new RegExp(
  `(\\b)(\\d{1,2})[\\/.-](\\d{1,2})(?:[\\/.-](\\d{2,4}))?` +
    `(\\s+(?:é|eh|cai|caiu|seria|ser[áa]|vai\\s+ser|fica|ficaria)\\s+)` +
    `((?:(?:${ARTIGO_ALT})\\s+)?)(\\*{0,2})(${DIA_ALT})`,
  "gi",
);

export interface WeekdayTextCorrection {
  /** Trecho original ("domingo, 14/09"). */
  original: string;
  /** Trecho corrigido ("segunda-feira, 14/09"). */
  fixed: string;
  /** Data resolvida, "DD/MM/AAAA". */
  data: string;
  /** Dia-da-semana que o bot escreveu (0..6). */
  ditoWd: number;
  /** Dia-da-semana REAL da data (0..6). */
  realWd: number;
  /** true quando o dia escrito bate com o calendário do ano ANTERIOR (assinatura H68). */
  batendoAnoAnterior: boolean;
}

export interface WeekdayTextGuardResult {
  /** Texto com os pares corrigidos (idêntico ao original se nada mudou). */
  text: string;
  /** Correções aplicadas — vazio quando o texto já estava certo. */
  corrections: WeekdayTextCorrection[];
}

/** Weekday 0..6 de uma data de calendário (y, m 1-12, d) — aritmética UTC pura. */
function weekdayOfYmd(y: number, m: number, d: number): number {
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** A data (y,m,d) existe de fato? Rejeita 31/02, 31/04 etc. */
function dataValida(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

/** {y,m,d} de HOJE no fuso do rep (calendário local, não UTC). */
function hojeNoFuso(now: Date, tz: string): { y: number; m: number; d: number } | null {
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

/**
 * Resolve o ano de uma data escrita sem ano ("24/09"). Escolhe, entre o ano
 * passado / atual / que vem, o que deixa a data mais PERTO de hoje.
 *
 * Isso cobre os dois usos reais: "22/08" escrito em 24/08 é sexta passada (ano
 * atual), e "15/10" escrito em 15/08 é daqui dois meses (ano atual). A virada de
 * ano é o caso que exige os vizinhos: "05/01" escrito em 28/12 é o ano que vem.
 */
function resolveAno(
  d: number,
  m: number,
  hoje: { y: number; m: number; d: number },
): number | null {
  const hojeMs = Date.UTC(hoje.y, hoje.m - 1, hoje.d);
  let melhor: number | null = null;
  let melhorDist = Infinity;
  for (const y of [hoje.y - 1, hoje.y, hoje.y + 1]) {
    if (!dataValida(y, m, d)) continue;
    const dist = Math.abs(Date.UTC(y, m - 1, d) - hojeMs);
    if (dist < melhorDist) {
      melhorDist = dist;
      melhor = y;
    }
  }
  return melhor;
}

/** Mantém a caixa do original: "Segunda-feira" → "Quinta-feira", "SEG" → "QUI". */
function aplicarCaixa(molde: string, novo: string): string {
  if (molde === molde.toUpperCase() && /[A-ZÀ-Ú]/.test(molde)) return novo.toUpperCase();
  if (/^[A-ZÀ-Ú]/.test(molde)) return novo.charAt(0).toUpperCase() + novo.slice(1);
  return novo;
}

/** O termo escrito é a forma curta ("qui")? Então a correção também é curta. */
function ehFormaCurta(termo: string): boolean {
  return termo.replace(/[.]/g, "").length <= 3;
}

/** Nome do dia na mesma forma (curta/longa) e caixa do termo original. */
function nomeCompativel(realWd: number, termoOriginal: string): string {
  const base = ehFormaCurta(termoOriginal) ? WD_CURTO_PT[realWd] : weekdayNamePt(realWd);
  return aplicarCaixa(termoOriginal, base);
}

/** Ajusta o artigo quando o gênero do dia muda ("num domingo" → "numa quinta-feira"). */
function ajustarArtigo(artigo: string, ditoWd: number, realWd: number): string {
  const bruto = artigo.trim();
  if (!bruto) return artigo;
  if (WD_MASCULINO[ditoWd] === WD_MASCULINO[realWd]) return artigo;
  const chave = bruto.toLowerCase();
  const novo = WD_MASCULINO[realWd] ? ARTIGO_PARA_MASCULINO[chave] : ARTIGO_PARA_FEMININO[chave];
  if (!novo) return artigo;
  return artigo.replace(bruto, aplicarCaixa(bruto, novo));
}

/**
 * Corrige todo par "dia-da-semana + data" do texto pela data real.
 *
 * @param text  texto que iria pro rep
 * @param tz    fuso do rep (define o que é "hoje" pra resolver ano omitido)
 * @param now   instante de referência
 */
export function fixWeekdayDatePairs(
  text: string,
  tz: string,
  now: Date = new Date(),
): WeekdayTextGuardResult {
  const corrections: WeekdayTextCorrection[] = [];
  if (!text) return { text, corrections };

  const hoje = hojeNoFuso(now, tz) || hojeNoFuso(now, "America/New_York");
  if (!hoje) return { text, corrections };

  /** Resolve (dia, mês, ano?) → {y,m,d} válido, ou null pra ignorar o match. */
  const resolverData = (
    dStr: string,
    mStr: string,
    yStr: string | undefined,
  ): { y: number; m: number; d: number } | null => {
    const d = parseInt(dStr, 10);
    const m = parseInt(mStr, 10);
    let y: number | null;
    if (yStr) {
      y = parseInt(yStr, 10);
      if (y < 100) y += 2000;
      if (!dataValida(y, m, d)) return null;
    } else {
      y = resolveAno(d, m, hoje);
      if (y === null) return null;
    }
    return { y, m, d };
  };

  /** Registra a correção (só quando o dia escrito realmente diverge). */
  const registrar = (
    original: string,
    fixed: string,
    ymd: { y: number; m: number; d: number },
    ditoWd: number,
    realWd: number,
  ) => {
    corrections.push({
      original,
      fixed,
      data: `${String(ymd.d).padStart(2, "0")}/${String(ymd.m).padStart(2, "0")}/${ymd.y}`,
      ditoWd,
      realWd,
      batendoAnoAnterior:
        dataValida(ymd.y - 1, ymd.m, ymd.d) && weekdayOfYmd(ymd.y - 1, ymd.m, ymd.d) === ditoWd,
    });
  };

  // ── Varredura ÚNICA sobre o texto ORIGINAL ─────────────────────────────
  // As duas ordens são procuradas no MESMO texto e as substituições só são
  // aplicadas no fim, da direita pra esquerda. Rodar `replace` em cascata (A
  // depois B sobre a saída de A) deixa a ordem B enxergar texto que a ordem A
  // acabou de escrever — e uma correção passa a alimentar a outra. Aqui cada
  // trecho do original é considerado uma vez só; sobreposição = o primeiro
  // match (mais à esquerda) vence.
  interface Pendente {
    start: number;
    end: number;
    original: string;
    corrigido: string;
    ymd: { y: number; m: number; d: number };
    ditoWd: number;
    realWd: number;
  }
  const pendentes: Pendente[] = [];

  RE_DIA_DATA.lastIndex = 0;
  for (let m = RE_DIA_DATA.exec(text); m !== null; m = RE_DIA_DATA.exec(text)) {
    const [match, pre, termo, meio, dStr, mStr, yStr] = m;
    const ymd = resolverData(dStr, mStr, yStr);
    if (!ymd) continue;
    const ditoWd = parseWeekdayPt(termo);
    if (ditoWd === null) continue;
    const realWd = weekdayOfYmd(ymd.y, ymd.m, ymd.d);
    if (realWd === ditoWd) continue;
    pendentes.push({
      start: m.index,
      end: m.index + match.length,
      original: match,
      corrigido: `${pre}${nomeCompativel(realWd, termo)}${meio}${dStr}/${mStr}${yStr ? `/${yStr}` : ""}`,
      ymd,
      ditoWd,
      realWd,
    });
  }

  RE_DATA_DIA.lastIndex = 0;
  for (let m = RE_DATA_DIA.exec(text); m !== null; m = RE_DATA_DIA.exec(text)) {
    const [match, pre, dStr, mStr, yStr, verbo, artigo, asteriscos, termo] = m;
    const ymd = resolverData(dStr, mStr, yStr);
    if (!ymd) continue;
    const ditoWd = parseWeekdayPt(termo);
    if (ditoWd === null) continue;
    const realWd = weekdayOfYmd(ymd.y, ymd.m, ymd.d);
    if (realWd === ditoWd) continue;
    pendentes.push({
      start: m.index,
      end: m.index + match.length,
      original: match,
      corrigido:
        `${pre}${dStr}/${mStr}${yStr ? `/${yStr}` : ""}${verbo}` +
        `${ajustarArtigo(artigo, ditoWd, realWd)}${asteriscos}${nomeCompativel(realWd, termo)}`,
      ymd,
      ditoWd,
      realWd,
    });
  }

  // Esquerda→direita, descartando quem se sobrepõe a um match já aceito.
  pendentes.sort((a, b) => a.start - b.start || b.end - a.end);
  const aceitos: Pendente[] = [];
  let limite = -1;
  for (const p of pendentes) {
    if (p.start < limite) continue;
    aceitos.push(p);
    limite = p.end;
  }

  // Aplica de trás pra frente pra os índices continuarem válidos.
  let out = text;
  for (let i = aceitos.length - 1; i >= 0; i--) {
    const p = aceitos[i];
    out = out.slice(0, p.start) + p.corrigido + out.slice(p.end);
  }
  for (const p of aceitos) registrar(p.original, p.corrigido, p.ymd, p.ditoWd, p.realWd);

  return { text: out, corrections };
}
