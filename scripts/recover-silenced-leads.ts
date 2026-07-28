/**
 * Recuperação dos leads silenciados pelo bug "atividade do CRM = humano"
 * (Alves Cury 2026-07-28). DRY-RUN por padrão.
 *
 * Para cada contato que tomou `should_respond_skip:human_replied_recently` nos
 * últimos dias, re-avalia a conversa com a lógica NOVA (ignora atividade do CRM
 * e ligação, + anti-eco por ID). Só marca pra recuperar quando:
 *   (a) a nova lógica NÃO vê humano recente (era falso-positivo), E
 *   (b) a última mensagem da conversa é INBOUND (o lead está esperando), E
 *   (c) a conversa não está pausada.
 * Assim não atropela quem um humano de verdade assumiu depois.
 *
 * Uso:
 *   npx tsx scripts/recover-silenced-leads.ts            # dry-run (só relatório)
 *   npx tsx scripts/recover-silenced-leads.ts --apply    # re-enfileira
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { isHumanOutboundMessage } from "@/lib/queue/lead-history";
import { extractAiSentTexts, extractAiSentIds } from "@/lib/queue/human-takeover";

const APPLY = process.argv.includes("--apply");
const WINDOW_DAYS = 7;
const HUMAN_WINDOW_MIN = 60;

async function main() {
  const supabase = createAdminClient();
  const since = new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString();

  const { data: skips } = await supabase
    .from("execution_log")
    .select("location_id, contact_id, agent_id, created_at")
    .eq("action_type", "should_respond_skip")
    .gte("created_at", since)
    .order("created_at", { ascending: false });

  const pairs = new Map<string, { locationId: string; contactId: string; agentId: string }>();
  for (const s of skips || []) {
    const k = `${s.agent_id}|${s.contact_id}`;
    if (!pairs.has(k)) {
      pairs.set(k, {
        locationId: s.location_id as string,
        contactId: s.contact_id as string,
        agentId: s.agent_id as string,
      });
    }
  }
  console.log(`${pairs.size} contatos com should_respond_skip nos últimos ${WINDOW_DAYS}d\n`);

  const companyCache = new Map<string, string>();
  const recover: Array<{ agentId: string; contactId: string; locationId: string; lastInbound: string }> = [];
  let humanoReal = 0, semEspera = 0, pausados = 0, erro = 0;

  for (const p of pairs.values()) {
    const { data: cs } = await supabase
      .from("conversation_state")
      .select("conversation_id, ai_paused_at")
      .eq("agent_id", p.agentId).eq("contact_id", p.contactId).maybeSingle();
    if (!cs?.conversation_id) { erro++; continue; }
    if (cs.ai_paused_at) { pausados++; continue; }

    if (!companyCache.has(p.locationId)) {
      const { data: loc } = await supabase
        .from("locations").select("company_id").eq("location_id", p.locationId).maybeSingle();
      if (!loc?.company_id) { erro++; continue; }
      companyCache.set(p.locationId, loc.company_id as string);
    }

    const { data: sends } = await supabase
      .from("execution_log").select("action_payload")
      .eq("location_id", p.locationId).eq("contact_id", p.contactId)
      .eq("action_type", "send_message").eq("success", true)
      .order("created_at", { ascending: false }).limit(30);
    const aiTexts = extractAiSentTexts(sends);
    const aiIds = extractAiSentIds(sends);

    let msgs: Array<Record<string, unknown>> = [];
    try {
      const res = await new GHLClient(companyCache.get(p.locationId)!, p.locationId)
        .get<{ messages?: { messages?: Array<Record<string, unknown>> } }>(
          `/conversations/${cs.conversation_id}/messages`, { locationId: p.locationId },
        );
      msgs = (res?.messages?.messages || []).slice()
        .sort((a, b) => new Date(String(a.dateAdded)).getTime() - new Date(String(b.dateAdded)).getTime());
    } catch { erro++; continue; }
    if (msgs.length === 0) { erro++; continue; }

    const last = msgs[msgs.length - 1];
    if (String(last.direction) !== "inbound") { semEspera++; continue; }

    // Nova lógica: ainda vê humano recente?
    const lastHuman = msgs.slice().reverse().find((m) =>
      isHumanOutboundMessage(
        {
          direction: String(m.direction), source: m.source ? String(m.source) : null,
          body: String(m.body || ""), userId: m.userId ? String(m.userId) : null,
          messageType: m.messageType ? String(m.messageType) : null, id: String(m.id),
        },
        aiTexts, aiIds,
      ),
    );
    const humanRecent = lastHuman
      && (Date.now() - new Date(String(lastHuman.dateAdded)).getTime()) / 60000 <= HUMAN_WINDOW_MIN;
    if (humanRecent) { humanoReal++; continue; }

    recover.push({
      agentId: p.agentId, contactId: p.contactId, locationId: p.locationId,
      lastInbound: String(last.dateAdded),
    });
    console.log(`  ↻ ${p.contactId} (${p.locationId}) última msg do LEAD ${String(last.dateAdded).slice(0, 16)}: ${JSON.stringify(String(last.body || "").slice(0, 50))}`);
  }

  console.log(`\n═══ RESUMO ═══`);
  console.log(`  a recuperar (falso-positivo + lead esperando): ${recover.length}`);
  console.log(`  humano de verdade atendendo agora: ${humanoReal}`);
  console.log(`  última msg não é do lead (já respondido): ${semEspera}`);
  console.log(`  pausados (outro motivo): ${pausados} · erro/sem dados: ${erro}`);

  if (!APPLY) {
    console.log(`\nDRY-RUN. Pra re-enfileirar: npx tsx scripts/recover-silenced-leads.ts --apply`);
    process.exit(0);
  }

  let requeued = 0;
  for (const r of recover) {
    const { data } = await supabase
      .from("message_queue")
      .update({ status: "pending", process_after: new Date().toISOString() })
      .eq("agent_id", r.agentId).eq("contact_id", r.contactId)
      .eq("message_direction", "inbound").eq("status", "completed")
      .gte("received_at", new Date(Date.now() - WINDOW_DAYS * 86400_000).toISOString())
      .select("id");
    requeued += data?.length || 0;
  }
  console.log(`\n✅ ${requeued} inbound(s) re-enfileirado(s) em ${recover.length} conversa(s).`);
  process.exit(0);
}

main();
