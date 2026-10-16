/**
 * H105 (#445) — replay do detector "quem conduz a conversa" contra conversas REAIS.
 * Compara, por conversa, a decisão do F52 de hoje (última saída + guarda de eco por
 * tempo) com a nova (saída que decide + guarda por id) e com o modo estrito.
 * Read-only.
 *
 *   npx tsx scripts/_replay-h105.ts <locationId|all> [dias=14] [max=400]
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { GHLClient } from "../src/lib/ghl/client";
import { isChatMessageType } from "../src/lib/ghl/message-sources";
import {
  classifyLastOutbound, extractAiSentTexts, extractAiSentIds,
  saidaQueDecide, pareceEcoDoEnvio, contatoDaEquipe, isAiEcho,
  type MensagemDoHistoricoGhl,
} from "../src/lib/queue/human-takeover";

const ALVO = process.argv[2] || "pGl5pqLLG0QDixANpFnP";
const DIAS = Number(process.argv[3] || 14);
const MAX = Number(process.argv[4] || 400);
const STALE = 72 * 3600_000;

type Msg = MensagemDoHistoricoGhl & { id: string; dateAdded: string };

async function main() {
  const sb = createAdminClient();
  let q = sb.from("agents").select("id,name,location_id,status,type").in("type", ["sales_agent", "recruitment_agent", "custom_agent"]).eq("status", "active");
  if (ALVO !== "all") q = q.eq("location_id", ALVO);
  const { data: agents } = await q;
  const since = new Date(Date.now() - DIAS * 86400_000).toISOString();
  const { data: locs } = await sb.from("locations").select("location_id,company_id");
  const companyOf = new Map((locs || []).map((l) => [l.location_id as string, l.company_id as string]));

  const tot = { conv: 0, semHist: 0, oldPausa: 0, newPausa: 0, soNova: 0, soVelha: 0, estrito: 0, estritoSemNova: 0, idsAi: 0, idsAiBatem: 0 };
  const linhas: string[] = [];
  for (const ag of agents || []) {
    const { data: rows } = await sb.from("conversation_state")
      .select("contact_id,conversation_id,status,ai_paused_at,ai_resumed_at,updated_at")
      .eq("agent_id", ag.id).is("ai_paused_at", null).gte("updated_at", since)
      .order("updated_at", { ascending: false }).limit(MAX);
    const ghl = new GHLClient(companyOf.get(ag.location_id) || "", ag.location_id);
    for (const r of rows || []) {
      if (!r.conversation_id) { tot.semHist++; continue; }
      let msgs: Msg[] = [];
      try {
        const resp = await ghl.get<{ messages?: { messages?: Msg[] } }>(`/conversations/${r.conversation_id}/messages`, { locationId: ag.location_id });
        msgs = resp?.messages?.messages || [];
      } catch { tot.semHist++; continue; }
      if (!msgs.length) { tot.semHist++; continue; }
      tot.conv++;
      const { data: aiSends } = await sb.from("execution_log").select("action_payload,created_at")
        .eq("location_id", ag.location_id).eq("contact_id", r.contact_id)
        .in("action_type", ["send_message", "send_error_message", "book_blocked_no_contact"]).eq("success", true)
        .order("created_at", { ascending: false }).limit(30);
      const aiTexts = extractAiSentTexts(aiSends);
      const sentIds = extractAiSentIds(aiSends);
      const lastAiMs = aiSends?.[0]?.created_at ? Date.parse(aiSends[0].created_at as string) : 0;
      const idsUlt = extractAiSentIds(aiSends ? [aiSends[0]] : []);
      const resumedMs = r.ai_resumed_at ? Date.parse(r.ai_resumed_at) : 0;

      // premissa do id: mensagem da IA no histórico (por texto) tem o id logado?
      for (const m of msgs) if (m.direction === "outbound" && m.body && isAiEcho(m.body, aiTexts)) { tot.idsAi++; if (sentIds.includes(m.id)) tot.idsAiBatem++; }

      const decide = (o: Msg | undefined, guarda: "velha" | "nova") => {
        if (!o) return { pausa: false, o };
        const { isHuman } = classifyLastOutbound({ lastOutbound: o, aiTexts, sentIds });
        const ts = Date.parse(o.dateAdded);
        const eco = guarda === "velha"
          ? lastAiMs > 0 && ts - lastAiMs <= 120_000 && ts - lastAiMs >= -5_000
          : pareceEcoDoEnvio({ saida: o, ultimoEnvioEmMs: lastAiMs, idsDoUltimoEnvio: idsUlt });
        const stale = Date.now() - ts > STALE;
        const override = resumedMs > 0 && ts <= resumedMs;
        return { pausa: isHuman && !eco && !stale && !override, o };
      };
      const lastOld = [...msgs].sort((a, b) => Date.parse(b.dateAdded) - Date.parse(a.dateAdded)).find((m) => m.direction === "outbound" && isChatMessageType(m.messageType));
      const velha = decide(lastOld, "velha");
      const nova = decide(saidaQueDecide(msgs), "nova");
      const eq = contatoDaEquipe(msgs, { textos: aiTexts, ids: sentIds });
      const estritoPausa = !!eq && !(resumedMs > 0 && Date.parse(eq.dateAdded) <= resumedMs);
      if (velha.pausa) tot.oldPausa++;
      if (nova.pausa) tot.newPausa++;
      if (nova.pausa && !velha.pausa) tot.soNova++;
      if (velha.pausa && !nova.pausa) tot.soVelha++;
      if (estritoPausa) tot.estrito++;
      if (estritoPausa && !nova.pausa) tot.estritoSemNova++;
      if (nova.pausa !== velha.pausa || estritoPausa) {
        const fmt = (m?: Msg | null) => m ? `${m.dateAdded.slice(5, 16)} [${m.source ?? "-"}|${m.userId ? "uid" : "sem-uid"}|${m.messageType}] "${String(m.body || "").replace(/\s+/g, " ").slice(0, 90)}"` : "-";
        linhas.push(`${ag.name} | contato ${r.contact_id} | velha=${velha.pausa} nova=${nova.pausa} estrito=${estritoPausa} | últ.envio IA ${lastAiMs ? new Date(lastAiMs).toISOString().slice(5, 16) : "-"}\n   decide(nova): ${fmt(nova.o)}\n   decide(velha): ${fmt(velha.o)}\n   equipe: ${fmt(eq)}`);
      }
    }
  }
  console.log(JSON.stringify(tot, null, 1));
  console.log(linhas.join("\n"));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
