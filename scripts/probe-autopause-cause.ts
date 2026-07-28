/**
 * PROBE READ-ONLY (2026-07-28): por que a IA se auto-pausa depois de 1 mensagem?
 *
 * Hipótese: `lastOutbound` no queue-processor pega QUALQUER outbound do histórico
 * (sem filtrar tipo). Uma LIGAÇÃO registrada na conversa (TYPE_CALL) tem body
 * vazio + userId do rep → a ladder do F52 classifica como "humano assumiu"
 * (discriminador 3 userId / 5 sem-texto) → auto-pause permanente.
 *
 * Este probe pega as conversas pausadas por auto_pause:human_message e mostra o
 * ÚLTIMO OUTBOUND ANTES DA PAUSA com tipo/body/userId/source + se o id bate com
 * o que a IA registrou ter enviado. NÃO escreve nada.
 *
 * Uso: npx tsx scripts/probe-autopause-cause.ts [LOCATION_ID]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import { extractAiSentIds, extractAiSentTexts, classifyLastOutbound } from "@/lib/queue/human-takeover";

interface GhlMsg {
  id: string;
  direction: string;
  body?: string;
  messageType?: string;
  type?: number | string;
  userId?: string | null;
  source?: string | null;
  dateAdded: string;
}

async function main() {
  const onlyLocation = process.argv[2] || null;
  const supabase = createAdminClient();

  let q = supabase
    .from("conversation_state")
    .select("contact_id, agent_id, location_id, conversation_id, ai_paused_at, ai_paused_reason, message_count")
    .like("ai_paused_reason", "auto_pause:human_message%")
    .gte("ai_paused_at", new Date(Date.now() - 5 * 24 * 3600_000).toISOString())
    .order("ai_paused_at", { ascending: false })
    .limit(onlyLocation ? 12 : 25);
  if (onlyLocation) q = q.eq("location_id", onlyLocation);
  const { data: paused } = await q;
  if (!paused?.length) {
    console.log("Nenhuma conversa pausada na janela.");
    process.exit(0);
  }

  const tally = new Map<string, number>();
  const companyCache = new Map<string, string>();

  for (const p of paused) {
    const locId = p.location_id as string;
    if (!companyCache.has(locId)) {
      const { data: loc } = await supabase
        .from("locations").select("company_id").eq("location_id", locId).maybeSingle();
      if (!loc?.company_id) continue;
      companyCache.set(locId, loc.company_id as string);
    }
    const client = new GHLClient(companyCache.get(locId)!, locId);

    // Mesmo fetch do runtime
    let msgs: GhlMsg[] = [];
    try {
      const res = await client.get<{ messages?: { messages?: GhlMsg[] } }>(
        `/conversations/${p.conversation_id}/messages`,
        { locationId: locId },
      );
      msgs = (res?.messages?.messages || []).slice()
        .sort((a, b) => new Date(a.dateAdded).getTime() - new Date(b.dateAdded).getTime());
    } catch (e) {
      console.log(`  (falha ao buscar conversa de ${p.contact_id}: ${e instanceof Error ? e.message : e})`);
      continue;
    }

    const pausedAt = new Date(p.ai_paused_at as string).getTime();
    // Último outbound ANTES do instante da pausa (o que o runtime viu)
    const lastOutbound = [...msgs]
      .filter((m) => m.direction === "outbound" && new Date(m.dateAdded).getTime() <= pausedAt + 5000)
      .pop();
    if (!lastOutbound) {
      console.log(`\n${p.contact_id} (${locId}): sem outbound antes da pausa`);
      continue;
    }

    const { data: sends } = await supabase
      .from("execution_log")
      .select("action_payload")
      .eq("location_id", locId).eq("contact_id", p.contact_id)
      .eq("action_type", "send_message").eq("success", true)
      .order("created_at", { ascending: false }).limit(30);
    const sentIds = extractAiSentIds(sends);
    const aiTexts = extractAiSentTexts(sends);

    const verdict = classifyLastOutbound({
      lastOutbound: {
        id: lastOutbound.id,
        body: lastOutbound.body,
        userId: lastOutbound.userId,
        source: lastOutbound.source,
      },
      aiTexts,
      sentIds,
    });

    const mt = lastOutbound.messageType || `type=${lastOutbound.type}`;
    const bodyLen = (lastOutbound.body || "").trim().length;
    const idMatch = sentIds.includes(lastOutbound.id);
    const key = `${mt} | body=${bodyLen === 0 ? "VAZIO" : bodyLen + "ch"} | userId=${lastOutbound.userId ? "SIM" : "não"} | idMatch=${idMatch}`;
    tally.set(key, (tally.get(key) || 0) + 1);

    console.log(`\n${p.contact_id} (${locId}) msgs=${p.message_count} pausa=${p.ai_paused_at}`);
    console.log(`  último outbound: ${mt} · body=${JSON.stringify((lastOutbound.body || "").slice(0, 60))}`);
    console.log(`  userId=${lastOutbound.userId || "-"} source=${lastOutbound.source || "-"} id=${lastOutbound.id}`);
    console.log(`  ids gravados pela IA: ${sentIds.length} · idMatch=${idMatch} · isHuman(recomputado)=${verdict.isHuman}`);
  }

  console.log(`\n\n═══ PADRÃO DAS ${paused.length} PAUSAS ═══`);
  for (const [k, v] of [...tally.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${v}×  ${k}`);
  }
  process.exit(0);
}

main();
