/**
 * O lead escolheu ESTE horário? (H129, chamado 527 da Alves Cury, 19/11/2026)
 *
 * Com reunião marcada, o lead escreveu "infelizmente não poderei participar do
 * nosso encontro, obrigado e desculpe". O modelo leu como remarcação, escolheu
 * sexta às 14h sozinho e moveu a reunião. Os guardas que existiam só perguntam
 * "esse horário existe na agenda?" (H58); nenhum perguntava "quem escolheu?".
 *
 * Aqui a resposta é um fato do texto: a hora foi dita por ele (fora de uma frase
 * de recusa), ele aceitou uma opção que a gente ofereceu, ou o dia que ele disse
 * só tem aquele horário livre. Sem nenhum desses, quem escolheu foi o modelo.
 *
 * Puro e testável: sem I/O; "agora" e os fusos entram por parâmetro. Medido nas 53
 * mudanças reais de reunião da frota (26/06 a 25/11/2026): as 34 que o lead escolheu
 * passam; das 19 sem escolha, 14 eram a IA mudando sozinha (ver DECISIONS H129).
 */

import { parseWeekdayPt } from "@/lib/account-assistant/weekday-guard";
import { coerceStartTimeToTimezone } from "@/lib/ai/slot-guard";
import { lerDatas } from "@/lib/queue/datas-lead";
import { diferencaMinutos } from "@/lib/queue/lead-timezone";

export interface FalaAnterior {
  texto: string;
  /** Quando saiu (ISO), para resolver "hoje" e "amanhã" da própria fala. */
  em?: string | null;
}

export interface EscolhaInput {
  /** O que o lead escreveu neste turno (sem a mensagem citada). */
  mensagem: string;
  /** Mensagem nossa que ele citou ao responder, se citou. */
  citado?: string | null;
  startIso: string;
  fusoLista: string;
  fusoLead?: string | null;
  /** O que saiu para o lead antes deste turno, da mais nova para a mais velha. */
  falasAnteriores: readonly FalaAnterior[];
  /** Horários livres do turno. */
  slotsIso?: readonly string[];
  /** Início da reunião que já existe, se conhecido. */
  reuniaoIso?: string | null;
  agora: Date;
}

export type ViaDaEscolha =
  | "hora_dita"
  | "aceite_da_oferta"
  | "dia_ofertado"
  | "periodo_ofertado"
  | "unico_horario_do_dia"
  | "mesmo_horario"
  | "citado"
  | "sem_texto";

export interface Relogio {
  y: number;
  m: number;
  d: number;
  h: number;
  min: number;
}

const wd = (r: Pick<Relogio, "y" | "m" | "d">) => new Date(Date.UTC(r.y, r.m - 1, r.d)).getUTCDay();
const mesmoDia = (a: Pick<Relogio, "y" | "m" | "d">, b: Pick<Relogio, "y" | "m" | "d">) => a.y === b.y && a.m === b.m && a.d === b.d;

/**
 * O horário que vai ser gravado, no relógio da conta: a mesma correção de offset do
 * executor (H66/H73), para julgar o que o lead de fato teria na agenda.
 */
export function relogioDaConta(startIso: string, fusoLista: string, slotsIso?: readonly string[]): Relogio | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(String(startIso || ""))) return null;
  const d = new Date(coerceStartTimeToTimezone(startIso, fusoLista, slotsIso ? [...slotsIso] : undefined).iso);
  return isNaN(d.getTime()) ? null : relogioNoFuso(d, fusoLista);
}

/** Reunião do CRM (instante certo), no relógio da conta. */
const relogioDaReuniao = (iso: string, fusoLista: string): Relogio | null => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? null : relogioNoFuso(d, fusoLista);
};

function somaMinutos(r: Relogio, delta: number): Relogio {
  const t = new Date(Date.UTC(r.y, r.m - 1, r.d, r.h, r.min + delta));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate(), h: t.getUTCHours(), min: t.getUTCMinutes() };
}

/** Relógio de parede de um instante num fuso. */
export function relogioNoFuso(instante: Date, tz: string): Relogio {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instante);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
  return { y: g("year"), m: g("month"), d: g("day"), h: g("hour") % 24, min: g("minute") };
}

/** Minúsculas, sem acento, abreviações do WhatsApp; a pontuação fica (separa as orações). */
export function normalizarFala(t: string): string {
  return String(t ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\bhj\b/g, "hoje")
    .replace(/\b(?:amanh|amnh)\b/g, "amanha")
    .replace(/\b(?:vc|ce)\b/g, "voce")
    .replace(/\bn\b(?!\s*[o°º.]?\s*\d)/g, "nao")
    .replace(/\b(?:pra|pro)\b/g, "para")
    .replace(/([a-z])\1{2,}/g, "$1")
    .replace(/\b(?:bom dia|boa tarde|boa noite)\b/g, " ")
    .replace(/[^\S\n]+/g, " ")
    .trim();
}

/** Tira "[media]", "[Áudio do contato, transcrito]" e parecidos: não são fala do lead. */
function semMarcadores(t: string): string {
  return String(t ?? "").replace(/\[[^\]\n]{0,200}\]/g, " ");
}

// ---------------------------------------------------------------------------
// Orações: o que está numa frase de recusa não é escolha
// ---------------------------------------------------------------------------

const RECUSA = new RegExp(
  [
    // "não posso", "não vou conseguir", "não terei como", "não dá"
    "\\bnao\\b(?:\\s+\\S+){0,4}?\\s+(?:posso|consigo|conseguimos|podemos|poderei|poderemos|conseguirei|conseguiremos|poderia|conseguiria|vou|vamos|irei|iremos|vai|da|dara|deu|daria|tenho|temos|terei|teremos|estarei|estaremos|rola|sera|seria|funciona|serve)\\b",
    "\\b(?:impossivel|infelizmente|compromissos?|imprevistos?|emprevistos?|contratempos?|emergencia|doente|hospital|desmarc\\w*|cancel\\w*|faltar|sem condicoes)\\b",
    "\\b(?:surgiu|surgiram|apareceu|tive|tenho|terei)\\s+(?:um|uma|medico|dentista|consulta|reuniao|aula|culto|voo|viagem|trabalho)\\b",
    "\\b(?:tive|tenho|terei)\\s+que\\b(?!\\s+(?:re ?marc|re ?agend|mudar|trocar|passar|adiar))",
    "\\b(?:estou|to|tou|estarei|estamos|vou estar)\\s+(?:\\S+\\s+){0,2}?(?:trabalh\\w*|ocupad\\w*|viajando|agarrad\\w*|apertad\\w*|enrolad\\w*|corrid\\w*)",
    // rotina dele, não escolha: "saio às 5", "trabalho até as 7"
    "\\b(?:saio|chego|entro|largo|trabalho)\\b",
  ].join("|"),
);

/** Dúvida não é escolha: "talvez sábado", "vou ver e te aviso". */
const HESITA = /\b(?:talvez|quem sabe|vou pensar|pensar|vou ver|vamos ver|deixa eu ver|vejo|verificar|te aviso|eu aviso|te falo|te digo|nao sei|se der|depois)\b/;

// Palavras que abrem uma oração nova sem pontuação ("não posso hoje só segunda",
// "não consigo às 5 pode ser às 6?"). "não pode ser" não abre: é a própria recusa.
const ABRE_ORACAO =
  /(?<!\bnao )(?=\b(?:mas|porem|so que|so|somente|apenas|entao|se nao|senao|porque|pois|pq|ja que|que eu|tem como|teria como|pode ser|podemos|poderia(?:mos)?|consegue|queria|quero|prefiro|preferia|gostaria|daria para|da para|seria possivel|e (?:re)?marcar|e (?:re)?agendar|e passar|e mudar|e colocar|e deixar|e fazer)\b)/;

/** Quebra a fala em orações: "não posso às 5, mas às 3 sim" vira recusa + escolha. */
export function oracoes(t: string): Array<{ texto: string; recusa: boolean; hesita: boolean }> {
  return t
    .split(/[.!?;\n,]+(?!\d)/)
    .flatMap((s) => s.split(ABRE_ORACAO))
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((texto) => ({ texto, recusa: RECUSA.test(texto), hesita: HESITA.test(texto) }));
}

/** O lead disse que não vai, não pode ou que surgiu outra coisa? */
export function falaDeRecusa(texto: string): boolean {
  return oracoes(normalizarFala(semMarcadores(texto))).some((o) => o.recusa);
}

// ---------------------------------------------------------------------------
// Horas
// ---------------------------------------------------------------------------

export interface HoraDita {
  leituras: number[];
  min: number;
  /** false = número solto ou sem minuto: casa com :30 só se a gente ofereceu :30. */
  minutoDito: boolean;
}

const NUMERO_POR_EXTENSO: Record<string, number> = {
  uma: 1, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12,
};

function leiturasCom(h: number, periodo: string): number[] {
  if (/pm|p\.m|tarde|noite/.test(periodo)) return [h < 12 ? h + 12 : h];
  if (/am|a\.m|manha/.test(periodo)) return [h === 12 ? 0 : h];
  return h < 12 ? [h, h + 12] : h === 12 ? [12, 0] : [h];
}

/** Horas ditas numa oração (texto já normalizado). Data, idade, valor e telefone não contam. */
export function horasDitas(oracao: string): HoraDita[] {
  const out: HoraDita[] = [];
  let t = oracao
    .replace(/\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g, " ")
    .replace(/\bdias?\s+\d{1,2}(?:\s+(?:e|ou|a)\s+\d{1,2})*(?:\s+de\s+[a-z]+)?/g, " ")
    .replace(/\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/g, " ")
    .replace(/\b\d{1,3}(?:st|nd|rd|th)\b/g, " ")
    .replace(/[\w.+-]+@[\w.-]+/g, " ")
    .replace(/\+?\d[\d\s().-]{6,}\d/g, " ");
  // "430", "1130" sozinhos na fala
  t = t.replace(/^\s*(?:as?\s+)?(\d{1,2})([0-5]\d)\s*(am|pm)?\s*$/, " as $1:$2 $3 ");
  if (/\bmeio[ -]?dia\b/.test(t)) out.push({ leituras: [12], min: 0, minutoDito: true });
  const palavras = Object.keys(NUMERO_POR_EXTENSO).join("|");
  t = t.replace(new RegExp(`\\b(?:(as?)\\s+)?(${palavras})(?:\\s+(e\\s+meia))?(\\s+(?:da|de)\\s+(?:manha|tarde|noite)|\\s+horas?)?\\b`, "g"), (m0, as, nome, meia, per) =>
    as || meia || per ? ` as ${NUMERO_POR_EXTENSO[nome]}${meia ? ":30" : ""}${per && !/hora/.test(per) ? per : ""} ` : m0,
  );
  const re =
    /(?<![a-z\d$.,\/-])(\d{1,2})(?:\s?[:h.]\s?(\d{2}))?(?![\d\/])\s*((?:a\.?m\.?|p\.?m\.?|h(?:rs?|s)?|horas?)(?![a-z\d]))?(?:\s*(?:da|de|a)\s+(manha|tarde|noite))?(\s+e\s+meia)?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(t)) !== null) {
    const h = parseInt(m[1], 10);
    if (h > 23) continue;
    const depois = t.slice(re.lastIndex);
    const marcador = m[3] || "";
    const solto = !marcador && !m[2] && !m[4] && !/(?:^|\s)(?:as?|la pelas?|pelas?)\s+$/.test(t.slice(0, m.index));
    if (solto && /^[a-z]/.test(t.slice(m.index + m[1].length))) continue; // "2x", "us06web"
    if (solto && /^\s*(?:anos?|aninhos|filh|mil\b|k\b|%|dolar|reais|meses|mes\b|semanas?|dias?|pessoas?|min|criancas|vezes|opcao|opcoes)/.test(depois)) continue;
    if (solto && /(?:us|usd|r\$|numero|apto|casa)\s*$/.test(t.slice(0, m.index))) continue;
    const min = m[5] ? 30 : m[2] ? parseInt(m[2], 10) : 0;
    if (min > 59) continue;
    out.push({ leituras: leiturasCom(h, `${marcador} ${m[4] || ""}`), min, minutoDito: !!m[2] || !!m[5] || !!marcador });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dias
// ---------------------------------------------------------------------------

/** A oração (normalizada) cita o dia do `alvo`? `base` é o dia em que ela foi dita. */
function citaODia(oracao: string, alvo: Relogio, base: Relogio): boolean {
  const t = oracao;
  const so = (n: number) => somaMinutos({ ...base, h: 12, min: 0 }, n * 1440);
  if (/\bdepois de amanha\b/.test(t)) {
    if (mesmoDia(so(2), alvo)) return true;
  } else if (/\bamanha\b/.test(t) && mesmoDia(so(1), alvo)) return true;
  if (/\bhoje\b/.test(t) && mesmoDia(base, alvo)) return true;
  for (const m of t.matchAll(/\b(domingo|segunda|terca|quarta|quinta|sexta|sabado|monday|tuesday|wednesday|thursday|friday|saturday|sunday|seg|ter|qua|qui|sex|sab|dom)\b(?!\s+(?:opcao|opcoes|vez|alternativa))/g)) {
    if (m[1] === "ter" && /\b(?:vou|vai|de|para|que|vamos|posso|quero)\s+ter\b/.test(t)) continue;
    if (parseWeekdayPt(m[1]) === wd(alvo)) return true;
  }
  for (const m of t.matchAll(/\bdia\s+(\d{1,2})\b|\b(\d{1,2})(?:st|nd|rd|th)\b/g)) {
    if (parseInt(m[1] ?? m[2], 10) === alvo.d) return true;
  }
  for (const d of lerDatas(t)) {
    if ((d.d === alvo.d && d.m === alvo.m) || (d.m === alvo.d && d.d === alvo.m)) return true;
  }
  // "11/14" não é dia/mês: lerDatas não vê, e o lead nos EUA escreve assim
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})\b/g)) {
    if (parseInt(m[1], 10) === alvo.m && parseInt(m[2], 10) === alvo.d) return true;
  }
  return false;
}

/** A oração cita algum dia (qualquer um)? */
export function citaAlgumDia(oracao: string): boolean {
  return /\b(?:hoje|amanha|domingo|segunda|terca|quarta|quinta|sexta|sabado|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b(?!\s+(?:opcao|opcoes|vez|alternativa))|\bdia\s+\d{1,2}\b|\b\d{1,2}(?:st|nd|rd|th)\b|\b\d{1,2}\/\d{1,2}\b|\b\d{1,2}\s+de\s+(?:janeiro|fevereiro|marco|abril|maio|junho|julho|agosto|setembro|outubro|novembro|dezembro)\b/.test(
    oracao,
  );
}

const ACEITE =
  /\b(?:ok|okay|okey|oki|sim|ss|claro|pode|podemos|isso|esse|essa|este|esta|perfeito|otim[oa]|combinado|fechado|fechou|beleza|blz|bom|boa|certo|certinho|confirm\w*|aceito|quero|bora|vamos|show|maravilha|joia|acordo|consigo|serve|funciona|legal|excelente|tranquilo|obrigad[oa]|por favor|por gentileza|exat[oa]|corret[oa]|aham|uhum|positivo|com certeza|primeir[oa]|segund[oa]|ultim[oa]|yes|yep|sure|perfect|good|great|si|dale|listo|agend\w*|marca|marcar|marque)\b|[👍👌✅🙌🤝]/u;
/** Com recusa na mesma fala, "obrigado" e "ok" não aceitam nada: só apontar a opção. */
const ACEITE_DE_OPCAO = /\b(?:primeir[oa]|segund[oa]|ultim[oa]|outr[oa])\s+(?:opcao|horario|data|dia)\b|\b(?:o|a)\s+(?:primeir[oa]|segund[oa]|outr[oa]|ultim[oa])\b/;

const PERIODO: Array<[RegExp, (h: number) => boolean]> = [
  [/\b(?:manha|cedo)\b/, (h) => h < 12],
  [/\btarde\b/, (h) => h >= 12 && h < 18],
  [/\bnoite\b/, (h) => h >= 18],
];

function horaBate(hs: HoraDita[], alvos: Relogio[], oferecido: boolean): boolean {
  return hs.some((x) =>
    alvos.some((a) => x.leituras.includes(a.h) && (x.min === a.min || (!x.minutoDito && x.min === 0 && a.min !== 0 && oferecido))),
  );
}

/**
 * O horário `startIso` foi escolhido pelo lead? `via` diz por onde. Fala vazia ou
 * só com marcador de mídia não dá para julgar: conta como escolhido (o guarda não
 * se aplica).
 */
export function leadEscolheuHorario(p: EscolhaInput): { escolheu: boolean; via: ViaDaEscolha | null } {
  const conta = relogioDaConta(p.startIso, p.fusoLista, p.slotsIso);
  if (!conta) return { escolheu: true, via: "sem_texto" };
  const reuniao = p.reuniaoIso ? relogioDaReuniao(p.reuniaoIso, p.fusoLista) : null;
  const instante = new Date(Date.UTC(conta.y, conta.m - 1, conta.d, conta.h, conta.min));
  const noLead =
    p.fusoLead && p.fusoLead !== p.fusoLista ? somaMinutos(conta, diferencaMinutos(p.fusoLista, p.fusoLead, instante)) : null;
  const alvos = noLead ? [conta, noLead] : [conta];
  const hoje = relogioNoFuso(p.agora, p.fusoLead || p.fusoLista);

  const fala = normalizarFala(semMarcadores(p.mensagem));
  if (!fala.replace(/[^\p{L}\p{N}👍👌✅🙌🤝]/gu, "")) return { escolheu: true, via: "sem_texto" };

  const partes = oracoes(fala);
  const boas = partes.filter((o) => !o.recusa && !o.hesita).map((o) => o.texto);
  const temRecusa = partes.some((o) => o.recusa);

  // O que a gente ofereceu antes: alguma fala traz o dia E a hora deste horário.
  const falas = p.falasAnteriores.slice(0, 4).map((f) => ({
    t: normalizarFala(f.texto),
    base: f.em && !isNaN(Date.parse(f.em)) ? relogioNoFuso(new Date(f.em), p.fusoLista) : relogioNoFuso(p.agora, p.fusoLista),
  }));
  const ofereceDia = (f: { t: string; base: Relogio }) => alvos.some((a) => citaODia(f.t, a, f.base));
  const ofereceHora = (f: { t: string }) => horaBate(horasDitas(f.t.replace(/[,;]/g, " ")), alvos, true);
  const oferecido = falas.some((f) => ofereceDia(f) && ofereceHora(f));
  const ultimaOferta = falas.slice(0, 2).some((f) => ofereceDia(f) && ofereceHora(f));

  const citaDia = boas.some((o) => alvos.some((a) => citaODia(o, a, hoje)));
  const citaOutroDia = !citaDia && boas.some(citaAlgumDia);
  const citaHora = boas.some((o) => horaBate(horasDitas(o), alvos, oferecido));

  // 1. Hora dita por ele, no dia que ele disse; sem dia dito, no dia da reunião
  //    que já existe ou num dia que a gente ofereceu (nunca num dia inventado).
  if (citaHora && (!citaOutroDia || ultimaOferta)) {
    const diaDaReuniao = !!reuniao && alvos.some((a) => mesmoDia(a, reuniao));
    const mesmaHora = !!reuniao && reuniao.h === conta.h && reuniao.min === conta.min;
    if (citaDia || (diaDaReuniao && !mesmaHora) || falas.slice(0, 3).some(ofereceDia) || !reuniao) {
      return { escolheu: true, via: "hora_dita" };
    }
  }
  // 2. Aceite de uma opção que a gente acabou de oferecer.
  const aceite = temRecusa ? ACEITE_DE_OPCAO : ACEITE;
  if (ultimaOferta && !citaOutroDia && boas.some((o) => aceite.test(o))) return { escolheu: true, via: "aceite_da_oferta" };
  // 3. Disse o dia de uma opção oferecida ("sexta").
  if (oferecido && citaDia) return { escolheu: true, via: "dia_ofertado" };
  // 4. Disse o período de uma opção oferecida ("tarde").
  if (ultimaOferta && boas.some((o) => PERIODO.some(([re, vale]) => re.test(o) && alvos.some((a) => vale(a.h))))) {
    return { escolheu: true, via: "periodo_ofertado" };
  }
  // 5. O dia que ele disse só tem este horário livre (agenda de horário único).
  if (citaDia && p.slotsIso) {
    const doDia = new Set(
      p.slotsIso
        .map((s) => new Date(s))
        .filter((d) => !isNaN(d.getTime()))
        .map((d) => relogioNoFuso(d, p.fusoLista))
        .filter((r) => mesmoDia(r, conta))
        .map((r) => `${r.h}:${r.min}`),
    );
    if (doDia.size === 1 && doDia.has(`${conta.h}:${conta.min}`)) return { escolheu: true, via: "unico_horario_do_dia" };
  }
  // 6. "No mesmo horário", no dia que ele disse.
  if (citaDia && reuniao && reuniao.h === conta.h && reuniao.min === conta.min && /\bmesm[oa]s?\s+(?:hora|horario)/.test(fala)) {
    return { escolheu: true, via: "mesmo_horario" };
  }
  // 7. Respondeu citando a nossa mensagem com este horário.
  if (p.citado) {
    const c = { t: normalizarFala(p.citado), base: relogioNoFuso(p.agora, p.fusoLista) };
    if (ofereceDia(c) && ofereceHora(c) && boas.some((o) => aceite.test(o) || citaODia(o, conta, hoje))) {
      return { escolheu: true, via: "citado" };
    }
  }
  return { escolheu: false, via: null };
}

/**
 * Junta as saídas seguidas (bolhas do mesmo turno) numa fala só, da mais nova para
 * a mais velha: o dia costuma vir numa bolha e as horas na seguinte.
 */
export function agruparFalas(
  mensagens: ReadonlyArray<{ direction?: string | null; body?: string | null; dateAdded?: string | null }>,
  max = 5,
): FalaAnterior[] {
  const ordenadas = [...mensagens].sort((a, b) => Date.parse(String(a.dateAdded)) - Date.parse(String(b.dateAdded)));
  const falas: FalaAnterior[] = [];
  let aberta = false;
  for (const m of ordenadas) {
    if (m.direction !== "outbound") {
      aberta = false;
      continue;
    }
    const texto = String(m.body || "").trim();
    if (!texto) continue;
    if (aberta) falas[falas.length - 1].texto += `\n${texto}`;
    else falas.push({ texto, em: m.dateAdded ? String(m.dateAdded) : null });
    aberta = true;
  }
  return falas.reverse().slice(0, max);
}
