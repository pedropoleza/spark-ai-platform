/**
 * Resumo matinal dos agendamentos do dia da Marina Couto (encontro em grupo, quase
 * tudo 8PM ET) — enviado por WhatsApp toda manhã (cron) + rodável na mão.
 * Pedido do Pedro 2026-07-01: "lista de pessoas dos agendamentos do dia, condensada
 * porque a maioria é 8PM". A Marina NÃO é rep do SparkBot → entrega via Stevo direto
 * (instância do hub) pro número em `MARINA_DAILY_PHONE`. Sem o env = no-op seguro.
 */
import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { listCalendarEvents } from "@/lib/ghl/operations";
import { resolvePrimaryHub, getEnvHubLocationId } from "@/lib/account-assistant/hub-resolver";
import { getStevoInstance } from "@/lib/repositories/stevo-instances.repo";
import { sendStevoText } from "@/lib/account-assistant/webhook/stevo-send";

export const MARINA_DAILY = {
  location: "A62s5EQj1hldOuvBEowv",
  calendar: "Jc2L0wqA6A2Q9AaPuyxk",
  tz: "America/New_York",
};

function tzDay(d: Date) {
  return d.toLocaleDateString("pt-BR", { weekday: "short", day: "2-digit", month: "2-digit", timeZone: MARINA_DAILY.tz });
}
function tzTime(d: Date) {
  return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: MARINA_DAILY.tz });
}

/** Monta a mensagem CONDENSADA (agrupa por horário — quase tudo 8PM). */
export async function buildMarinaDailyList(client: GHLClient, forDate: Date): Promise<{ text: string; count: number }> {
  // janela do DIA no fuso de NY → epoch millis (offset -04:00 EDT / -05:00 EST)
  const ymd = forDate.toLocaleDateString("en-CA", { timeZone: MARINA_DAILY.tz }); // YYYY-MM-DD em ET
  const offMin = tzOffsetMinutes(forDate);
  const off = `${offMin <= 0 ? "-" : "+"}${String(Math.floor(Math.abs(offMin) / 60)).padStart(2, "0")}:${String(Math.abs(offMin) % 60).padStart(2, "0")}`;
  const startMs = new Date(`${ymd}T00:00:00${off}`).getTime();
  const endMs = startMs + 24 * 60 * 60 * 1000;

  const { events } = await listCalendarEvents(client, {
    locationId: MARINA_DAILY.location, calendarId: MARINA_DAILY.calendar,
    startTime: String(startMs), endTime: String(endMs),
  });
  const appts = (events || []).filter((e) => (e.appointmentStatus || "confirmed") !== "cancelled");
  if (!appts.length) return { text: `☀️ Bom dia, Marina! Hoje (${tzDay(forDate)}) não há agendamentos no encontro.`, count: 0 };

  const byTime = new Map<string, string[]>();
  for (const e of appts) {
    const time = tzTime(new Date(e.startTime));
    let name = "";
    const m = (e.title || "").match(/[-—]\s*([^()]+?)(\s*\(|$)/); // "Encontro com a Marina - Nome"
    if (m) name = m[1].trim();
    if (!name && e.contactId) {
      try {
        const c = await client.get<{ contact?: { firstName?: string; name?: string } }>(`/contacts/${e.contactId}`);
        name = c.contact?.firstName || c.contact?.name || "(sem nome)";
      } catch { name = "(sem nome)"; }
    }
    const arr = byTime.get(time) || []; arr.push(name || "(sem nome)"); byTime.set(time, arr);
  }
  const lines = [`☀️ Bom dia, Marina! Agendamentos de hoje (${tzDay(forDate)}) — ${appts.length} no total:`];
  for (const [time, names] of [...byTime.entries()].sort()) {
    lines.push(`\n🕗 ${time} ET (${names.length}): ${names.join(", ")}`);
  }
  return { text: lines.join("\n"), count: appts.length };
}

/** offset (min) do fuso ET pra uma data — trata DST sem hardcode. */
function tzOffsetMinutes(d: Date): number {
  const s = d.toLocaleString("en-US", { timeZone: MARINA_DAILY.tz });
  const local = new Date(s);
  const utc = new Date(d.toLocaleString("en-US", { timeZone: "UTC" }));
  return Math.round((local.getTime() - utc.getTime()) / 60000);
}

export interface DigestResult {
  ok: boolean;
  skipped?: string;
  via?: string;
  count?: number;
  text?: string;
  error?: string;
}

/** Fluxo completo: monta + entrega via Stevo. Gate: MARINA_DAILY_PHONE + STEVO_SEND_ENABLED. */
export async function runMarinaDailyDigest(opts?: { forDate?: Date; dryRun?: boolean }): Promise<DigestResult> {
  const phone = process.env.MARINA_DAILY_PHONE?.trim();
  if (!phone && !opts?.dryRun) return { ok: false, skipped: "no_phone_configured" };

  const sb = createAdminClient();
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", MARINA_DAILY.location).maybeSingle();
  if (!loc) return { ok: false, error: "location_not_found" };
  const client = new GHLClient(loc.company_id, MARINA_DAILY.location);

  const { text, count } = await buildMarinaDailyList(client, opts?.forDate || new Date());
  if (count === 0) return { ok: true, skipped: "no_appointments", count: 0, text };
  if (opts?.dryRun) return { ok: true, skipped: "dry_run", count, text };

  const stevoEnabled = /^(1|true|yes)$/i.test(process.env.STEVO_SEND_ENABLED?.trim() || "");
  if (!stevoEnabled) return { ok: false, skipped: "stevo_disabled", count, text };

  const hub = await resolvePrimaryHub();
  const hubLoc = hub?.locationId || getEnvHubLocationId();
  const inst = hubLoc ? await getStevoInstance(hubLoc) : null;
  if (!inst) return { ok: false, error: "no_stevo_instance", count, text };

  const r = await sendStevoText({ serverUrl: inst.serverUrl, apiKey: inst.instanceToken, number: phone!, text });
  return { ok: r.ok, via: "stevo", count, error: r.error, text };
}
