/**
 * One-off (Pedro 2026-06-19): registra as mensagens REAIS que a Jussara mandou
 * ao SparkBot (do 689) que nunca viraram sparkbot_messages porque o número não
 * batia com o GHL user dela. Isso (a) dá contexto ao bot (#3) e (b) satisfaz a
 * guarda de opt-in via WhatsApp (channel='whatsapp' + role='user') pra liberar o
 * reenvio dos termos. São mensagens verídicas dela (lidas do GHL), não sintéticas.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/backfill-jussara-context.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";

const HUB_LOCATION = "RBFxlEQZobaDjlF2i5px";
const ACTIVE_LOCATION = "pGl5pqLLG0QDixANpFnP";
const HUB_AGENT = "483ca4eb-dd5e-4da7-bd4e-6ff1f85f240b";
const REP_ID = "8dc0cb84-f423-4efb-b3d9-3b87dd7ad699";
const HUB_CONTACT = "kTVVSlYqF8JBbFuZFRvj"; // "jussara - agendamento" +16892033343

async function main() {
  const supabase = createAdminClient();
  const { data: loc } = await supabase.from("locations").select("company_id").eq("location_id", HUB_LOCATION).maybeSingle();
  if (!loc?.company_id) throw new Error("hub sem company_id");
  const client = new GHLClient(loc.company_id, HUB_LOCATION);

  const cs = await client.get<{ conversations?: Array<{ id: string }> }>("/conversations/search", { locationId: HUB_LOCATION, contactId: HUB_CONTACT });
  const convs = cs.conversations || [];
  type Msg = { id: string; direction?: string; body?: string; messageType?: string; dateAdded?: string };
  const inbound: Msg[] = [];
  for (const c of convs) {
    const r = await client.get<{ messages?: { messages?: Msg[] } }>(`/conversations/${c.id}/messages`, { locationId: HUB_LOCATION, limit: "50" });
    for (const m of r.messages?.messages || []) {
      if (String(m.direction || "").toLowerCase().startsWith("in")) inbound.push(m);
    }
  }
  inbound.sort((a, b) => new Date(a.dateAdded || 0).getTime() - new Date(b.dateAdded || 0).getTime());
  console.log(`mensagens inbound da Jussara: ${inbound.length}`);

  let inserted = 0;
  let latest: string | null = null;
  for (const m of inbound) {
    // Dedup por ghl_message_id (idempotente).
    if (m.id) {
      const { data: dup } = await supabase.from("sparkbot_messages").select("id").eq("ghl_message_id", m.id).maybeSingle();
      if (dup) { console.log(`  skip (já existe): ${m.id}`); continue; }
    }
    const raw = (m.body || "").trim();
    // Nunca content vazio (Claude rejeita). Áudio/placeholder → marcador.
    const isPlaceholder = !raw || /^audio message\.?$/i.test(raw) || /^image$/i.test(raw);
    const content = isPlaceholder ? "[áudio recebido — sem transcrição]" : raw;
    const { error } = await supabase.from("sparkbot_messages").insert({
      rep_id: REP_ID,
      hub_location_id: HUB_LOCATION,
      agent_id: HUB_AGENT,
      active_location_id: ACTIVE_LOCATION,
      role: "user",
      channel: "whatsapp",
      content,
      ghl_message_id: m.id || null,
      created_at: m.dateAdded || new Date().toISOString(),
      metadata: { backfill: true, reason: "phone_mismatch_recovery_2026-06-19", source_contact: HUB_CONTACT },
    });
    if (error) { console.log(`  ERRO insert ${m.id}:`, error.message); continue; }
    inserted++;
    if (m.dateAdded && (!latest || m.dateAdded > latest)) latest = m.dateAdded;
    console.log(`  + [${String(m.dateAdded).slice(0,19)}] ${content.slice(0, 70).replace(/\n/g, " ")}`);
  }

  if (latest) {
    await supabase.from("rep_identities").update({ last_inbound_at: latest }).eq("id", REP_ID);
    console.log(`last_inbound_at atualizado pra ${latest}`);
  }
  console.log(`\n✅ ${inserted} mensagens registradas. Opt-in WhatsApp satisfeito: ${inserted > 0}`);
  process.exit(0);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
