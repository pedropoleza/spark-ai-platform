/**
 * Local da reunião a partir da configuração do calendário (H65, caso Liberty
 * Financial 2026-08-04).
 *
 * CONTEXTO — o bug: reunião criada pelo agente lead-facing nascia com
 * `address: ""`. A automação de confirmação do Spark Leads manda "Local do
 * nosso encontro: {{appointment.address}}" e o lead recebia em branco, sem o
 * Google Meet/Zoom. Causa: o executor mandava `meetingLocationType:"phone"`
 * fixo quando o calendário não tinha link hardcoded — isso SOBRESCREVE o
 * default do calendário e apaga o link.
 *
 * PROVA (scripts/probe-meeting-location-default.ts, rodado em prod 04/08):
 *   POST sem NENHUM campo de local        → address = "https://meet.google.com/…" ✅
 *   POST com meetingLocationId:"default"  → address = ""                          ❌
 *   POST com meetingLocationType:"phone"  → address = ""                          ❌ (o bug)
 *   PUT  sem campo de local               → NÃO regenera (segue vazio)            ❌
 *   PUT  com type+id+override             → address = "https://meet.google.com/…" ✅
 *
 * Ou seja: no CREATE a regra é **não mandar nada** (o Spark Leads resolve pelo
 * `locationConfigurations` do membro do time). Já no UPDATE ele nunca
 * regenera sozinho — pra curar uma reunião que nasceu vazia é preciso mandar
 * o local EXPLÍCITO. Este módulo monta esse payload explícito a partir da
 * config real do calendário (nada hardcoded).
 */
import type { GHLClient } from "@/lib/ghl/client";

/** Uma entrada de `teamMembers[].locationConfigurations` do Spark Leads. */
export type LocationConfiguration = {
  kind?: string;
  meetingId?: string;
  location?: string;
  position?: number;
};

export type CalendarTeamMember = {
  userId?: string;
  isPrimary?: boolean;
  locationConfigurations?: LocationConfiguration[];
};

export type CalendarWithLocation = {
  teamMembers?: CalendarTeamMember[];
  locationConfigurations?: LocationConfiguration[];
};

/** Payload explícito de local pro PUT (o CREATE não manda nada). */
export type ExplicitMeetingLocation = {
  meetingLocationType: string;
  meetingLocationId: string;
  overrideLocationConfig: true;
  address?: string;
};

/**
 * `kind` do calendário → `meetingLocationType` da API.
 * Kinds vistos em prod: google_conference, zoom_conference, custom.
 * Desconhecido devolve null de propósito — melhor não mexer no local do que
 * chutar um tipo errado e apagar o que estava lá.
 */
export function meetingLocationTypeFromKind(kind: string | undefined): string | null {
  switch ((kind || "").toLowerCase()) {
    case "google_conference":
      return "gmeet";
    case "zoom_conference":
      return "zoom";
    case "ms_teams_conference":
    case "teams_conference":
      return "ms_teams";
    case "custom":
      return "custom";
    case "physical":
    case "address":
      return "address";
    case "phone":
      return "phone";
    default:
      return null;
  }
}

/**
 * Escolhe a config de local que o Spark Leads usaria: a do membro DONO da
 * reunião; sem dono conhecido, a do membro primário; por último, a do
 * calendário (calendários pessoais às vezes guardam no nível de cima).
 */
export function pickLocationConfig(
  calendar: CalendarWithLocation | undefined,
  assignedUserId?: string,
): LocationConfiguration | null {
  if (!calendar) return null;
  const members = calendar.teamMembers || [];
  const byUser = assignedUserId ? members.find((m) => m.userId === assignedUserId) : undefined;
  const primary = members.find((m) => m.isPrimary);
  const candidates = [byUser, primary, members[0]].filter(Boolean) as CalendarTeamMember[];
  for (const m of candidates) {
    const cfg = (m.locationConfigurations || [])[0];
    if (cfg?.kind) return cfg;
  }
  const calLevel = (calendar.locationConfigurations || [])[0];
  return calLevel?.kind ? calLevel : null;
}

/** Monta o payload explícito de local a partir de uma config do calendário. */
export function explicitLocationFromConfig(
  cfg: LocationConfiguration | null,
): ExplicitMeetingLocation | null {
  if (!cfg) return null;
  const type = meetingLocationTypeFromKind(cfg.kind);
  if (!type || !cfg.meetingId) return null;
  // 'custom'/'address' guardam o valor literal (link fixo do Zoom, endereço
  // físico) no próprio config. Sem valor salvo não há NADA pra herdar — mandar
  // o tipo sozinho só faz um update que não muda nada (visto em prod 04/08 no
  // "4.5 - REUNIÃO: PESSOAL": custom com location vazio).
  if (type === "custom" || type === "address") {
    if (!cfg.location) return null;
    return {
      meetingLocationType: type,
      meetingLocationId: cfg.meetingId,
      overrideLocationConfig: true,
      address: cfg.location,
    };
  }
  return {
    meetingLocationType: type,
    meetingLocationId: cfg.meetingId,
    overrideLocationConfig: true,
  };
}

// Cache do detalhe do calendário: a cura roda dentro do turno (budget 45s) e
// o mesmo calendário se repete muito. TTL curto — config muda raramente.
const CAL_TTL_MS = 5 * 60_000;
const calCache = new Map<string, { at: number; cal: CalendarWithLocation | null }>();

async function getCalendarCached(
  client: GHLClient,
  calendarId: string,
): Promise<CalendarWithLocation | null> {
  const hit = calCache.get(calendarId);
  if (hit && Date.now() - hit.at < CAL_TTL_MS) return hit.cal;
  let cal: CalendarWithLocation | null = null;
  try {
    const res = await client.get<{ calendar?: CalendarWithLocation }>(
      `/calendars/${encodeURIComponent(calendarId)}`,
    );
    cal = res.calendar || null;
  } catch {
    cal = null; // fail-soft: sem config, não mexe no local
  }
  calCache.set(calendarId, { at: Date.now(), cal });
  return cal;
}

/**
 * Resolve o local default do calendário (do dono da reunião) como payload
 * explícito. Devolve null quando não dá pra ter certeza — o caller então
 * NÃO mexe no local.
 */
export async function resolveCalendarDefaultLocation(
  client: GHLClient,
  calendarId: string | undefined,
  assignedUserId?: string,
): Promise<ExplicitMeetingLocation | null> {
  if (!calendarId) return null;
  const cal = await getCalendarCached(client, calendarId);
  return explicitLocationFromConfig(pickLocationConfig(cal ?? undefined, assignedUserId));
}

/**
 * Cura uma reunião que ficou SEM local (nasceu antes do H65, ou veio de um
 * update que não regenera). Best-effort e silenciosa: só age quando o
 * `address` está vazio, e nunca sobrescreve um local já preenchido (o rep
 * pode ter editado à mão). `toNotify:false` segura as automações NO UPDATE
 * (validado em prod 04/08: as reuniões curadas não geraram mensagem) — o lead
 * não recebe uma segunda confirmação por causa da cura.
 */
export async function healMissingMeetingLocation(
  client: GHLClient,
  appointmentId: string,
  calendarId: string | undefined,
): Promise<{
  status: "filled" | "already_had" | "unknown_config" | "no_effect" | "error";
  address?: string;
}> {
  const ler = async () => {
    const res = await client.get<{
      appointment?: { address?: string; assignedUserId?: string; calendarId?: string };
    }>(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`);
    return res.appointment;
  };
  try {
    const appt = await ler();
    if (!appt) return { status: "error" };
    if (appt.address) return { status: "already_had", address: appt.address };
    const calId = calendarId || appt.calendarId;
    const loc = await resolveCalendarDefaultLocation(client, calId, appt.assignedUserId);
    if (!loc) return { status: "unknown_config" };
    await client.put(`/calendars/events/appointments/${encodeURIComponent(appointmentId)}`, {
      calendarId: calId,
      toNotify: false,
      ignoreFreeSlotValidation: true,
      ignoreDateRange: true,
      ...loc,
    });
    // Confere o RESULTADO em vez de confiar no 200 do update (mesmo princípio
    // do H50/H41: só afirmar o que aconteceu de fato). Em prod 04/08 o update
    // de `zoom_conference` foi aceito e mesmo assim o local seguiu vazio — o
    // Spark Leads só gera a sala do Zoom na CRIAÇÃO.
    const depois = await ler();
    return depois?.address
      ? { status: "filled", address: depois.address }
      : { status: "no_effect" };
  } catch {
    return { status: "error" };
  }
}
