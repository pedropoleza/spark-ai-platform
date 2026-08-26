/**
 * READ-ONLY — vigia o fluxo de pós-atendimento da Marina na PERSONAL account.
 * Use DEPOIS de conectar o WhatsApp API e disparar o workflow no 1º contato real:
 * mostra se o inbound chegou na nossa fila, se o targeting deixou passar e o que
 * a IA respondeu.
 *
 *   npx tsx scripts/watch-marina-pos.ts [horas=6]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "ONRf1DUKVnfxivEGxcTj";
const AGENT = "d4894e2a-43fa-4b2f-8949-0bbd941be2b9";

async function main() {
  const horas = Number(process.argv[2] || 6);
  const desde = new Date(Date.now() - horas * 3600_000).toISOString();
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();

  const { data: ag } = await sb.from("agents").select("name,status,location_id").eq("id", AGENT).single();
  console.log(`AGENTE: ${ag?.name} · status=${ag?.status} · location=${ag?.location_id}`);
  console.log(`Janela: últimas ${horas}h\n`);

  const { data: fila } = await sb
    .from("message_queue")
    .select("received_at, contact_id, channel, status, message_body")
    .eq("location_id", LOC)
    .gte("received_at", desde)
    .order("received_at");
  console.log(`=== FILA DE ENTRADA (${fila?.length ?? 0}) ===`);
  if (!fila?.length) console.log("  (nada — se você já mandou WhatsApp, o webhook da location NÃO está chegando)");
  for (const m of fila || []) {
    console.log(`  ${m.received_at} [${m.channel}/${m.status}] ${m.contact_id} :: ${String(m.message_body).slice(0, 70)}`);
  }

  const { data: log } = await sb
    .from("execution_log")
    .select("created_at, contact_id, action_type, success, action_payload")
    .eq("location_id", LOC)
    .gte("created_at", desde)
    .order("created_at");
  console.log(`\n=== EXECUÇÃO (${log?.length ?? 0}) ===`);
  for (const e of log || []) {
    const extra =
      e.action_type === "targeting_skip"
        ? ` ← BARRADO (contato sem a tag pos-atendimento-ia?)`
        : e.action_type === "send_message"
          ? ` :: ${JSON.stringify((e.action_payload as { message?: unknown })?.message).slice(0, 90)}`
          : "";
    console.log(`  ${e.created_at} ${e.action_type}${e.success ? "" : " (FALHOU)"} ${e.contact_id}${extra}`);
  }

  const { data: convs } = await sb
    .from("conversation_state")
    .select("contact_id, status, message_count, ai_paused_at, ai_paused_reason, last_ai_response_at")
    .eq("agent_id", AGENT);
  console.log(`\n=== CONVERSAS DO AGENTE (${convs?.length ?? 0}) ===`);
  for (const c of convs || []) {
    console.log(`  ${c.contact_id} status=${c.status} msgs=${c.message_count}${c.ai_paused_at ? ` PAUSADA(${c.ai_paused_reason})` : ""}`);
  }
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
