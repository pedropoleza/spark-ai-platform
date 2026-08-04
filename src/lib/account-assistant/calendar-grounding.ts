/**
 * Tabela de calendário REAL pro runtime context (H67, caso Milton 2026-08-04).
 *
 * O BUG: o LLM mapeia dia-da-semana ↔ data usando o calendário de **2025**, não
 * o de 2026. Provado na frota: das 16 combinações (nome do dia + data) que o bot
 * escreveu errado nos 21 dias anteriores, **16 de 16 batiam com o calendário de
 * 2025 e nenhuma com o de 2026** — não é erro de aritmética (que espalharia
 * ±1/±7 aleatoriamente), é o modelo confiando na memória dele em vez do prompt.
 * Como 2025 tem 365 dias, todo dia-da-semana de 2026 fica exatamente +1 — daí o
 * padrão perfeito.
 *
 * Caso real (Milton, Legacy Agency): rep pediu "quinta-feira, dia 6 de agosto".
 * O bot respondeu "quinta 07/08" (07/08/2026 é SEXTA; em 2025 era quinta).
 * O rep corrigiu DUAS vezes e o bot insistiu, chegando a oferecer um menu com as
 * duas datas erradas ("Quinta-feira = 07/08 / Quarta-feira = 06/08") e a marcar
 * a errada como recomendada. O rep desistiu e refez pelo outro número.
 *
 * POR QUE O PROMPT SOZINHO NÃO RESOLVE: o runtime context já dizia a data certa
 * de hoje COM o dia-da-semana ("[Agora: terça-feira, 4 de agosto de 2026...]").
 * O modelo lia, e mesmo assim derivava os OUTROS dias pela memória. E a guarda
 * H50 (weekday-guard) só age na CHAMADA DE TOOL — não no texto da conversa, nem
 * nos menus do present_options, que é onde o rep vê o erro e perde a confiança.
 *
 * A SOLUÇÃO: parar de pedir cálculo. Este módulo entrega a tabela pronta das
 * próximas 3 semanas (+ a atual), no fuso certo, pra o modelo COPIAR. É a mesma
 * escola do `booked_label` do H50: quando o dado é determinístico, quem produz é
 * o código.
 *
 * Puro e testável (sem I/O). Aritmética de dias em UTC sobre o calendário LOCAL
 * (mesmo padrão do weekday-guard) → imune a DST.
 */

const WD_CURTO_PT = ["dom", "seg", "ter", "qua", "qui", "sex", "sáb"];
const WD_LONGO_PT = [
  "domingo",
  "segunda-feira",
  "terça-feira",
  "quarta-feira",
  "quinta-feira",
  "sexta-feira",
  "sábado",
];

/** {y,m,d} do instante NO fuso dado (calendário local, não UTC). */
function ymdInTz(d: Date, tz: string): { y: number; m: number; day: number } | null {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value;
    const y = parseInt(get("year") || "", 10);
    const m = parseInt(get("month") || "", 10);
    const day = parseInt(get("day") || "", 10);
    if (isNaN(y) || isNaN(m) || isNaN(day)) return null;
    return { y, m, day };
  } catch {
    return null;
  }
}

/** Weekday 0..6 (dom..sáb) do instante no fuso dado. */
function weekdayInTz(d: Date, tz: string): number | null {
  try {
    const wd = new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(d);
    const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return map[wd] ?? null;
  } catch {
    return null;
  }
}

/** "DD/MM" de um timestamp UTC de dia inteiro. */
function ddmm(utcMs: number): string {
  const d = new Date(utcMs);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export interface CalendarGrounding {
  /** Bloco pronto pro runtime context. "" se o fuso for inválido (fail-soft). */
  block: string;
  /** "terça-feira, 04/08/2026" — hoje, no fuso do rep. "" se falhar. */
  hojeLabel: string;
}

/**
 * Monta a tabela de datas reais. 4 linhas cobrem o vocabulário que o rep usa de
 * fato ("essa semana", "semana que vem", "daqui duas semanas") — ~110 tokens na
 * user message (não-cacheada), custo irrelevante perto do prefixo de 40-76K.
 *
 * Semana começa na SEGUNDA (convenção BR).
 */
export function buildCalendarGrounding(
  now: Date,
  tz: string,
  weeksAhead = 2,
): CalendarGrounding {
  const hoje = ymdInTz(now, tz);
  const hojeWd = weekdayInTz(now, tz);
  if (!hoje || hojeWd === null) return { block: "", hojeLabel: "" };

  const hojeUtc = Date.UTC(hoje.y, hoje.m - 1, hoje.day);
  const DIA = 86400000;
  // Segunda-feira da semana ATUAL (domingo conta como fim da semana anterior).
  const desdeSegunda = (hojeWd + 6) % 7;
  const segunda = hojeUtc - desdeSegunda * DIA;

  const rotulos = ["Essa semana", "Semana que vem"];
  for (let i = 2; i <= weeksAhead; i++) rotulos.push(`Daqui ${i} semanas`);

  const linhas: string[] = [];
  for (let w = 0; w <= weeksAhead; w++) {
    const dias: string[] = [];
    for (let i = 0; i < 7; i++) {
      const ts = segunda + (w * 7 + i) * DIA;
      // Segunda(1)..Domingo(0) — a linha começa na segunda.
      const wd = (i + 1) % 7;
      const marca = ts === hojeUtc ? " (HOJE)" : ts === hojeUtc + DIA ? " (amanhã)" : "";
      dias.push(`${WD_CURTO_PT[wd]} ${ddmm(ts)}${marca}`);
    }
    linhas.push(`${rotulos[w]}: ${dias.join(" · ")}`);
  }

  const hojeLabel = `${WD_LONGO_PT[hojeWd]}, ${String(hoje.day).padStart(2, "0")}/${String(hoje.m).padStart(2, "0")}/${hoje.y}`;

  return {
    hojeLabel,
    block: [
      "[CALENDÁRIO REAL — COPIE daqui. NUNCA calcule nem lembre de cabeça qual dia da semana cai numa data:]",
      `Hoje é ${hojeLabel}.`,
      ...linhas,
      "REGRA: todo dia-da-semana que você escrever (conversa, pergunta de confirmação, menu de opções, ISO de agendamento) TEM que sair desta tabela. Se a data pedida não está aqui, peça a data exata ao rep em vez de calcular.",
    ].join("\n"),
  };
}
