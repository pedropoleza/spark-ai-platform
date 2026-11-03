/**
 * H112 (Alves Cury, 03/11/2026): agenda travada por etiqueta.
 *
 * Regra do dono da conta: o Bruno (recrutamento) só agenda o Zoom com a Taciana
 * depois que o lead assistiu pelo menos 70% do vídeo da landing. A landing põe a
 * etiqueta ("lp carreira - 70%", ou "lp carreira - video completo" para quem foi
 * até o fim). Medido no laboratório em 03/11: só com o prompt, quando o lead dizia
 * "já assisti o vídeo todo" o modelo acreditava e oferecia horário (3 de 3). Regra
 * dura não pode depender de o modelo obedecer, então a trava é mecânica:
 *
 *  - sem a etiqueta, o processor não entrega os horários ao modelo (sem horário
 *    real na mão ele não tem o que oferecer) e zera a lista de horários do turno,
 *    o que faz o slot-guard do H58 recusar qualquer book_appointment;
 *  - etiqueta de exceção (ex.: "interesse-seguro", a virada para cliente, que não
 *    tem nada a ver com o vídeo de carreira) libera a agenda sem o requisito;
 *  - sem config (`agent_configs.booking_tag_gate` nulo ou sem requires_any): nada
 *    muda, a frota segue igual;
 *  - não deu para ler as etiquetas: libera (fail-open, como o resto do processor;
 *    a regra continua no prompt).
 *
 * Comparação sem caixa e sem espaço nas pontas, como o H111.
 */
export interface BookingTagGate {
  /** Qualquer uma destas libera a agenda. */
  requires_any?: string[] | null;
  /** Qualquer uma destas libera a agenda mesmo sem o requisito. */
  except_any?: string[] | null;
}

export interface VereditoAgenda {
  liberada: boolean;
  motivo: "sem_trava" | "tem_requisito" | "tem_excecao" | "etiquetas_ilegiveis" | "falta_requisito";
}

const norm = (t: unknown): string => (typeof t === "string" ? t : "").trim().toLowerCase();

export function lerTravaDeAgenda(raw: unknown): BookingTagGate | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const g = raw as BookingTagGate;
  const req = (Array.isArray(g.requires_any) ? g.requires_any : []).map(norm).filter(Boolean);
  if (req.length === 0) return null;
  const exc = (Array.isArray(g.except_any) ? g.except_any : []).map(norm).filter(Boolean);
  return { requires_any: req, except_any: exc };
}

export function agendaLiberadaPorEtiqueta(
  rawGate: unknown,
  etiquetasDoContato: readonly string[] | null | undefined,
): VereditoAgenda {
  const gate = lerTravaDeAgenda(rawGate);
  if (!gate) return { liberada: true, motivo: "sem_trava" };
  if (!etiquetasDoContato) return { liberada: true, motivo: "etiquetas_ilegiveis" };
  const tem = new Set(etiquetasDoContato.map(norm));
  if ((gate.requires_any || []).some((t) => tem.has(t))) return { liberada: true, motivo: "tem_requisito" };
  if ((gate.except_any || []).some((t) => tem.has(t))) return { liberada: true, motivo: "tem_excecao" };
  return { liberada: false, motivo: "falta_requisito" };
}

/** Etiquetas do contato no formato que o GET /contacts devolve (string ou {name}). */
export function etiquetasDoContato(contato: { tags?: Array<string | { name?: string }> } | null | undefined): string[] | null {
  if (!contato) return null;
  if (!Array.isArray(contato.tags)) return [];
  return contato.tags.map((t) => (typeof t === "string" ? t : t?.name || "")).filter(Boolean);
}
