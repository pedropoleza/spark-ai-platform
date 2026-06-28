/**
 * Link de reunião (Zoom) por calendário, pra agentes lead-facing.
 *
 * Caso Marina (Pedro 2026-06-28): os appointments de recrutamento nasciam SEM
 * link — o action-executor mandava `meetingLocationType:"phone"` fixo e nunca
 * preenchia `address`. A automação de confirmação do GHL (que entrega o link pro
 * lead) ficava sem nada pra referenciar. Aqui mapeamos calendarId → link fixo do
 * encontro recorrente; o action-executor injeta `address` + `overrideLocationConfig`
 * SÓ quando o calendário tem link configurado (senão mantém o comportamento atual,
 * sem afetar outros agentes).
 *
 * Encontros da Marina = grupo recorrente seg/ter/qui 8PM ET, link único e fixo.
 * Não há interpolação em runtime — é literal, hardcoded de propósito (o link é
 * estável e o LLM nunca o vê: vai direto pro campo do appointment).
 */
const MEETING_LINKS: Record<string, string> = {
  // Marina Couto — calendário do encontro de recrutamento (location A62s5EQj1hldOuvBEowv)
  Jc2L0wqA6A2Q9AaPuyxk:
    "https://us02web.zoom.us/j/88260482475?pwd=9SRGjNR8jvet9vxzxr6e6ErYbytYRM.1",
};

export type MeetingLocation = {
  meetingLocationType: "custom";
  address: string;
  overrideLocationConfig: true;
};

/**
 * Resolve o local da reunião pro `book_appointment`/`reschedule_appointment`.
 * Retorna null quando o calendário não tem link configurado — nesse caso o caller
 * mantém o default histórico (`meetingLocationType:"phone"`), sem mudar nada pros
 * demais agentes.
 */
export function resolveMeetingLocation(calendarId: string | undefined): MeetingLocation | null {
  if (!calendarId) return null;
  const link = MEETING_LINKS[calendarId];
  if (!link) return null;
  // overrideLocationConfig=true é OBRIGATÓRIO: sem ele o GHL ignora silenciosamente
  // o address/type e usa o default do calendar (mesmo gotcha do tool do SparkBot,
  // calendar.ts H26). 'custom' = URL literal (não usa a integração nativa de Zoom).
  return { meetingLocationType: "custom", address: link, overrideLocationConfig: true };
}

/** Só o link cru, pra scripts de backfill. */
export function meetingLinkForCalendar(calendarId: string): string | null {
  return MEETING_LINKS[calendarId] ?? null;
}
