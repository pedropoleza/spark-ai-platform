/**
 * Guarda determinística do AGENDAMENTO lead-facing (H58, caso Jussara 2026-07-26).
 *
 * ── O que aconteceu em prod ──────────────────────────────────────────────────
 * Lead Marilia, 26/07, 8 minutos de conversa:
 *   14:01:53  book_appointment segunda 16:00 → FALHOU ("horario indisponivel")
 *   14:01:54  "Ótimo, segunda às 4 PM ET tá marcado 🎉"   ← 1 segundo depois
 * A reunião nunca existiu. A lead sumiu. Mesma família: a Lena foi agendada
 * 28/07 às 08:00 — FORA do expediente (9h-21h ET) — e também sumiu.
 *
 * ── Por que os guardas existentes não pegaram ────────────────────────────────
 * Existia tratamento: `isBookingConflictError` → troca a confirmação do LLM por
 * "não consegui agendar, posso sugerir outro?". Mas o `catch` do book_appointment
 * re-classificava o erro de slot com a frase **"Calendario nao configurado ou
 * horario indisponivel"** — que contém AS DUAS causas. O classificador testa
 * "config" primeiro e devolve `false` pra não oferecer outro horário num erro de
 * configuração. Ou seja: a mensagem escrita pra deixar o erro "mais acionável"
 * foi exatamente o que desarmou o guarda. Ambiguidade na string de erro derrotou
 * o próprio classificador.
 *
 * ── O princípio ─────────────────────────────────────────────────────────────
 * Mesmo do H41 ("só afirmar o count REAL inserido") e do H50 (`booked_label`):
 * **o texto não decide o que é verdade — o resultado da operação decide.**
 * O LLM escreve a mensagem ANTES de saber se a ação deu certo; então quem
 * afirma "tá marcado" tem que ser o servidor, não o modelo.
 *
 * ESCOPO: a validação "esse horário existe na agenda?" mora em `slot-guard.ts`
 * (feito em paralelo pelo caso Alves Cury). Os dois se completam e são precisos
 * juntos: o slot-guard IMPEDE o booking errado; este aqui garante que, quando um
 * booking falha por QUALQUER motivo — inclusive um que nenhuma lista de
 * palavras-chave preveja — a lead não receba "tá marcado" mesmo assim.
 *
 * Este módulo é puro e testável: sem I/O, sem LLM.
 */

// ---------------------------------------------------------------------------
// 1. A mensagem AFIRMA que agendou?
// ---------------------------------------------------------------------------

/**
 * Frases com que o agente afirma um agendamento concluído. Deliberadamente
 * ESPECÍFICO: pegar "vamos marcar?" (proposta) como afirmação bloquearia a
 * conversa normal. Só casa o que soa a fato consumado.
 */
const AFIRMACOES_DE_AGENDAMENTO: RegExp[] = [
  /\b(t[áa]|est[áa])\s+(marcad[oa]|agendad[oa]|confirmad[oa]|reservad[oa])\b/i,
  /\b(marquei|agendei|reservei|confirmei)\b/i,
  /\b(ficou|fica)\s+(marcad[oa]|agendad[oa]|confirmad[oa])\b/i,
  /\breuni[ãa]o\s+(foi\s+)?(marcad[oa]|agendad[oa]|confirmad[oa])\b/i,
  /\b(prontinho|pronto|feito|fechado)\b[^.!?]{0,40}\b(marcad[oa]|agendad[oa]|confirmad[oa])\b/i,
  /\bagendamento\s+(confirmad[oa]|feito|realizad[oa])\b/i,
];

/** true quando o texto afirma que a reunião JÁ está marcada. */
export function claimsBooking(texto: string): boolean {
  const t = (texto || "").trim();
  if (!t) return false;
  return AFIRMACOES_DE_AGENDAMENTO.some((re) => re.test(t));
}

// ---------------------------------------------------------------------------
// 2. Expediente
// ---------------------------------------------------------------------------

export interface JanelaExpediente {
  /** Primeira hora ATENDIDA (inclusive). Default 9. */
  inicio: number;
  /** Última hora em que ainda se pode COMEÇAR (inclusive). Default 21. */
  fim: number;
}

export const EXPEDIENTE_PADRAO: JanelaExpediente = { inicio: 9, fim: 21 };

/**
 * Hora local (0-23) de um ISO num fuso, via Intl — correto no DST, ao contrário
 * de aritmética de offset. Devolve `null` se o ISO for inválido.
 */
export function horaLocal(isoOuData: string | Date, timezone: string): number | null {
  const d = typeof isoOuData === "string" ? new Date(isoOuData) : isoOuData;
  if (Number.isNaN(d.getTime())) return null;
  try {
    const s = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      hour12: false,
    }).format(d);
    const h = Number(s);
    // Intl pode devolver "24" pra meia-noite em alguns runtimes.
    return Number.isFinite(h) ? h % 24 : null;
  } catch {
    return null;
  }
}

/**
 * O horário cai dentro do expediente? ISO inválido ou fuso inválido → `true`
 * (fail-open): bloquear agendamento por não conseguir ler a hora seria trocar
 * um defeito por outro pior.
 */
export function dentroDoExpediente(
  startTime: string,
  timezone: string,
  janela: JanelaExpediente = EXPEDIENTE_PADRAO,
): boolean {
  const h = horaLocal(startTime, timezone);
  if (h === null) return true;
  return h >= janela.inicio && h <= janela.fim;
}

// ---------------------------------------------------------------------------
// 3. A decisão
// ---------------------------------------------------------------------------

export type MotivoBloqueio = "booking_falhou" | "sem_booking_no_turno";

export interface DecisaoConfirmacao {
  /** true quando a mensagem pode sair como o modelo escreveu. */
  liberado: boolean;
  motivo?: MotivoBloqueio;
  /** Texto seguro pra substituir a afirmação falsa. */
  substituto?: string;
}

export interface EstadoDoTurno {
  /** O modelo afirmou agendamento em alguma bolha? */
  afirmaAgendamento: boolean;
  /** Houve action de agendamento neste turno? */
  tentouAgendar: boolean;
  /** A action de agendamento voltou com sucesso? */
  agendouComSucesso: boolean;
}

/**
 * Decide se a afirmação de agendamento pode sair.
 *
 * A regra é simples e não negocia: **afirmar "tá marcado" exige booking bem
 * sucedido NESTE turno.** Sem isso, o texto do modelo é trocado por uma
 * mensagem honesta — melhor a lead ouvir "não consegui, escolhe outro" do que
 * aparecer numa reunião que não existe.
 */
export function decidirConfirmacao(estado: EstadoDoTurno): DecisaoConfirmacao {
  if (!estado.afirmaAgendamento) return { liberado: true };
  if (estado.agendouComSucesso) return { liberado: true };

  if (estado.tentouAgendar) {
    return {
      liberado: false,
      motivo: "booking_falhou",
      substituto:
        "Ops, esse horário acabou de ficar indisponível 😔 me fala outro dia e turno que funcionam pra você que eu confirmo na agenda e te retorno.",
    };
  }
  return {
    liberado: false,
    motivo: "sem_booking_no_turno",
    substituto:
      "Deixa eu confirmar esse horário na agenda e já te retorno pra fechar, tá? 🙏",
  };
}

/**
 * Aplica a decisão às bolhas: troca APENAS as que afirmam agendamento e mantém
 * o resto do turno (o agente costuma mandar link/instrução em bolhas separadas
 * — apagar tudo seria pior que o bug).
 */
export function aplicarGuardaDeConfirmacao(
  mensagens: string[],
  estado: EstadoDoTurno,
): { mensagens: string[]; bloqueou: boolean; motivo?: MotivoBloqueio } {
  const decisao = decidirConfirmacao(estado);
  if (decisao.liberado || !decisao.substituto) {
    return { mensagens, bloqueou: false };
  }
  let trocou = false;
  const saida = mensagens.map((m) => {
    if (!claimsBooking(m)) return m;
    trocou = true;
    return decisao.substituto!;
  });
  // Dedup: se duas bolhas afirmavam agendamento, viraram o MESMO texto.
  const final = saida.filter((m, i) => i === 0 || m !== saida[i - 1]);
  return { mensagens: final, bloqueou: trocou, motivo: decisao.motivo };
}
