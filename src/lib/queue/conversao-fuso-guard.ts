/**
 * "2 da tarde no seu horário (3 PM ET)" conferido pelo código (H130, chamado 548
 * da Alves Cury, 23/11/2026).
 *
 * Lead de Utah (MT, 2 h a menos que o ET) recebeu "às 9h30 da manhã ou às 2 da tarde
 * no seu horário (10:30 AM ET ou 3 PM ET)": 1 h de diferença. A confirmação saiu
 * certa porque é conferida com o slot (H115). A oferta era texto livre: o guarda de
 * oferta só olha frase com dia e hora juntos, e as duas leituras existiam na agenda.
 * Medido na frota de 04 a 25/11: 5 das 17 mensagens com as duas horas saíram com a
 * conta errada (Utah 2, Havaí 1, e 2 de Connecticut em que "CT" foi lido como fuso
 * central, ver `fusoNaFalaDoLead`).
 *
 * Aqui cada PAR (hora do lead + hora da conta) passa pelo mesmo conversor da
 * confirmação. Quando não bate, vale a hora da conta, que é a da lista e a que é
 * agendada; a do lead é recalculada. Só se a da conta não existir na agenda e a do
 * lead existir é que a da conta é corrigida. Sem saber o fuso do lead, "no seu
 * horário" não é afirmado: fica a hora da conta, com o nome do fuso.
 *
 * Puro e testável: sem I/O; "agora" e os fusos entram por parâmetro.
 */

import {
  detectarFusoNoTexto,
  diferencaMinutos,
  horaEmIngles,
  horaFalada,
  mesmoFuso,
  nomeDoFuso,
} from "@/lib/queue/lead-timezone";
import { indexarSlots, lerDias, lerHoras, RE_SEU_HORARIO, type MencaoDia, type MencaoHora } from "@/lib/queue/slot-offer-guard";

export interface ConversaoInput {
  /** Fuso da conta (o da lista de horários). */
  fusoLista: string;
  /** Fuso do lead, quando conhecido. */
  fusoLead?: string | null;
  slotsIso?: readonly string[];
  agora?: Date;
}

export interface ConversaoResult {
  messages: string[];
  /** O que foi trocado, para a auditoria. */
  correcoes: string[];
  /** Quantos pares (ou "no seu horário" solto) foram conferidos. */
  conferidos: number;
}

interface Hm {
  h: number;
  min: number;
}

/** Uma hora do texto da bolha, com a posição nela. */
interface Hora extends MencaoHora {
  texto: string;
}

/** Um par: a hora do lead e a da conta, cada uma no seu fuso (null = não se sabe). */
interface Par {
  lead: Hora;
  conta: Hora;
  fusoDoLead: string | null;
  fusoDaConta: string;
}

interface Troca {
  ini: number;
  fim: number;
  novo: string;
}

const desloca = (hm: Hm, minutos: number): Hm => {
  const t = (((hm.h * 60 + hm.min + minutos) % 1440) + 1440) % 1440;
  return { h: Math.floor(t / 60), min: t % 60 };
};

/** A hora nova escrita no estilo da antiga ("às 9h30 da manhã" → "às 8h30 da manhã"). */
export function noEstiloDe(original: string, hm: Hm): string {
  const prefixo = /^[àa]s\s+/i.exec(original)?.[0] ?? "";
  const corpo = original.slice(prefixo.length);
  const ampm = /\s*[ap]\.?m\.?\s*$/i.exec(corpo);
  if (ampm) {
    let txt = horaEmIngles(hm.h, hm.min);
    if (/:/.test(corpo) && hm.min === 0) txt = txt.replace(" ", ":00 ");
    if (!/\s[ap]\.?m/i.test(corpo)) txt = txt.replace(" ", "");
    return prefixo + (/[AP]\.?M/.test(corpo) ? txt : txt.toLowerCase());
  }
  if (/\d\s*h/i.test(corpo)) {
    const temPeriodo = /da\s+(?:manh|tarde|noite)/i.test(corpo);
    const h = temPeriodo ? hm.h % 12 || 12 : hm.h;
    const periodo = temPeriodo ? horaFalada(hm.h, 0).replace(/^\d+\s/, " ") : "";
    return `${prefixo}${h}h${hm.min ? String(hm.min).padStart(2, "0") : ""}${periodo}`;
  }
  return prefixo + horaFalada(hm.h, hm.min);
}

/** Dias que a menção pode ser, em "YYYY-MM-DD" (a data dita ou o próximo com esse nome). */
function datasPossiveis(dia: MencaoDia | null, agora: Date, tz: string): string[] | null {
  if (!dia) return null;
  const p = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(agora);
  const g = (t: string) => parseInt(p.find((x) => x.type === t)?.value || "0", 10);
  const soma = (n: number) => new Date(Date.UTC(g("year"), g("month") - 1, g("day") + n));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  const out: string[] = [];
  for (let i = 0; i <= 35; i++) {
    const d = soma(i);
    if (dia.relativo !== null && i === dia.relativo) out.push(iso(d));
    else if (dia.data && d.getUTCDate() === dia.data.d && d.getUTCMonth() + 1 === dia.data.m) out.push(iso(d));
    else if (!dia.data && dia.relativo === null && dia.diaSemana !== null && d.getUTCDay() === dia.diaSemana && i <= 13) out.push(iso(d));
  }
  return out.length > 0 ? out : null;
}

/** Fim da frase anterior: o par só vale dentro da mesma frase. */
function inicioDaFrase(b: string, ate: number): number {
  let ini = 0;
  for (const m of b.slice(0, ate).matchAll(/[!?\n]|\.(?=\s)/g)) ini = m.index! + 1;
  return ini;
}

const horasEm = (b: string, ini: number, fim: number): Hora[] =>
  lerHoras(b.slice(ini, fim)).map((h) => ({ ...h, inicio: h.inicio + ini, fim: h.fim + ini, texto: b.slice(h.inicio + ini, h.fim + ini) }));

type Rotulo = { tipo: "lead" } | { tipo: "fuso"; tz: string } | { tipo: "outro" } | null;

/**
 * De quem é a hora, pelo que vem escrito junto dela: "no seu horário", "ET", "no
 * Havaí". `null` = nada escrito; "outro" = um lugar que não sabemos ler ("horário de
 * Portugal"), e aí o par não é conferido.
 */
function rotulo(txt: string): Rotulo {
  const f = detectarFusoNoTexto(txt);
  if (f) return { tipo: "fuso", tz: f.tz };
  if (/\b(?:brasil|bras[íi]lia|s[ãa]o\s+paulo)(?![\p{L}])/iu.test(txt)) return { tipo: "fuso", tz: "America/Sao_Paulo" };
  if (RE_SEU_HORARIO.test(txt)) return { tipo: "lead" };
  return /hor[áa]rio|fuso|hora\s+d|\b(?:em|no|na|de|do|da)\s+\p{Lu}/u.test(txt) ? { tipo: "outro" } : null;
}

/** Grupos "X (Y)" e "X = Y" da bolha, cada hora casada com a da mesma posição. */
function lerPares(b: string, input: ConversaoInput, agora: Date): Array<{ pares: Par[]; abre: number; fecha: number; fimDasHoras: number; invertido: boolean }> {
  const grupos: Array<{ pares: Par[]; abre: number; fecha: number; fimDasHoras: number; invertido: boolean }> = [];
  const ehDaConta = (tz: string) => mesmoFuso(tz, input.fusoLista, agora);
  let piso = 0;
  const montar = (fora: Hora[], rFora: Rotulo, dentro: Hora[], rDentro: Rotulo, abre: number, fecha: number) => {
    // quem é a conta: o lado com o fuso dela. O outro é o do lead (sem rótulo também: "às 2 (3 PM ET)").
    const contaDentro = rDentro?.tipo === "fuso" && ehDaConta(rDentro.tz) && !(rFora?.tipo === "fuso" && ehDaConta(rFora.tz));
    const contaFora = rFora?.tipo === "fuso" && ehDaConta(rFora.tz) && rDentro !== null && !(rDentro.tipo === "fuso" && ehDaConta(rDentro.tz));
    if (!contaDentro && !contaFora) return;
    const rLead = contaDentro ? rFora : rDentro;
    if (rLead?.tipo === "outro") return;
    // "quinta às 5 (17h ET)": sem rótulo e com a mesma hora, é a mesma leitura duas vezes.
    if (!rLead && dentro.every((d, i) => d.min === fora[i].min && d.leituras.some((h) => fora[i].leituras.includes(h)))) return;
    const fusoDaConta = ((contaDentro ? rDentro : rFora) as { tz: string }).tz;
    const fusoDoLead = rLead?.tipo === "fuso" ? rLead.tz : input.fusoLead ?? null;
    const pares = dentro.map((d, i) => ({
      lead: contaDentro ? fora[i] : d,
      conta: contaDentro ? d : fora[i],
      fusoDoLead,
      fusoDaConta,
    }));
    grupos.push({ pares, abre, fecha, fimDasHoras: fora[fora.length - 1].fim, invertido: !contaDentro });
  };
  for (const m of b.matchAll(/\(([^()]{2,90})\)/g)) {
    const abre = m.index!;
    const fecha = abre + m[0].length;
    const dentro = horasEm(b, abre + 1, fecha - 1);
    const ini = Math.max(piso, inicioDaFrase(b, abre));
    if (dentro.length === 0) continue;
    piso = fecha;
    const fora = horasEm(b, ini, abre).slice(-dentro.length);
    if (fora.length !== dentro.length) continue;
    // "às 11 AM (horário do Texas, seria 12 PM ET)": o rótulo da hora de fora pode vir no parêntese.
    const noParentese = rotulo(b.slice(abre + 1, dentro[0].inicio));
    montar(fora, rotulo(b.slice(fora[fora.length - 1].fim, abre)) ?? noParentese, dentro, rotulo(b.slice(dentro[0].inicio, fecha - 1)) ?? noParentese, abre, fecha);
  }
  // "8pm ET = 5pm no seu horário", "às 8pm ET, que seria 5pm no seu horário"
  for (const m of b.matchAll(/(?:=|,?\s+ou\s+seja,?|,?\s+que\s+(?:é|seria|equivale\s+a)|,?\s+equivale\s+a)\s+/giu)) {
    const depois = horasEm(b, m.index! + m[0].length, Math.min(b.length, m.index! + m[0].length + 20))[0];
    if (!depois || depois.inicio !== m.index! + m[0].length) continue;
    const ini = inicioDaFrase(b, m.index!);
    const fora = horasEm(b, ini, m.index!).slice(-1);
    if (fora.length === 0 || b.slice(ini, m.index!).lastIndexOf("(") > fora[0].inicio - ini) continue;
    const resto = /^[^.!?\n(]{0,40}/.exec(b.slice(depois.fim))![0];
    const fim = depois.fim + (RE_SEU_HORARIO.exec(resto)?.[0] ? RE_SEU_HORARIO.exec(resto)!.index + RE_SEU_HORARIO.exec(resto)![0].length : 0);
    montar(fora, rotulo(b.slice(fora[0].fim, m.index!)), [depois], rotulo(resto), m.index!, fim);
  }
  return grupos;
}

function conferirBolha(b: string, input: ConversaoInput, agora: Date): { texto: string; correcoes: string[]; conferidos: number } {
  const correcoes: string[] = [];
  const trocas: Troca[] = [];
  let conferidos = 0;
  const dias = lerDias(b);
  const idx = input.slotsIso ? indexarSlots(input.slotsIso, input.fusoLista) : null;
  const chaves = idx ? [...idx.keys()] : [];
  const existe = (hm: Hm, fuso: string, datas: string[] | null): boolean => {
    const naLista = desloca(hm, diferencaMinutos(fuso, input.fusoLista, agora));
    const fim = `${String(naLista.h).padStart(2, "0")}:${String(naLista.min).padStart(2, "0")}`;
    return chaves.some((k) => k.endsWith(` ${fim}`) && (!datas || datas.some((d) => k.startsWith(d))));
  };
  const diaDe = (pos: number) => [...dias].reverse().find((d) => d.fim <= pos) ?? null;

  const emPar = new Set<number>();
  for (const g of lerPares(b, input, agora)) {
    for (const p of g.pares) emPar.add(p.lead.inicio).add(p.conta.inicio);
    conferidos += g.pares.length;
    if (g.pares.some((p) => p.fusoDoLead === null)) {
      // Fuso do lead desconhecido: a conta não tem como ser conferida. Fica só a hora da conta.
      const nome = nomeDoFuso(g.pares[0].fusoDaConta);
      if (g.invertido) {
        trocas.push({ ini: b.slice(0, g.abre).trimEnd().length, fim: g.fecha, novo: "" });
      } else {
        for (const p of g.pares) {
          // sem AM/PM a hora de reunião é a da tarde
          const hm = { h: p.conta.leituras[p.conta.leituras.length - 1], min: p.conta.min };
          trocas.push({ ini: p.lead.inicio, fim: p.lead.fim, novo: noEstiloDe(p.lead.texto, hm) });
        }
        trocas.push({ ini: g.fimDasHoras, fim: g.fecha, novo: `, ${nome}` });
      }
      correcoes.push(`"${b.slice(g.pares[0].lead.inicio, g.fecha)}" sem o fuso do lead: ficou só o ${nome}`);
      continue;
    }
    for (const p of g.pares) {
      const datas = datasPossiveis(diaDe(Math.max(p.lead.inicio, p.conta.inicio)), agora, input.fusoLista);
      // A diferença é a do dia da reunião (o horário de verão muda no meio do mês).
      const quando = datas ? new Date(`${datas[0]}T17:00:00Z`) : agora;
      const dif = diferencaMinutos(p.fusoDaConta, p.fusoDoLead!, quando);
      const bate = p.conta.leituras.some((h) => {
        const e = desloca({ h, min: p.conta.min }, dif);
        return p.lead.leituras.includes(e.h) && p.lead.min === e.min;
      });
      if (bate) continue;
      const contaHm = p.conta.leituras.map((h) => ({ h, min: p.conta.min }));
      const contaReal = contaHm.find((hm) => existe(hm, p.fusoDaConta, datas));
      const pelaDoLead = p.lead.leituras.map((h) => desloca({ h, min: p.lead.min }, -dif)).find((hm) => existe(hm, p.fusoDaConta, datas));
      if (!contaReal && pelaDoLead) {
        const novo = noEstiloDe(p.conta.texto, pelaDoLead);
        trocas.push({ ini: p.conta.inicio, fim: p.conta.fim, novo });
        correcoes.push(`"${p.lead.texto}" no horário do lead é "${novo}", não "${p.conta.texto}"`);
      } else {
        const novo = noEstiloDe(p.lead.texto, desloca(contaReal ?? contaHm[contaHm.length - 1], dif));
        trocas.push({ ini: p.lead.inicio, fim: p.lead.fim, novo });
        correcoes.push(`"${p.conta.texto}" é "${novo}" no horário do lead, não "${p.lead.texto}"`);
      }
    }
  }

  // "às 2 da tarde no seu horário" solto, sem saber o fuso dele: a lista só tem a hora da conta.
  if (!input.fusoLead) {
    for (const h of horasEm(b, 0, b.length)) {
      if (emPar.has(h.inicio)) continue;
      const r = /^\s*,?\s*(?:no\s+)?seu\s+(?:hor[áa]rio|fuso)(?![\p{L}])(?!\s+de\s+\p{Ll})/iu.exec(b.slice(h.fim));
      if (!r || detectarFusoNoTexto(b.slice(h.fim, h.fim + r[0].length + 25))) continue;
      const datas = datasPossiveis(diaDe(h.inicio), agora, input.fusoLista);
      if (!h.leituras.some((x) => existe({ h: x, min: h.min }, input.fusoLista, datas))) continue;
      conferidos++;
      trocas.push({ ini: h.fim, fim: h.fim + r[0].length, novo: `, ${nomeDoFuso(input.fusoLista)}` });
      correcoes.push(`"${h.texto}${r[0]}" sem o fuso do lead: ficou o ${nomeDoFuso(input.fusoLista)}`);
    }
  }

  // "ao meio-dia" vira "às 11 da manhã"
  for (const t of trocas) {
    const ao = /(?<![\p{L}])ao\s+$/iu.exec(b.slice(0, t.ini));
    if (ao && /^\d/.test(t.novo)) {
      t.ini -= ao[0].length;
      t.novo = `às ${t.novo}`;
    }
  }
  let texto = b;
  for (const t of trocas.sort((x, y) => y.ini - x.ini)) texto = texto.slice(0, t.ini) + t.novo + texto.slice(t.fim);
  return { texto, correcoes, conferidos };
}

/** Confere e corrige as conversões de fuso afirmadas nas bolhas. */
export function conferirConversaoDeFuso(bolhas: readonly string[], input: ConversaoInput): ConversaoResult {
  const agora = input.agora ?? new Date();
  const correcoes: string[] = [];
  let conferidos = 0;
  const messages = bolhas.map((b) => {
    const r = conferirBolha(b, input, agora);
    correcoes.push(...r.correcoes);
    conferidos += r.conferidos;
    return r.texto;
  });
  return { messages, correcoes, conferidos };
}
