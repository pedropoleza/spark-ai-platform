/**
 * H107 (chamado #455, caso Márcia): replay do guarda de pergunta repetida
 * contra os pulos REAIS de follow-up. Só leitura.
 *
 * Para cada `followup_skipped` com reason=repeated_question do agente, refaz o
 * histórico que o runner leu naquele instante (últimas 10 mensagens de chat do
 * Spark Leads, linhas AGENTE) e julga o texto do passo (custom_message da linha)
 * duas vezes: sem e com `textoDoAdmin`. Antes do H107 o literal do passo era
 * vetado; depois, só pedido que o modelo acrescenta continua sendo julgado.
 *
 *   npx tsx scripts/_replay-h107.ts [agentId] [desde=2026-08-31]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: process.env.ENV_FILE || resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { isChatMessageType } from "../src/lib/ghl/message-sources";
import { isRepeatedAsk, agentLinesFromHistory } from "../src/lib/queue/followup-repeat-guard";

const AGENTE = process.argv[2] || "7c0a72b7-e37c-463d-be56-73b7822a3037";
const DESDE = process.argv[3] || "2026-08-31";

interface Msg {
  id: string;
  direction: string;
  body?: string;
  dateAdded: string;
  messageType?: string;
}

async function main() {
  const sb = createAdminClient();
  const { data: ag } = await sb.from("agents").select("id,name,location_id").eq("id", AGENTE).single();
  if (!ag) throw new Error("agente não encontrado");
  const { data: loc } = await sb.from("locations").select("company_id").eq("location_id", ag.location_id).single();
  const ghl = new GHLClient((loc?.company_id as string) || "", ag.location_id as string);

  const { data: pulos } = await sb
    .from("execution_log")
    .select("contact_id,created_at,action_payload")
    .eq("agent_id", AGENTE)
    .eq("action_type", "followup_skipped")
    .gte("created_at", DESDE)
    .order("created_at", { ascending: true });
  const alvo = (pulos || []).filter((p) => (p.action_payload as { reason?: string } | null)?.reason === "repeated_question");

  const tot = { pulos: alvo.length, semTexto: 0, semHist: 0, antes: 0, depois: 0 };
  const cacheHist = new Map<string, Msg[]>();
  for (const p of alvo) {
    const quando = p.created_at as string;
    const tentativa = Number((p.action_payload as { attempt_number?: number }).attempt_number);
    // A linha do toque: mesmo par e tentativa, encerrada no minuto do pulo.
    const { data: linhas } = await sb
      .from("scheduled_followups")
      .select("custom_message,updated_at")
      .eq("agent_id", AGENTE)
      .eq("contact_id", p.contact_id)
      .eq("attempt_number", tentativa)
      .gte("updated_at", new Date(Date.parse(quando) - 120_000).toISOString())
      .lte("updated_at", new Date(Date.parse(quando) + 120_000).toISOString())
      .limit(1);
    const texto = (linhas?.[0]?.custom_message as string | null) || "";
    if (!texto) {
      tot.semTexto++;
      continue;
    }
    const { data: cs } = await sb
      .from("conversation_state")
      .select("conversation_id")
      .eq("agent_id", AGENTE)
      .eq("contact_id", p.contact_id)
      .maybeSingle();
    const convId = cs?.conversation_id as string | undefined;
    if (!convId) {
      tot.semHist++;
      continue;
    }
    let msgs = cacheHist.get(convId);
    if (!msgs) {
      try {
        const r = await ghl.get<{ messages?: { messages?: Msg[] } }>(`/conversations/${convId}/messages`, {
          locationId: ag.location_id as string,
          limit: 100,
        });
        msgs = r?.messages?.messages || [];
      } catch {
        msgs = [];
      }
      cacheHist.set(convId, msgs);
    }
    // Mesmo recorte do runner (follow-up-scheduler.ts): chat, com corpo, até o instante do pulo.
    const hist = msgs
      .filter((m) => Date.parse(m.dateAdded) < Date.parse(quando))
      .filter((m) => isChatMessageType(m.messageType))
      .filter((m) => m.messageType === "TYPE_CUSTOM_SMS" || m.body)
      .sort((a, b) => Date.parse(a.dateAdded) - Date.parse(b.dateAdded))
      .slice(-10)
      .map((m) => `${m.direction === "inbound" ? "LEAD" : "AGENTE"}: ${(m.body || "").substring(0, 300)}`)
      .join("\n");
    if (!hist.trim()) {
      tot.semHist++;
      continue;
    }
    const prior = agentLinesFromHistory(hist);
    const vAntes = isRepeatedAsk(texto, prior);
    const vDepois = isRepeatedAsk(texto, prior, { textoDoAdmin: texto });
    if (vAntes.repeated) tot.antes++;
    if (vDepois.repeated) tot.depois++;
    console.log(
      `${quando.slice(0, 16)} ${p.contact_id} #${tentativa} antes=${vAntes.repeated ? "VETA" : "passa"}(${vAntes.via ?? "-"}) depois=${vDepois.repeated ? "VETA" : "passa"}`,
    );
  }
  console.log(
    `\n${ag.name}: ${tot.pulos} pulos reais · sem texto do admin ${tot.semTexto} · sem histórico ${tot.semHist} · ` +
      `literal do passo vetado ANTES ${tot.antes} · DEPOIS ${tot.depois}`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
