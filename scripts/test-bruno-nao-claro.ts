/**
 * Replay da conversa REAL da Enaira com o prompt novo do Bruno, no modelo de
 * produção (Sonnet). Não grava nada. Precisa de ANTHROPIC_API_KEY (Vault).
 *   npx tsx scripts/test-bruno-nao-claro.ts
 */
import { config } from "dotenv"; import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "../src/lib/ai/sales-prompt-builder";
import { processWithAI, type ConversationTurn } from "../src/lib/ai/openai-client";
import { aplicar, BRUNO } from "./bruno-nao-claro";
import type { AgentConfig } from "../src/types/agent";

const ENAIRA = "FFMMPM4HSJH5gsH2PAO4";
let ok = 0, fail = 0;
const t = (n: string, c: boolean, d = "") => { if (c) { ok++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}${d ? "  → " + d : ""}`); } };

(async () => {
  if (!process.env.ANTHROPIC_API_KEY) { console.log("sem ANTHROPIC_API_KEY — rode com a chave do Vault"); process.exit(1); }
  const sb = createAdminClient();
  const { data: c } = await sb.from("agent_configs").select("*").eq("agent_id", BRUNO).single();
  const cfg = { ...(c as AgentConfig), custom_instructions: aplicar(String((c as AgentConfig).custom_instructions || "")) } as AgentConfig;

  // histórico real até a recusa (13:10:01 UTC)
  const ATE = "2026-10-07T13:10:00Z";
  const { data: ins } = await sb.from("message_queue").select("created_at,message_body").eq("contact_id", ENAIRA).lt("created_at", ATE).order("created_at", { ascending: false }).limit(8);
  const { data: outs } = await sb.from("execution_log").select("created_at,action_payload").eq("contact_id", ENAIRA).eq("action_type", "send_message").lt("created_at", ATE).order("created_at", { ascending: false }).limit(8);
  const turns: Array<{ at: string; t: ConversationTurn }> = [];
  for (const m of ins || []) turns.push({ at: (m as { created_at: string }).created_at, t: { role: "user", content: String((m as { message_body: string }).message_body) } });
  for (const o of outs || []) { const msg = (o as { action_payload: { message?: string[] | string } }).action_payload?.message;
    turns.push({ at: (o as { created_at: string }).created_at, t: { role: "assistant", content: Array.isArray(msg) ? msg.join("\n") : String(msg ?? "") } }); }
  const historico = turns.sort((a, b) => a.at.localeCompare(b.at)).slice(-10).map((x) => x.t);

  const base = {
    config: cfg, agentType: "recruitment_agent" as const, contactName: "Enaira",
    locationName: "Alves Cury Financial", timezone: "America/New_York",
    currentDate: "07/10/2026 09:10", collectedData: {},
  };
  async function turno(hist: ConversationTurn[], fala: string) {
    const ctx = { ...base, priorTurnCount: hist.length };
    const r = await processWithAI({
      systemPrompt: buildSystemPrompt(ctx), runtimeContext: buildRuntimeContext(ctx),
      conversationMessages: hist, conversationHistory: "", newMessages: fala,
      model: "claude-sonnet-4-6", responseSchema: buildResponseJsonSchema(ctx), priorTurnCount: hist.length,
    });
    const resp = r.response as { message?: string[] | string; conversation_status?: string };
    return { texto: Array.isArray(resp?.message) ? resp.message.join(" | ") : String(resp?.message ?? ""), status: resp?.conversation_status, modelo: r.model };
  }
  const pergunta = (s: string) => /\?/.test(s);
  const repitch = (s: string) => /oportunidade|agente financeiro|carreira|zoom|taciana|hor[áa]rio|renda|ganhar/i.test(s);

  console.log("A. A recusa real: \"Olha não é o que eu busco no momento\" + \"imaginei que era outra coisa\"");
  const a = await turno(historico, "Olha não é o que eu busco no momento\nE que como\nNão foi com mais clareza eu imaginei que era outra coisa");
  console.log(`   [${a.modelo}] ${a.texto}\n   status=${a.status}`);
  t("marca disqualified (é o que para o follow-up)", a.status === "disqualified");
  t("não pergunta nada", !pergunta(a.texto), a.texto);
  t("não reapresenta a oportunidade", !repitch(a.texto), a.texto);

  console.log("\nB. Ela volta 2h depois explicando a confusão");
  const histB = [...historico, { role: "user" as const, content: "Olha não é o que eu busco no momento" }, { role: "assistant" as const, content: a.texto }];
  const b = await turno(histB, "Não imaginei que fosse o curso para trabalhar na área financeira\nMais me confundi");
  console.log(`   [${b.modelo}] ${b.texto}\n   status=${b.status}`);
  t("responde curto (≤ 2 frases)", b.texto.split(/[.!]\s|\|/).filter((x) => x.trim()).length <= 3, b.texto);
  t("não volta a vender a oportunidade", !repitch(b.texto), b.texto);

  console.log("\nC. CONTROLE: hesitação (\"vou pensar\") ainda ganha 1 reancoragem");
  const c2 = await turno(historico, "Hmm, vou pensar e te falo");
  console.log(`   [${c2.modelo}] ${c2.texto}\n   status=${c2.status}`);
  t("hesitação NÃO é tratada como não claro", c2.status !== "disqualified", `status=${c2.status}`);

  console.log("\nD. CONTROLE: falta de tempo (\"agora não posso\") não é recusa");
  const d = await turno(historico, "Agora não posso falar, tô no trabalho");
  console.log(`   [${d.modelo}] ${d.texto}\n   status=${d.status}`);
  t("falta de tempo NÃO encerra", d.status !== "disqualified", `status=${d.status}`);

  console.log(`\nRESULTADO: ${ok} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
})();
