// Reproduz fluxo /api/agents/test pro sales agent (Marcos)
// Bypassa SSO e chama as funções core direto pra ver onde crash.
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { GHLClient } from "@/lib/ghl/client";
import {
  buildSystemPrompt,
  buildRuntimeContext,
  buildResponseJsonSchema,
} from "@/lib/ai/prompt-builder";
import { processWithAI } from "@/lib/ai/openai-client";
import type { ConversationTurn } from "@/lib/ai/openai-client";

const AGENT_ID = process.argv[2] || "e698f2b4-92bf-4c6a-9429-dc18ab94096b"; // default Marcos sales

async function main() {
  const supabase = createAdminClient();

  const { data: agent } = await supabase
    .from("agents")
    .select("*, agent_configs(*)")
    .eq("id", AGENT_ID)
    .single();
  if (!agent) { console.error("agent not found"); process.exit(1); }
  const config_ = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;
  console.log(`Agent ${agent.id} type=${agent.type} model=${config_.ai_model}`);

  const { data: location } = await supabase
    .from("locations")
    .select("*")
    .eq("location_id", agent.location_id)
    .single();
  console.log(`Location tz=${location?.timezone} company=${location?.company_id}`);

  const locationTz = location?.timezone || "America/New_York";
  const conversationTurns: ConversationTurn[] = [];
  const message = "quero saber mais sobre seguro de vida";

  const currentDateInTz = new Date().toLocaleDateString("en-US", {
    weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: locationTz,
  });
  const currentTimeInTz = new Date().toLocaleTimeString("en-US", {
    hour: "numeric", minute: "2-digit", hour12: true, timeZone: locationTz,
  });

  const { data: kbData } = await supabase
    .from("knowledge_base")
    .select("title, type, content, file_name, file_url, description, usage_instructions")
    .eq("agent_id", AGENT_ID)
    .order("created_at", { ascending: true });

  const promptCtx = {
    config: config_,
    agentType: agent.type as "sales_agent" | "recruitment_agent",
    contactName: "",
    collectedData: {},
    locationName: location?.location_name || "Minha Empresa",
    currentDate: `${currentDateInTz}, ${currentTimeInTz}`,
    timezone: locationTz,
    availableSlots: "",
    slotsUnavailable: false,
    knowledgeBase: kbData && kbData.length > 0 ? kbData : undefined,
    feedback: [],
    priorTurnCount: 0,
  };

  console.log("\n=== buildSystemPrompt ===");
  let systemPrompt = "";
  try {
    systemPrompt = buildSystemPrompt(promptCtx);
    console.log(`✓ systemPrompt length=${systemPrompt.length}`);
  } catch (err) {
    console.error("CRASH buildSystemPrompt:", err);
    if (err instanceof Error) console.error(err.stack);
    process.exit(1);
  }

  console.log("\n=== buildRuntimeContext ===");
  let runtimeContext = "";
  try {
    runtimeContext = buildRuntimeContext(promptCtx);
    console.log(`✓ runtimeContext length=${runtimeContext.length}`);
  } catch (err) {
    console.error("CRASH buildRuntimeContext:", err);
    if (err instanceof Error) console.error(err.stack);
    process.exit(1);
  }

  console.log("\n=== buildResponseJsonSchema ===");
  let responseSchema: unknown = null;
  try {
    responseSchema = buildResponseJsonSchema(promptCtx);
    console.log(`✓ responseSchema OK`);
  } catch (err) {
    console.error("CRASH buildResponseJsonSchema:", err);
    if (err instanceof Error) console.error(err.stack);
    process.exit(1);
  }

  console.log("\n=== processWithAI ===");
  const start = Date.now();
  try {
    const result = await processWithAI({
      systemPrompt,
      runtimeContext,
      conversationMessages: conversationTurns,
      conversationHistory: "",
      newMessages: message,
      model: config_.ai_model || "gpt-4.1-mini",
      responseSchema: responseSchema as Record<string, unknown>,
      priorTurnCount: 0,
    });
    const dur = Date.now() - start;
    console.log(`✓ Done in ${dur}ms`);
    console.log("Success:", result.success);
    console.log("Response message:", typeof result.response?.message === "string"
      ? result.response.message.slice(0, 200)
      : Array.isArray(result.response?.message) ? result.response.message.join("\n").slice(0, 200) : "n/a");
    console.log("Error:", result.error);
    console.log("Tokens:", result.prompt_tokens, "/", result.completion_tokens);
  } catch (err) {
    console.error("CRASH processWithAI:", err);
    if (err instanceof Error) console.error(err.stack);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
