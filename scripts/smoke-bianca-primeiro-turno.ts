/**
 * Smoke do PRIMEIRO turno do agente de trafego pago da Bianca, no caminho de PROD.
 *
 * Por que nao usar o endpoint /api/agents/test: numa sessao nova sem contato ele
 * calcula priorTurnCount = 0, entao trata o 1o turno como 1o turno de verdade e
 * injeta o greeting_style. Em PROD o historico ja vem do Spark Leads com a
 * mensagem do proprio lead, priorTurnCount = 1, e o greeting_style nunca entra.
 * O endpoint mostraria a saudacao "certa" mesmo sem conserto nenhum.
 *
 * Aqui os argumentos do processWithAI espelham o queue-processor:
 * conversationMessages com a mensagem do lead, newMessages com o mesmo texto,
 * priorTurnCount = conversationTurns.length (= 1). O sanitizer roda dentro do
 * processWithAI, entao o que sai e o que o lead receberia.
 * Nao chama o Spark Leads (sem horarios, sem contato) e nao envia nada.
 *
 *   STRESS_ENV_FILE=/tmp/.prodenv-stress npx tsx scripts/smoke-bianca-primeiro-turno.ts
 */
import { config } from "dotenv";
config({ path: process.env.STRESS_ENV_FILE || "/tmp/.prodenv-stress" });

const AGENT_ID = "17860a86-ace9-4299-9328-2452151348a0";
const LEADS = [
  "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,",
  "oi, vi o anúncio",
];

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } = await import("@/lib/ai/sales-prompt-builder");
  const { processWithAI } = await import("@/lib/ai/openai-client");
  const sb = createAdminClient();
  const { data: agent } = await sb.from("agents").select("*, agent_configs(*)").eq("id", AGENT_ID).single();
  const cfg = Array.isArray(agent!.agent_configs) ? agent!.agent_configs[0] : agent!.agent_configs;
  const { data: loc } = await sb.from("locations").select("*").eq("location_id", agent!.location_id).single();
  const tz = loc?.timezone || "America/New_York";
  const agora = new Date();
  const data = agora.toLocaleDateString("pt-BR", { timeZone: tz, weekday: "long", day: "2-digit", month: "2-digit", year: "numeric" });
  const hora = agora.toLocaleTimeString("pt-BR", { timeZone: tz, hour: "2-digit", minute: "2-digit" });

  const rodar = async (msg: string, prior: number) => {
    const ctx = {
      config: cfg, agentType: "recruitment_agent" as const, contactName: "", collectedData: {},
      locationName: loc?.location_name || "Five Rings", currentDate: `${data}, ${hora}`, timezone: tz,
      availableSlots: "", slotsUnavailable: false, knowledgeBase: undefined, feedback: [],
      priorTurnCount: prior,
    };
    const turns = prior > 0 ? [{ role: "user" as const, content: msg }] : [];
    return processWithAI({
      systemPrompt: buildSystemPrompt(ctx as never), runtimeContext: buildRuntimeContext(ctx as never),
      conversationMessages: turns, conversationHistory: "", newMessages: msg,
      model: cfg.ai_model || "claude-sonnet-4-6", responseSchema: buildResponseJsonSchema(ctx as never),
      priorTurnCount: prior,
    });
  };

  for (const msg of LEADS) {
    const r = await rodar(msg, 1);
    const b = Array.isArray(r.response?.message) ? r.response!.message : [r.response?.message];
    console.log(`\n### PROD (priorTurnCount=1) · LEAD: ${msg}`);
    b.forEach((x) => console.log(`   IA: ${x}`));
  }
  // Contraste: o que sairia se o 1o turno fosse reconhecido como 1o (correcao de codigo pendente).
  const c = await rodar(LEADS[0], 0);
  const cb = Array.isArray(c.response?.message) ? c.response!.message : [c.response?.message];
  console.log(`\n### CONTRASTE (priorTurnCount=0, so com a correcao de codigo) · LEAD: ${LEADS[0]}`);
  cb.forEach((x) => console.log(`   IA: ${x}`));
}
main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
