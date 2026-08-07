/**
 * H73 — reuniões da conta da Márcia que nasceram 1h fora do combinado.
 *
 * Enquanto `locations.timezone` esteve como America/Sao_Paulo (bug H72), a
 * coerção de offset reescrevia o ISO que o modelo emitiu certo (-04:00) pra
 * -03:00 — a reunião caía 1 hora ANTES do horário que a IA falou pro lead.
 * O `execution_log` guarda o horário original em `action_payload.
 * offset_coerced_from`, então dá pra saber exatamente o que foi prometido.
 *
 * Rodar: npx tsx scripts/fix-marcia-reunioes-deslocadas.ts [--apply]
 */
import { createClient } from "@supabase/supabase-js";
import * as dotenv from "dotenv"; dotenv.config({ path: ".env.local" });
import { GHLClient } from "@/lib/ghl/client";

const APPLY = process.argv.includes("--apply");
const LOC = "jA6uzx6tONyTeocxw4Cj";
const COMPANY = "TdmQMjj86Y3LgppiB96K";
const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

async function main() {
  const { data } = await sb.from("execution_log")
    .select("created_at,contact_id,action_type,action_payload")
    .eq("location_id", LOC).eq("success", true)
    .in("action_type", ["book_appointment", "reschedule_appointment"])
    .gte("created_at", "2026-08-01T00:00:00Z").order("created_at");

  const afetados = new Map<string, { prometido: string; gravado: string; quando: string }>();
  for (const r of (data ?? []) as Array<Record<string, unknown>>) {
    const p = (r.action_payload ?? {}) as Record<string, string>;
    if (!p.offset_coerced_from || !p.start_time) continue;
    // último booking vence (reagendamentos posteriores sobrescrevem)
    afetados.set(String(r.contact_id), {
      prometido: p.offset_coerced_from, gravado: p.start_time, quando: String(r.created_at),
    });
  }
  console.log(`bookings com offset reescrito: ${afetados.size} contatos\n`);

  const client = new GHLClient(COMPANY, LOC);
  const agora = Date.now();
  let futuras = 0, corrigidas = 0;

  for (const [contactId, info] of afetados) {
    const deslocamentoMin = (Date.parse(info.gravado) - Date.parse(info.prometido)) / 60000;
    let appts: Array<Record<string, string>> = [];
    try {
      const resp = await client.get<Record<string, unknown>>(`/contacts/${contactId}/appointments`, { locationId: LOC });
      appts = ((resp.events ?? resp.appointments ?? []) as Array<Record<string, string>>) ?? [];
    } catch (e) { console.log(`  ${contactId}: erro ao ler agenda (${(e as Error).message.slice(0, 60)})`); continue; }

    const alvo = appts.find((a) => Math.abs(Date.parse(a.startTime) - Date.parse(info.gravado)) < 60000
      && !["cancelled", "deleted"].includes(String(a.appointmentStatus ?? a.status ?? "").toLowerCase()));
    if (!alvo) { console.log(`  ${contactId}: nenhuma reunião no horário deslocado (já remarcada/cancelada) — pular`); continue; }
    if (Date.parse(alvo.startTime) < agora) { console.log(`  ${contactId}: já passou (${alvo.startTime}) — pular`); continue; }

    futuras++;
    console.log(`  ${contactId}: agenda diz ${alvo.startTime}, a IA prometeu ${info.prometido} (${deslocamentoMin > 0 ? "+" : ""}${deslocamentoMin}min)`);
    if (!APPLY) continue;
    try {
      await client.put(`/calendars/events/appointments/${alvo.id}`, {
        calendarId: alvo.calendarId, startTime: info.prometido, toNotify: false,
      });
      corrigidas++; console.log(`     ✅ movida pra ${info.prometido}`);
    } catch (e) { console.log(`     ❌ ${(e as Error).message.slice(0, 120)}`); }
  }
  console.log(`\nfuturas afetadas: ${futuras}${APPLY ? ` | corrigidas: ${corrigidas}` : " (dry-run — rode com --apply)"}`);
}
main();
