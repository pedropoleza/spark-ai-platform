/**
 * Dias em que o lead disse que está fora (H128, chamado 492 da Alves Cury, 06/11/2026).
 *
 * A lead escreveu "esses dias não estarei disponíveis, irei viajar na segunda à noite
 * e retorno no sábado" e a IA ofereceu terça e quinta da mesma semana ("algum desses
 * funciona depois que você voltar?"). O guarda de oferta só pergunta se o horário
 * existe na agenda; horário livre no meio da viagem passava.
 *
 * A ausência é lida do que o lead escreveu na conversa, com a data de cada mensagem
 * ("sábado" é o sábado de quem escreveu), e os horários dela saem da lista ANTES de
 * o modelo ver (mesma escola do H58: dado errado na entrada não se conserta com
 * instrução). A mesma lista alimenta a conferência da oferta e o slot-guard, então
 * oferecer ou agendar dentro da ausência deixa de ser possível. Dia que o lead
 * volta a citar como possível ("quarta às 3 eu consigo") é devolvido.
 *
 * Lê português e só com data ou período ditos. "Estou viajando" sem dizer até
 * quando não tira nada da lista: vira aviso para a IA perguntar.
 *
 * Puro e testável: sem I/O. Datas no plano do calendário (imune a horário de verão);
 * "agora" e o fuso entram por parâmetro.
 */

import { normalizarFala } from "@/lib/queue/escolha-de-horario";
import { diaEMes } from "@/lib/queue/datas-lead";
import { diferencaMinutos } from "@/lib/queue/lead-timezone";
import { separarTextoDoLead } from "@/lib/queue/remarcacao-pos-handoff";
import { lerDias, type MencaoDia } from "@/lib/queue/slot-offer-guard";
import { weekdayNamePt } from "@/lib/account-assistant/weekday-guard";

export interface FalaDaConversa {
  de: "lead" | "nos";
  texto: string;
  /** Quando foi dita (ISO). */
  em: string;
}

/** Intervalo [ini, fim) em minutos do calendário do lead (parede, não instante). */
export interface Ausencia {
  ini: number;
  fim: number;
  /** Qual leitura casou, para a auditoria. */
  regra: string;
  trecho: string;
  ditaEm: string;
}

export interface AusenciasDoLead {
  ausencias: Ausencia[];
  /** No turno atual ele disse que viaja ou está fora, sem dizer até quando. */
  semVolta: boolean;
}

/** Dia do calendário (dias desde 1970). Soma e subtração sem fuso. */
type Dia = number;
const DIA_MS = 86_400_000;
const MIN_DIA = 1440;
const diaDe = (y: number, m: number, d: number): Dia => Math.round(Date.UTC(y, m - 1, d) / DIA_MS);
const partes = (dia: Dia) => {
  const t = new Date(dia * DIA_MS);
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const diaDaSemana = (dia: Dia) => new Date(dia * DIA_MS).getUTCDay();
const segundaDaSemana = (dia: Dia) => dia - ((diaDaSemana(dia) + 6) % 7);

/** Relógio de parede de um instante no fuso, em minutos do calendário. */
function minutosNoFuso(instante: Date, tz: string): number {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  }).formatToParts(instante);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
  return diaDe(g("year"), g("month"), g("day")) * MIN_DIA + (g("hour") % 24) * 60 + g("minute");
}

// ---------------------------------------------------------------------------
// Expressões de data do lead
// ---------------------------------------------------------------------------

type Expr =
  | { tipo: "dia"; dia: Dia }
  | { tipo: "nome"; wd: number; quando: "solto" | "desta" | "proxima" }
  | { tipo: "semana"; ini: Dia; fim: Dia; n: 0 | 1 }
  | { tipo: "fds"; ini: Dia; fim: Dia }
  | { tipo: "mes"; ini: Dia; fim: Dia; parte: "inicio" | "meio" | "fim" | null }
  | { tipo: "duracao"; dias: number };

const NOMES: Record<string, number> = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const NOME_ALT = Object.keys(NOMES).join("|");
const MESES = ["janeiro", "fevereiro", "marco", "abril", "maio", "junho", "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"];
const MES = MESES.join("|");
const NUMEROS: Record<string, number> = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, dez: 10, quinze: 15 };
const NUM_ALT = `\\d{1,2}|${Object.keys(NUMEROS).join("|")}`;
const numero = (s: string) => NUMEROS[s] ?? parseInt(s, 10);

/** A próxima data com esse dia do mês (e mês, se dito), a partir de hoje. */
function proximoDia(d: number, m: number | null, d0: Dia): Dia | null {
  const hoje = partes(d0);
  for (let i = 0; i <= 13; i++) {
    const mes = ((hoje.m - 1 + i) % 12) + 1;
    const y = hoje.y + Math.floor((hoje.m - 1 + i) / 12);
    if (m !== null && mes !== m) continue;
    const cand = diaDe(y, mes, d);
    if (partes(cand).d !== d || cand < d0) continue;
    return cand;
  }
  return null;
}

/** "08/11" do lead: dia/mês ou mês/dia, a leitura que cai mais perto à frente. */
function diaComBarra(a: number, b: number, d0: Dia): Dia | null {
  const cands = [m12(b) ? proximoDia(a, b, d0 - 1) : null, m12(a) ? proximoDia(b, a, d0 - 1) : null].filter(
    (x): x is Dia => x !== null && x - d0 <= 120,
  );
  return cands.length > 0 ? Math.min(...cands) : null;
}
const m12 = (n: number) => n >= 1 && n <= 12;

function mesDe(m: number, d0: Dia): { ini: Dia; fim: Dia } {
  const hoje = partes(d0);
  const y = m >= hoje.m ? hoje.y : hoje.y + 1;
  return { ini: diaDe(y, m, 1), fim: diaDe(m === 12 ? y + 1 : y, (m % 12) + 1, 1) - 1 };
}

interface Modelo {
  /** O texto com cada data trocada por ⟦a⟧, ⟦b⟧... */
  t: string;
  exprs: Expr[];
}

const PREFIXO_NOME = `(?:(?:${NOME_ALT})(?:[\\s-]*feira)?,?\\s+)?`;
const PARTE = "(inicio|comeco|meio|metade|fim|final)";
/** Da mais específica para a mais solta; compiladas uma vez (a conversa inteira passa por aqui). */
const RE_DATA = {
  depoisDeAmanha: /\bdepois de amanha\b/g,
  diaDeMes: new RegExp(`\\b${PREFIXO_NOME}(?:dia\\s+)?(\\d{1,2})\\s+de\\s+(${MES})(?:\\s+de\\s+\\d{4})?\\b`, "g"),
  barra: new RegExp(`\\b${PREFIXO_NOME}(?:dia\\s+)?(\\d{1,2})\\/(\\d{1,2})(?:\\/\\d{2,4})?\\b`, "g"),
  diaN: new RegExp(`\\b${PREFIXO_NOME}dia\\s+(\\d{1,2})\\b(?!\\s*(?:hora|:|h\\b))(?:\\s+d[eo]\\s+(?:mes que vem|proximo mes))?`, "g"),
  ordinal: new RegExp(`\\b${PREFIXO_NOME}(\\d{1,2})(?:st|nd|rd|th)\\b`, "g"),
  nome: new RegExp(
    `\\b((?:proxim[ao]|ess[ae]|est[ae]|ness[ae]|nest[ae])\\s+)?(${NOME_ALT})(?:[\\s-]*feira)?\\b(?!\\s+(?:opcao|vez|alternativa))(\\s+(?:que vem|da semana que vem|da proxima semana|da outra semana|dessa semana|desta semana))?`,
    "g",
  ),
  semanaQueVem: /\b(?:semana que vem|proxima semana|semana seguinte|outra semana)\b/g,
  essaSemana: /\b(?:n|d)?(?:ess|est)a\s+semana\b/g,
  fds: /\b(?:(?:n?o|ness?e|est?e|proximo)\s+)?(?:(?:final|fim)\s+de\s+semana|fds)\b/g,
  mesQueVem: new RegExp(`\\b(?:${PARTE}\\s+d[eo]\\s+)?(?:mes que vem|proximo mes)\\b`, "g"),
  parteDesteMes: new RegExp(`\\b${PARTE}\\s+d[eo]\\s+mes\\b`, "g"),
  parteDeMes: new RegExp(`\\b${PARTE}\\s+de\\s+(${MES})\\b`, "g"),
  mes: new RegExp(`(?<=\\b(?:em|ate|apos|para|mes de|depois de)\\s)(${MES})\\b`, "g"),
  duracao: new RegExp(`\\b(?:daqui(?:\\s+a)?|por|durante|mais)\\s+(${NUM_ALT})\\s+(dia|semana|mes)(?:e?s)?\\b`, "g"),
  amanha: /\bamanha\b/g,
  hoje: /\bhoje\b/g,
};

/** Troca as datas do texto (já normalizado) por marcas e guarda o que cada uma quer dizer. */
function marcarDatas(texto: string, d0: Dia): Modelo {
  const exprs: Expr[] = [];
  let t = texto;
  const trocar = (re: RegExp, f: (m: string[]) => Expr | null) => {
    t = t.replace(re, (...args) => {
      const e = exprs.length < 26 ? f(args as string[]) : null;
      if (!e) return args[0] as string;
      exprs.push(e);
      return `⟦${String.fromCharCode(96 + exprs.length)}⟧`;
    });
  };
  const seg = segundaDaSemana(d0);
  const fimDeSemana = diaDaSemana(d0) === 0 || diaDaSemana(d0) === 6;
  const dia = (x: Dia | null): Expr | null => (x === null ? null : { tipo: "dia", dia: x });
  const parte = (p: string | undefined) => (!p ? null : /inic|comec/.test(p) ? "inicio" : /mei|metad/.test(p) ? "meio" : "fim");
  trocar(RE_DATA.depoisDeAmanha, () => dia(d0 + 2));
  trocar(RE_DATA.diaDeMes, (m) => dia(proximoDia(+m[1], MESES.indexOf(m[2]) + 1, d0 - 1)));
  trocar(RE_DATA.barra, (m) => dia(diaComBarra(+m[1], +m[2], d0)));
  trocar(RE_DATA.diaN, (m) => dia(proximoDia(+m[1], null, d0)));
  trocar(RE_DATA.ordinal, (m) => dia(proximoDia(+m[1], null, d0)));
  trocar(RE_DATA.nome, (m) => ({
    tipo: "nome",
    wd: NOMES[m[2]],
    quando: /proxim|que vem|outra/.test(`${m[1] || ""}${m[3] || ""}`) ? "proxima" : m[1] || m[3] ? "desta" : "solto",
  }));
  trocar(RE_DATA.semanaQueVem, () => ({ tipo: "semana", n: 1, ini: seg + 7, fim: seg + 13 }));
  // "essa semana" dita no sábado ou no domingo é a que vai começar.
  trocar(RE_DATA.essaSemana, () => ({ tipo: "semana", n: 0, ini: d0, fim: fimDeSemana ? seg + 13 : seg + 6 }));
  trocar(RE_DATA.fds, () => {
    const sab = diaDaSemana(d0) === 0 ? d0 - 1 : seg + 5;
    return { tipo: "fds", ini: Math.max(sab, d0), fim: sab + 1 };
  });
  trocar(RE_DATA.mesQueVem, (m) => ({ tipo: "mes", ...mesDe((partes(d0).m % 12) + 1, d0), parte: parte(m[1]) }));
  trocar(RE_DATA.parteDesteMes, (m) => ({ tipo: "mes", ...mesDe(partes(d0).m, d0), parte: parte(m[1]) }));
  trocar(RE_DATA.parteDeMes, (m) => ({ tipo: "mes", ...mesDe(MESES.indexOf(m[2]) + 1, d0), parte: parte(m[1]) }));
  trocar(RE_DATA.mes, (m) => ({ tipo: "mes", ...mesDe(MESES.indexOf(m[1]) + 1, d0), parte: null }));
  trocar(RE_DATA.duracao, (m) => {
    const n = numero(m[1]);
    return n > 0 ? { tipo: "duracao", dias: n * (m[2] === "dia" ? 1 : m[2] === "semana" ? 7 : 30) } : null;
  });
  trocar(RE_DATA.amanha, () => dia(d0 + 1));
  trocar(RE_DATA.hoje, () => dia(d0));
  return { t, exprs };
}

// ---------------------------------------------------------------------------
// O que cada expressão quer dizer como começo, volta, limite
// ---------------------------------------------------------------------------

function porNome(e: Extract<Expr, { tipo: "nome" }>, depoisDe: Dia, d0: Dia): Dia {
  const naSemana = segundaDaSemana(d0) + ((e.wd + 6) % 7);
  if (e.quando === "desta") return naSemana >= d0 ? naSemana : naSemana + 7;
  if (e.quando === "proxima") return naSemana + 7;
  let x = depoisDe + 1;
  while (diaDaSemana(x) !== e.wd) x++;
  return x;
}

const primeiro = (e: Expr, d0: Dia): Dia =>
  e.tipo === "dia" ? e.dia : e.tipo === "nome" ? porNome(e, d0, d0) : e.tipo === "duracao" ? d0 : Math.max(e.ini, d0);

const ultimo = (e: Expr, d0: Dia, depoisDe = d0): Dia =>
  e.tipo === "dia" ? e.dia : e.tipo === "nome" ? porNome(e, depoisDe, d0) : e.tipo === "duracao" ? d0 + e.dias - 1 : e.fim;

const noMes = (e: Extract<Expr, { tipo: "mes" }>, semParte: Dia): Dia =>
  e.parte === "inicio" ? e.ini + 4 : e.parte === "meio" ? e.ini + 14 : e.parte === "fim" ? e.fim : semParte;

/** "Volto no sábado": o dia da volta ainda é de viagem. "Volto semana que vem", "em agosto": até a véspera. */
function ultimoDiaFora(e: Expr, d0: Dia, depoisDe = d0): Dia | null {
  if (e.tipo === "semana") return e.n === 1 ? e.ini - 1 : null;
  if (e.tipo === "mes") return noMes(e, e.ini - 1);
  return ultimo(e, d0, depoisDe);
}

/** "Até dia 27", "até semana que vem": inclusive. "Até agosto": até a véspera. */
const ate = (e: Expr, d0: Dia): Dia => (e.tipo === "mes" ? noMes(e, e.ini - 1) : ultimo(e, d0));
/** "Depois do dia 7", "após 08/11": fora até ele, inclusive. */
const depois = (e: Expr, d0: Dia): Dia => ultimo(e, d0);
/** "A partir de sábado", "só segunda": fora até a véspera. */
const vespera = (e: Expr, d0: Dia): Dia =>
  e.tipo === "mes" ? e.ini - 1 : e.tipo === "duracao" ? d0 + e.dias - 1 : primeiro(e, d0) - 1;

const INICIO_DO_PERIODO: Record<string, number> = { manha: 0, tarde: 12 * 60, noite: 18 * 60 };
const FIM_DO_PERIODO: Record<string, number> = { manha: 12 * 60, tarde: 18 * 60, noite: MIN_DIA };

// ---------------------------------------------------------------------------
// Pistas
// ---------------------------------------------------------------------------

const VIAGEM =
  /\b(?:viaj(?:o|ar|ando|arei|aremos|amos|em)|viagem|ferias|cruzeiro|fora d[oae]s? (?:pais|cidade|estado|eua|brasil|estados unidos)|(?:estarei|estaremos|estou|estamos|vou estar|vamos estar|ficarei|vou ficar|vamos ficar) fora(?! de casa| do trabalho| de area| estatus| do (?:nosso )?(?:horario|expediente)))\b/;
/** Viagem que já passou, sonho ou documento não é ausência. */
const NAO_E_VIAGEM =
  /\b(?:cheguei|voltei|chegamos|voltamos|estava|fui|voltando) (?:de |da )?(?:viaj\w+|viagem|ferias)|\b(?:quero|gosto de|queria|sonho em|planejar|posso|poder|autorizacao|permissao|horas? de) (?:\S+ ){0,3}?(?:viaj\w+|viagem)|\bnao posso viajar|\btodo ano\b|\bagencia de viagem|\bferias acabaram/;
const TERCEIRO =
  /\b(?:meu|minha|o|a)\s+(?:esposo|marido|esposa|mulher|filh\w+|pai|mae|irma|irmao|chefe|patra\w*|namorad\w+|cunhad\w+|prim[oa]|amig[oa])\b|\b(?:ele|ela|eles|elas)\b/;
/** Quem viaja é o lead ("eu e meu esposo vamos viajar"), e não só o marido dele. */
const PRIMEIRA_VIAGEM =
  /\b(?:vou|vamos|estou|to|tou|estamos|estarei|estaremos|irei|iremos)\b(?:\s+\S+){0,3}?\s+(?:viaj\w+|ferias|viagem|fora)\b|\b(?:viajo|viajamos|minha viagem|nossa viagem)\b/;
/** "Estou viajando", "vou viajar", sem dizer quando: só vira aviso para a IA perguntar. */
const VIAJANDO_AGORA =
  /\b(?:estou|to|tou|estamos|estarei|vou estar|vou|irei|vamos)\s+(?:\S+\s+){0,2}?(?:viajando|viajar|de ferias|em viagem|fora d[oae]s? (?:pais|brasil|estado|cidade|eua))\b/;

/** "Se não for quarta", "se não der nessa data": condicional não é recusa. E o "não" não atravessa vírgula. */
const NEGA =
  /(?<!\b(?:se|caso)\s+(?:(?:eu|voce|a gente|nos|ele|ela)\s+)?)\bnao\s+(?!sei\b|so\b)(?:[^\s,;]+\s+){0,3}?(?:posso|consigo|podemos|conseguimos|poderei|conseguirei|poderemos|poderia|conseguiria|vou (?:poder|conseguir?|estar)|vamos (?:poder|conseguir|estar)|vai (?:dar|rolar)|da|dao|dara|daria|tenho (?:como|disponibilidade|horario|tempo)|terei (?:como|disponibilidade|horario|tempo)|estarei dispon\w*|estou dispon\w*|rola|funcionam?|servem?)\b|\bindisponive\w*/;
/** "Não posso pagar hoje", "não consigo assistir hoje": a negação é de outro assunto. */
const OUTRO_ASSUNTO =
  /\b(?:pagar|gastar|contratar|comprar|baixar|abrir|acessar|ouvir|investir|mandar|enviar|responder|assistir|preencher|ver o|ver a|entrar no|entrar na)\b/;
const VOLTOU =
  /\b(?:ja (?:voltei|cheguei|estou de volta)|voltei de viagem|cheguei de viagem|voltei ontem|cheguei ontem|ja estou em casa|cancelei a viagem|viagem (?:foi )?cancelada|nao vou mais viajar|nao viajo mais|desisti da viagem)\b/;
const DIAS_OFERECIDOS = /\b(?:n|d)?(?:ess|est)[ea]s\s+(?:dias|datas)\b|\bnenhuma?\s+d(?:esses|essas|estes|estas)(?:\s+(?:dias|datas|horarios))?\b/;
const OCUPADO_NELES = /\b(?:aula|curso|trabalh\w*|compromissos?|ocupad\w*|estudo)\b/;
/** A recusa é da hora, não do dia: "amanhã não posso esse horário", "quinta às 5 não dá". */
const SO_A_HORA = /\b(?:as?\s+\d{1,2}|\d{1,2}\s*(?:am|pm|h)\b|\d{1,2}:\d{2})|\b(?:n|d)?(?:ess|est)e\s+horario/;
/** "Hoje não consigo, somente depois das 6": o dia vale. */
const SO_DEPOIS_DAS = /\b(?:so|somente|apenas)\b[^.!?\n]{0,30}\b(?:depois|apos|a partir)\s+d[aeo]s?\s+\d/;
/** Ele está PEDINDO esse dia: "poderia remarcar para a próxima terça". */
const PEDE_O_DIA =
  /(?<!\b(?:posso|consigo|poder|conseguir|conseguirei|poderei)\s)\b(?:re ?marc\w+|re ?agend\w+|agendar|marcar|mudar|passar|deix(?:ar|a|e)|pode ser|podemos|poderia|podia|prefiro|seria melhor|melhor|talvez|tem outr\w+|outros horarios|como)\b[^⟦]{0,22}$/;
const SIM_DEPOIS = /^\s*(?:a (?:noite|tarde|manha)|de (?:manha|tarde|noite)|pela manha)?\s*(?:,\s*)?(?:eu\s+|ai\s+|ja\s+)?(?:sim|pode|posso|consigo|da certo|serve|funciona|ok|estou livre|tenho (?:disponibilidade|horario|tempo))\b/;

const D = "⟦([a-z])⟧";
const PERIODO = "(?:\\s+(?:a|de|pela|no periodo da)?\\s*(manha|tarde|noite)\\b)?";
const RE_MARCA = new RegExp(D, "g");
const RE_MARCA_COM_PERIODO = new RegExp(`${D}${PERIODO}`, "g");
const IDA_E_VOLTA = new RegExp(
  `\\b(?:viaj\\w+|viagem|ferias|fora|saio|saindo|embarco)\\b[^.!?⟦]{0,40}?${D}${PERIODO}[.!?]?[^.!?⟦]{0,40}?\\b(?:volt\\w+|retorn\\w+|regress\\w+|cheg\\w+)\\b[^.!?\\n⟦]{0,30}?${D}`,
);
const INTERVALO = new RegExp(`\\b(?:de|da|do|entre|desde)\\s+(?:a\\s+|o\\s+)?${D}${PERIODO}\\s+(?:a|ate|ao|e)\\s+(?:a\\s+|o\\s+)?${D}`);
const ATE = new RegExp(`\\bate\\s+(?:o\\s+|a\\s+|la\\s+)?${D}`);
const VOLTA = new RegExp(
  `(?:\\b(so|somente|apenas)\\s+(?:eu\\s+)?)?(?<!\\b(?:te|lhe|um|o|seu|meu|de|do|dar|dou|darei|em|aguardo|algum)\\s)\\b(volto|voltarei|voltaremos|voltamos|vou voltar|retorno|retornarei|retornaremos|regresso|regressar|(?:estarei|estaremos|vou estar) (?:de volta|retornando|voltando)|chego|chegarei|de volta|estou (?:retornando|voltando))\\b(?!\\s+a\\s+\\w+r\\b|\\s+para\\s+o\\s+brasil)([^.!?\\n⟦]{0,25}?)${D}`,
);
const VOLTA_INVERTIDA = new RegExp(`${D}[^.!?\\n⟦]{0,25}?\\b(?:chego|volto|retorno|regresso|(?:estou|estarei|estaremos|vou estar) de volta)\\b`);
/** "Podemos agendar na semana que vem, estou de férias ainda." */
const DEIXAR_PARA = new RegExp(
  `\\b(?:agendar|marcar|remarcar|falar|conversar|combinar|retomar|fazer|deix(?:ar|a))\\b(?:\\s+\\w+){0,2}?\\s+(?:para|na|no|em)\\s+(?:a\\s+|o\\s+)?${D}`,
);
const SO_DEPOIS = new RegExp(
  `(?<!\\bnao )\\b(?:so|somente|apenas|posso|podemos|pode ser|consigo|disponive\\w+)\\b[^.!?\\n⟦]{0,60}?\\b(depois|apos|a partir)\\s+(?:d[eoa]s?\\s+)?(?:o\\s+|a\\s+)?${D}`,
);
const A_PARTIR_POSSO = new RegExp(`\\ba partir\\s+d[eoa]\\s+${D}[^.!?\\n⟦]{0,25}?\\b(?:posso|consigo|estou|estarei|fico|vou estar)\\b`);
const SO_EM = new RegExp(
  `(?<!\\bnao )\\b(?:so|somente|apenas)\\s+(?:(?:a|na|no|em|para|la|eu|posso|consigo|vou|poder|conseguir|tenho|disponibilidade|horario|estarei|disponivel)\\s+){0,5}?${D}`,
);
/** "…terça e quinta": os outros dias da mesma lista. */
const MAIS_DIAS = "(?:\\s*(?:,|e|ou)\\s*(?:(?:a|o|na|no)\\s+)?⟦[a-z]⟧)*";
/** "Só terça e quinta, né?", "só na quinta?": pergunta sobre a NOSSA agenda, não é a disponibilidade dele. */
const PERGUNTA_DA_AGENDA = new RegExp(
  `^${MAIS_DIAS}\\s*,?\\s*(?:(?:mesmo|certo|nao e|e isso|que (?:voces?|ela|ele) tem)?\\s*\\?|(?:mesmo\\s+)?ne\\b)`,
);
/** "Só segunda e terça que eu tenho aula": é o contrário, nesses ele não pode. */
const SO_NELES_OCUPADO = new RegExp(
  `^${MAIS_DIAS}\\s*(?:e\\s+)?que\\s+(?:eu\\s+)?(?:trabalho\\b|nao\\b|tenho\\s+(?!tempo|horario|folga|disponib|livre)|(?:estou|to|tou)\\s+(?!livre|disponiv|de folga|em casa|tranquil))`,
);
/** "Essa semana não, a não ser na quarta", "se não for quarta, só semana que vem": a quarta ele pode. */
const EXCECAO = new RegExp(
  `\\b(se\\s+(?:(?:eu|voce|a gente)\\s+)?nao\\s+(?:for|der|tiver|tem|houver|puder|conseguir|rolar)|a nao ser|exceto|tirando|salvo|(?<!\\b(?:ou|pelo)\\s)menos)\\b[^.!?,\\n⟦]{0,20}?(${D}${MAIS_DIAS})`,
);

interface LeituraDaMensagem {
  ausencias: Ausencia[];
  /** Dias que ele citou fora de recusa. `pediu` = pediu ou disse que consegue; `excecao` = "só na quarta". */
  possiveis: Array<{ dia: Dia; wd: number | null; pediu: boolean; excecao?: boolean }>;
  viagemSemData: boolean;
}

/** Lê UMA mensagem do lead. `d0` é o dia em que ela foi escrita, no calendário dele. */
function lerMensagem(bruto: string, d0: Dia, em: string, oferecidos: readonly Dia[]): LeituraDaMensagem {
  const vazio: LeituraDaMensagem = { ausencias: [], possiveis: [], viagemSemData: false };
  const { proprio } = separarTextoDoLead(bruto);
  if (!proprio || proprio.length > 900) return vazio;
  // "Volto em⏎Setembro": linha que acaba em preposição continua na de baixo; as outras fecham a frase.
  const { t, exprs } = marcarDatas(normalizarFala(proprio).replace(/\b(em|na|no|ate|de|do|dia|para|so|e|ou|apos)\s*\n\s*/g, "$1 "), d0);
  const frases = t.split(/[.!?\n]+/).filter((s) => s.trim());
  const viaja = frases.some((f) => VIAGEM.test(f) && !NAO_E_VIAGEM.test(f) && (!TERCEIRO.test(f) || PRIMEIRA_VIAGEM.test(f)));
  const nega = frases.some((f) => NEGA.test(f) && !OUTRO_ASSUNTO.test(f));
  const ausencias: Ausencia[] = [];
  const usadas = new Set<string>();
  const expr = (letra: string) => exprs[letra.charCodeAt(0) - 97];
  const guardar = (ini: Dia, ultimoDia: Dia | null, regra: string, letras: string[], iniMin = 0, fimMin = MIN_DIA) => {
    if (ultimoDia === null || ultimoDia < ini || ultimoDia - d0 > 120) return false;
    for (const l of letras) usadas.add(l);
    ausencias.push({ ini: ini * MIN_DIA + iniMin, fim: ultimoDia * MIN_DIA + fimMin, regra, trecho: proprio.slice(0, 200), ditaEm: em });
    return true;
  };
  const livre = (...ls: string[]) => ls.every((l) => l && !usadas.has(l));
  const fraseDe = (l: string) => frases.find((f) => f.includes(`⟦${l}⟧`)) ?? t;
  /** A recusa vale para a frase dela; a viagem, para a mensagem. */
  const foraNaFrase = (l: string) => viaja || (NEGA.test(fraseDe(l)) && !OUTRO_ASSUNTO.test(fraseDe(l)));
  const possiveis: LeituraDaMensagem["possiveis"] = [];
  /** O dia (ou a lista) que ele deixou de fora da recusa. */
  const excetuar = (trecho: string) => {
    for (const x of trecho.matchAll(RE_MARCA)) {
      const e = expr(x[1]);
      if (e?.tipo !== "dia" && e?.tipo !== "nome") continue;
      usadas.add(x[1]);
      possiveis.push({ dia: primeiro(e, d0), wd: e.tipo === "nome" ? e.wd : null, pediu: true, excecao: true });
    }
  };

  let m = EXCECAO.exec(t);
  if (m) {
    // "qualquer dia menos quarta", "trabalho todos os dias exceto domingo": serve para os dois lados, não se lê
    const deTodos = /\b(?:qualquer|todos?)\b/.test(t.slice(0, m.index));
    if (m[1].startsWith("se") || ((nega || viaja) && !deTodos)) excetuar(m[2]);
    else if (deTodos) for (const x of m[2].matchAll(RE_MARCA)) usadas.add(x[1]);
  }
  m = IDA_E_VOLTA.exec(t);
  if (m && viaja && livre(m[1], m[3])) {
    const ini = primeiro(expr(m[1]), d0);
    guardar(ini, ultimoDiaFora(expr(m[3]), d0, ini), "ida_e_volta", [m[1], m[3]], INICIO_DO_PERIODO[m[2]] ?? 0);
  }
  m = INTERVALO.exec(t);
  // "não posso falar agora, trabalho de segunda a sexta" é rotina, não ausência
  if (m && foraNaFrase(m[1]) && !/\btrabalh\w*\s+$/.test(t.slice(0, m.index)) && livre(m[1], m[3])) {
    const ini = primeiro(expr(m[1]), d0);
    guardar(ini, ultimo(expr(m[3]), d0, ini), "intervalo", [m[1], m[3]], INICIO_DO_PERIODO[m[2]] ?? 0);
  }
  m = ATE.exec(t);
  if (m && foraNaFrase(m[1]) && livre(m[1])) guardar(d0, ate(expr(m[1]), d0), "ate", [m[1]]);
  m = VOLTA.exec(t);
  if (m && livre(m[4])) {
    const e = expr(m[4]);
    const rotina = /\b(?:licenca|servico|trabalh\w+|escola|aulas?)\b/.test(fraseDe(m[4])) && !viaja;
    const longe = e.tipo !== "dia" || e.dia - d0 >= 2;
    if (!rotina && (viaja || m[1] || (longe && !/^(?:cheg|de volta)/.test(m[2])))) {
      guardar(d0, /\b(?:depois|apos)\b/.test(m[3]) ? depois(e, d0) : ultimoDiaFora(e, d0), "volta", [m[4]]);
    }
  }
  m = VOLTA_INVERTIDA.exec(t);
  if (m && viaja && livre(m[1])) guardar(d0, ultimoDiaFora(expr(m[1]), d0), "volta", [m[1]]);
  m = SO_DEPOIS.exec(t);
  if (m && livre(m[2])) guardar(d0, m[1] === "a partir" ? vespera(expr(m[2]), d0) : depois(expr(m[2]), d0), "so_depois", [m[2]]);
  m = A_PARTIR_POSSO.exec(t);
  if (m && livre(m[1])) guardar(d0, vespera(expr(m[1]), d0), "so_depois", [m[1]]);
  m = SO_EM.exec(t);
  if (m && livre(m[1])) {
    const antes = t.slice(Math.max(0, m.index - 16), m.index);
    const depoisDele = t.slice(m.index + m[0].length, m.index + m[0].length + 45);
    const resto = t.slice(m.index + m[0].length);
    // "fumo só fds", "recebo só na sexta", "só na segunda sei minha folga", "só quarta de manhã, os outros dias às 5"
    if (
      !/\b(?:fumo|fuma|bebo|trabalho|recebo|pago|folgo|seria|era|foi|sera|viajo|viajar|viajarei|viajaremos|embarco)\s+$/.test(antes) && !/\b(?:pag\w+|recebo|sei)\b/.test(depoisDele) &&
      !PERGUNTA_DA_AGENDA.test(resto) && !SO_NELES_OCUPADO.test(resto) && !/\b(?:outros|demais) dias\b/.test(t)
    ) {
      guardar(d0, vespera(expr(m[1]), d0), "so_em", [m[1]]);
      excetuar(m[0] + (new RegExp(`^${MAIS_DIAS}`).exec(resto)?.[0] ?? ""));
    }
  }
  m = DEIXAR_PARA.exec(t);
  if (m && (viaja || nega) && livre(m[1]) && ((e) => e.tipo === "mes" || (e.tipo === "semana" && e.n === 1))(expr(m[1]))) {
    guardar(d0, vespera(expr(m[1]), d0), "deixar_para", [m[1]]);
  }

  // "Estou de férias agora. Daqui uma semana."
  if (viaja) {
    for (const x of t.matchAll(RE_MARCA)) {
      const e = expr(x[1]);
      if (livre(x[1]) && e.tipo === "duracao") guardar(d0, ultimo(e, d0), "duracao", [x[1]]);
    }
  }

  // Dia citado na própria frase da recusa ou da viagem: "segunda eu vou estar em viagem".
  for (const o of t.split(/[.!?;\n]+|(?<!⟧\s?),(?!\s*(?:e\s+)?⟦)|\b(?:mas|porem|so que|entretanto)\b/)) {
    const neg = OUTRO_ASSUNTO.test(o) ? null : NEGA.exec(o);
    const via = viaja ? VIAGEM.exec(o) : null;
    for (const x of o.matchAll(RE_MARCA_COM_PERIODO)) {
      const e = expr(x[1]);
      if (!e || usadas.has(x[1])) continue;
      const ini = x.index!;
      const fim = ini + x[0].length;
      const antes = o.slice(Math.max(0, ini - 40), ini);
      const pediu = SIM_DEPOIS.test(o.slice(ini + 3, ini + 45)) || PEDE_O_DIA.test(antes);
      // a pista tem que estar perto do dia e sem outra ideia no meio ("amanhã à noite, que hoje não consigo")
      const perto = (c: RegExpExecArray | null): string | null => {
        if (!c) return null;
        const entre = c.index >= fim ? o.slice(fim, c.index) : o.slice(Math.min(c.index + c[0].length, ini), ini);
        return entre.length <= 45 && !/\b(?:que|pode|podia|sim|melhor|prefiro|nao sei)\b/.test(entre) ? entre : null;
      };
      // "não tenho tempo de manhã, somente quarta": o que vem depois do "somente" não é o recusado
      const entreNeg = perto(neg);
      const porNegar = entreNeg !== null && !/\b(?:so|somente|apenas)\b/.test(entreNeg);
      const porViajar = perto(via) !== null;
      if ((porNegar || porViajar) && !pediu && e.tipo !== "duracao") {
        if (/\b(?:depois|antes|a partir) d[eoa]s?\s+$|\bapos\s+$/.test(antes)) continue; // "não posso depois de sexta"
        if (!porViajar && (SO_A_HORA.test(o) || frases.some((f) => f.includes(`⟦${x[1]}⟧`) && SO_DEPOIS_DAS.test(f)))) continue;
        guardar(
          primeiro(e, d0), ultimo(e, d0), porViajar ? "viagem_no_dia" : "recusa_do_dia", [x[1]],
          x[2] ? INICIO_DO_PERIODO[x[2]] : 0, x[2] && !porViajar ? FIM_DO_PERIODO[x[2]] : MIN_DIA,
        );
      } else if ((e.tipo === "dia" || e.tipo === "nome") && (pediu || !(neg || via || OCUPADO_NELES.test(o)))) {
        possiveis.push({ dia: primeiro(e, d0), wd: e.tipo === "nome" ? e.wd : null, pediu });
      }
    }
  }

  // "Esses dias não consigo": são os que acabamos de oferecer. Recusa de HORÁRIO
  // ("nenhum desses horários") e passado ("estive ocupada todos esses dias") não contam.
  const fraseDosDias = frases.find((f) => DIAS_OFERECIDOS.test(f));
  const recusaOferecidos =
    !!fraseDosDias &&
    !/\bhorarios?\b|\btodos esses\b|\b(?:estive|estava|fiquei|andei|passei)\b/.test(fraseDosDias) &&
    (nega || viaja || OCUPADO_NELES.test(t) || /\bnenhum/.test(fraseDosDias)) &&
    (oferecidos.length > 1 || /\b(?:dias?|datas?)\b/.test(fraseDosDias));
  if (recusaOferecidos) for (const o of oferecidos.slice(0, 4)) guardar(o, o, "dias_oferecidos", []);
  return { ausencias, possiveis, viagemSemData: ausencias.length === 0 && viaja && VIAJANDO_AGORA.test(t) };
}

// ---------------------------------------------------------------------------
// A conversa inteira
// ---------------------------------------------------------------------------

/** Tira o dia do meio das ausências (o lead disse que nele consegue). */
function devolverDia(lista: Ausencia[], dia: Dia): Ausencia[] {
  const a = dia * MIN_DIA;
  const b = a + MIN_DIA;
  return lista.flatMap((x) => {
    if (b <= x.ini || a >= x.fim) return [x];
    return [
      ...(x.ini < a ? [{ ...x, fim: a }] : []),
      ...(x.fim > b ? [{ ...x, ini: b }] : []),
    ];
  });
}

/** "Domingo pode!" devolve também o domingo que a gente tinha oferecido, ainda que não seja o próximo. */
function devolverPossivel(lista: Ausencia[], p: { dia: Dia; wd: number | null; excecao?: boolean }): Ausencia[] {
  const semOferecido = p.wd === null ? lista : lista.filter((a) => a.regra !== "dias_oferecidos" || diaDaSemana(Math.floor(a.ini / MIN_DIA)) !== p.wd);
  // "semana que vem não consigo, exceto quinta": a quinta de dentro da ausência
  const dentro = (dia: Dia) => semOferecido.some((a) => dia * MIN_DIA < a.fim && (dia + 1) * MIN_DIA > a.ini);
  const dia = p.excecao && p.wd !== null ? ([0, 7, 14].map((n) => p.dia + n).find(dentro) ?? p.dia) : p.dia;
  return devolverDia(semOferecido, dia);
}

/** Dias que uma fala nossa cita, resolvidos a partir do dia em que ela saiu. */
export function diasQueOferecemos(texto: string, d0: Dia): Dia[] {
  const out = new Set<Dia>();
  for (const x of lerDias(texto)) {
    const r = resolver(x, d0);
    if (r !== null) out.add(r);
  }
  return [...out];
}

function resolver(x: MencaoDia, d0: Dia): Dia | null {
  if (x.data) return proximoDia(x.data.d, x.data.m, d0 - 1);
  if (x.relativo !== null) return d0 + x.relativo;
  if (x.diaSemana === null) return null;
  let dia = d0;
  while (diaDaSemana(dia) !== x.diaSemana) dia++;
  return dia;
}

/**
 * Aceite de um dia que a gente ofereceu DEPOIS da ausência (a equipe, por exemplo). "Ok, obrigada" e
 * "mas tá tudo bem" são despedida.
 */
const ACEITE_CURTO = /^(?:(?:ta|esta) tudo bem|sim|pode|podemos|isso|perfeito|otimo|combinado|fechado|confirmo|confirmado|aceito|serve|funciona)\b(?!.*\bobrigad)/;

/**
 * Lê as ausências ditas na conversa, em ordem. `tz` é o fuso do lead (ou o da conta,
 * quando não se sabe). Só volta o que ainda não passou.
 */
export function lerAusencias(falas: readonly FalaDaConversa[], tz: string, agora: Date): AusenciasDoLead {
  const ordenadas = falas.filter((f) => !isNaN(Date.parse(f.em))).sort((a, b) => Date.parse(a.em) - Date.parse(b.em));
  const agoraMin = minutosNoFuso(agora, tz);
  let ausencias: Ausencia[] = [];
  let oferecidos: Dia[] = [];
  let ultimaFoiNossa = false;
  let semVolta = false;
  let ultimoTexto = "";
  for (const f of ordenadas) {
    const d0 = Math.floor(minutosNoFuso(new Date(f.em), tz) / MIN_DIA);
    if (f.de === "nos") {
      const dias = diasQueOferecemos(f.texto, d0);
      oferecidos = ultimaFoiNossa ? [...new Set([...oferecidos, ...dias])] : dias.length > 0 ? dias : oferecidos;
      ultimaFoiNossa = true;
      continue;
    }
    ultimaFoiNossa = false;
    const t = normalizarFala(f.texto);
    // O mesmo texto chega por WhatsApp e SMS: lê uma vez.
    if (t && t === ultimoTexto) continue;
    ultimoTexto = t;
    if (VOLTOU.test(t)) {
      ausencias = [];
      semVolta = false;
    }
    const r = lerMensagem(f.texto, d0, f.em, oferecidos);
    for (const p of r.possiveis) ausencias = devolverPossivel(ausencias, { ...p, excecao: false });
    if (r.possiveis.length === 0 && r.ausencias.length === 0 && ACEITE_CURTO.test(t) && !NEGA.test(t) && !t.includes("?")) {
      for (const dia of oferecidos) ausencias = devolverDia(ausencias, dia);
    }
    // "viajo segunda e volto sábado, mas quarta eu consigo": o dia que ele pediu fica.
    let novas = r.ausencias;
    for (const p of r.possiveis) if (p.pediu) novas = devolverPossivel(novas, p);
    ausencias.push(...novas);
    semVolta = r.viagemSemData;
  }
  return { ausencias: ausencias.filter((a) => a.fim > agoraMin), semVolta };
}

// ---------------------------------------------------------------------------
// Uso: filtro da lista, texto, janela
// ---------------------------------------------------------------------------

/** O horário cai dentro de alguma ausência (no calendário do lead)? */
export function dentroDaAusencia(iso: string, ausencias: readonly Ausencia[], tz: string): boolean {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return false;
  const min = minutosNoFuso(d, tz);
  return ausencias.some((a) => min >= a.ini && min < a.fim);
}

/** Tira da resposta do free-slots os horários dentro das ausências. Dia vazio sai. */
export function filtrarSlotsDaAusencia(
  slotsResp: Record<string, unknown>,
  ausencias: readonly Ausencia[],
  tz: string,
): Record<string, unknown> {
  if (ausencias.length === 0) return slotsResp;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slotsResp)) {
    if (key === "traceId" || !value || typeof value !== "object") {
      out[key] = value;
      continue;
    }
    const v = value as Record<string, unknown>;
    const slots = Array.isArray(v.slots) ? (v.slots as string[]) : Array.isArray(value) ? (value as string[]) : [];
    const fora = slots.filter((s) => !dentroDaAusencia(s, ausencias, tz));
    if (fora.length > 0) out[key] = { ...(Array.isArray(value) ? {} : v), slots: fora };
  }
  return out;
}

/** Dias com horário numa resposta de free-slots. */
export function diasComHorario(slotsResp: Record<string, unknown>): number {
  return Object.entries(slotsResp).filter(([k, v]) => k !== "traceId" && !!v && Array.isArray((v as { slots?: unknown[] }).slots) && (v as { slots: unknown[] }).slots.length > 0).length;
}

/** Junta duas respostas de free-slots (a 2ª completa os dias que faltam). */
export function juntarSlots(a: Record<string, unknown>, b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...a };
  for (const [k, v] of Object.entries(b)) if (!(k in out)) out[k] = v;
  return out;
}

/**
 * Depois de filtrar sobrou menos de 2 dias na janela consultada: de quando buscar mais
 * horários (a volta do lead ou o fim da janela, o que vier depois), ou null. Ausência
 * que só começa depois da janela não conta, e volta a mais de 60 dias não se oferece.
 */
export function buscarMaisHorariosDesde(
  slotsFiltrados: Record<string, unknown>,
  ausencias: readonly Ausencia[],
  tz: string,
  agora: Date,
  fimDaJanela: Date,
): Date | null {
  if (diasComHorario(slotsFiltrados) >= 2) return null;
  const fimJanelaMin = minutosNoFuso(fimDaJanela, tz);
  const naJanela = ausencias.filter((a) => a.ini <= fimJanelaMin);
  if (naJanela.length === 0) return null;
  const aprox = new Date(Math.max(...naJanela.map((a) => a.fim)) * 60_000);
  const volta = new Date(aprox.getTime() - diferencaMinutos("UTC", tz, aprox) * 60_000);
  const desde = new Date(Math.max(volta.getTime(), fimDaJanela.getTime()));
  return desde.getTime() - agora.getTime() > 60 * DIA_MS ? null : desde;
}

const nomeDoDia = (dia: Dia) => {
  const p = partes(dia);
  return `${weekdayNamePt(diaDaSemana(dia))}, ${diaEMes(p)}`;
};

/** "de segunda-feira, 9 de novembro (à noite) a sábado, 14 de novembro". */
export function rotuloDasAusencias(ausencias: readonly Ausencia[], tz: string, agora: Date): string {
  const agoraMin = minutosNoFuso(agora, tz);
  const juntas: Array<{ ini: number; fim: number }> = [];
  for (const a of [...ausencias].sort((x, y) => x.ini - y.ini)) {
    const ult = juntas[juntas.length - 1];
    if (ult && a.ini <= ult.fim) ult.fim = Math.max(ult.fim, a.fim);
    else juntas.push({ ini: a.ini, fim: a.fim });
  }
  return juntas
    .map(({ ini, fim }) => {
      const d1 = Math.floor(ini / MIN_DIA);
      const d2 = Math.floor((fim - 1) / MIN_DIA);
      const parteIni = ini % MIN_DIA >= 18 * 60 ? " (à noite)" : ini % MIN_DIA >= 12 * 60 ? " (à tarde)" : "";
      const parteFim = fim % MIN_DIA === 12 * 60 ? " (até meio-dia)" : fim % MIN_DIA === 18 * 60 ? " (até o fim da tarde)" : "";
      if (d1 === d2) return `${nomeDoDia(d1)}${parteIni}${parteFim}`;
      if (ini <= agoraMin) return `até ${nomeDoDia(d2)}${parteFim}`;
      return `de ${nomeDoDia(d1)}${parteIni} a ${nomeDoDia(d2)}${parteFim}`;
    })
    .join("; ");
}

/**
 * Datas EXPLÍCITAS ("10/11", "10 de novembro", "amanhã") que a fala oferece dentro da
 * ausência, sem hora junto (com hora, a conferência da oferta já acusa, porque o
 * horário saiu da lista). Citar a viagem dele ("você volta no sábado, 14") não é oferta.
 */
export function datasOferecidasNaAusencia(
  bolhas: readonly string[],
  ausencias: readonly Ausencia[],
  tz: string,
  agora: Date,
): Array<{ bolha: number; trecho: string }> {
  if (ausencias.length === 0) return [];
  const d0 = Math.floor(minutosNoFuso(agora, tz) / MIN_DIA);
  const out: Array<{ bolha: number; trecho: string }> = [];
  bolhas.forEach((b, i) => {
    for (const f of b.match(/[^.!?\n]+[.!?]*/g) || []) {
      for (const x of lerDias(f)) {
        if (!x.data && x.relativo === null) continue;
        const dia = resolver(x, d0);
        if (dia === null) continue;
        const inteiro = ausencias.some((a) => a.ini <= dia * MIN_DIA + 8 * 60 && a.fim >= dia * MIN_DIA + 20 * 60);
        if (!inteiro) continue;
        const antes = f.slice(Math.max(0, x.inicio - 45), x.inicio);
        if (/viag|viaj|volt|retorn|cheg|fora|f[ée]rias|depois\s+d|ap[óo]s|partir|n[ãa]o\s+(?:tenho|temos|tem|h[áa])|at[ée]\s*(?:o\s+dia\s*)?$/iu.test(antes)) continue;
        if (!/\b(?:tenho|temos|tem|consigo|prefere|qual|pode\s+ser|dispon[íi]ve|vaga|encaix|que\s+tal|op[çc][ãa]o|hor[áa]rio)/iu.test(f)) continue;
        out.push({ bolha: i, trecho: f.slice(x.inicio, x.fim).trim() });
      }
    }
  });
  return out;
}
