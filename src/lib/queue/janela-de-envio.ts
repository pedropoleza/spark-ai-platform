/**
 * Janela de envio dos follow-ups lead-facing.
 *
 * Fix bug observado em prod 2026-08-06 (caso Márcia/Five Star, número
 * (862) 371-8457, reportado em 05/08 06:32: "precisava ver sobre o hr do follow
 * up... a mensagem foi MEIA-NOITE"): o `scheduleFollowUps` gravava
 * `scheduled_at = agora + delay` sem checagem NENHUMA de horário. Lead que para
 * de responder às 23h recebe o toque de 1h à meia-noite, no fuso dele.
 *
 * Isso é diferente do `working_hours` do agente: aquele controla se a IA RESPONDE
 * a um inbound (e quando ligado ADIA a resposta, que é o que a gente não quer nas
 * contas de anúncio). Aqui é só o toque PROATIVO, que ninguém pediu e que chega
 * de madrugada — esse sim tem que esperar o dia amanhecer.
 *
 * Puro e testável: nada de rede, nada de banco.
 */

/** Janela padrão: 08:00 às 21:00 no fuso da conta. */
export const JANELA_PADRAO = { inicioHora: 8, fimHora: 21 } as const;

export interface JanelaDeEnvio {
  inicioHora: number; // primeira hora permitida (inclusive)
  fimHora: number; // última hora permitida (exclusive)
}

/** Hora local (0-23) de um instante num fuso, DST-correto. */
export function horaLocal(instante: Date, tz: string): number {
  const h = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour: "2-digit",
    hour12: false,
  }).format(instante);
  // "24" aparece em algumas implementações pra meia-noite
  return Number(h) % 24;
}

/**
 * Empurra `quando` pra dentro da janela de envio no fuso da conta.
 *
 * - Dentro da janela → devolve o próprio instante (nada muda).
 * - Antes da abertura (madrugada) → mesma manhã, na hora de abertura.
 * - Depois do fechamento (noite) → manhã seguinte, na hora de abertura.
 *
 * Avança em passos de 1h em vez de calcular a data local na mão: é imune a DST,
 * a fusos com offset quebrado (:30/:45) e à virada de dia/mês/ano.
 */
export function ajustarParaJanela(
  quando: Date,
  tz: string,
  janela: JanelaDeEnvio = JANELA_PADRAO,
): Date {
  const dentro = (d: Date) => {
    const h = horaLocal(d, tz);
    return h >= janela.inicioHora && h < janela.fimHora;
  };

  if (dentro(quando)) return quando;

  // No máximo 48 passos de 1h cobrem qualquer buraco de janela + DST.
  const passo = new Date(quando.getTime());
  for (let i = 0; i < 48; i++) {
    passo.setTime(passo.getTime() + 60 * 60 * 1000);
    if (dentro(passo)) {
      // Zera minutos/segundos pra cair cravado na hora cheia — evita "08:37"
      // só porque o lead sumiu 08:37 da noite anterior.
      const zerado = new Date(passo.getTime());
      zerado.setUTCMinutes(0, 0, 0);
      // Zerar pode ter jogado pra fora da janela (borda da abertura); se jogou,
      // fica com o instante não-zerado, que já está dentro.
      return dentro(zerado) && zerado.getTime() >= quando.getTime() ? zerado : passo;
    }
  }
  return quando; // fuso inválido/janela impossível: não trava o agendamento
}
