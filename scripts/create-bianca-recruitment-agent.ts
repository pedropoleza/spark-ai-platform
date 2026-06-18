/**
 * Cria o agente de RECRUTAMENTO (tom RAPPORT, persona "Manu") na sub-account
 * da Bianca Amorim (location cRavIlyC52vFYgJATgi7) — espelhando o caminho
 * canônico do /api/agent-platform/agents (recruitment_agent + audience lead +
 * template_key recruitment + 7 module instances) e adicionando a config rica.
 *
 * Lê o prompt FINAL do output do workflow bianca-rapport-agent (sem retypar) e
 * troca {{PERSONA_NOME}} -> "Manu" (NÃO há interpolação de tokens no runtime,
 * verificado). Os links {{LINK_NATIONAL_LIFE}}/{{LINK_REUNIAO}} ficam como
 * placeholders flagueados (o prompt já tem guard de handoff se vierem vazios) —
 * quando o Pedro passar os reais, eu hardcodo no texto.
 *
 * NASCE INATIVO + targeting tag `maria-teste` + calendar_id vazio. NÃO fala com
 * nenhum lead. Concede o entitlement recruitment_agent pra location (pra quando
 * o Pedro ativar). Idempotente: se já existir recruitment_agent na location, só
 * atualiza a config.
 *
 *   npx tsx -r tsconfig-paths/register scripts/create-bianca-recruitment-agent.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync } from "fs";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import { grantEntitlement } from "@/lib/repositories/agent-platform.repo";

const LOCATION = "cRavIlyC52vFYgJATgi7"; // sub-account da Bianca (company TdmQMjj86Y3LgppiB96K)
const WF_OUTPUT =
  "/private/tmp/claude-501/-Users-pedropoleza-SPARK-APPS-AI-platform/39eeb6c6-538c-4fe1-b0f1-2c57bda9df98/tasks/wz45pq9nd.output";

function loadFinalPrompt(): string {
  const raw = readFileSync(WF_OUTPUT, "utf8");
  let obj: any;
  try {
    obj = JSON.parse(raw);
  } catch {
    const i = raw.indexOf("{");
    const j = raw.lastIndexOf("}");
    obj = JSON.parse(raw.slice(i, j + 1));
  }
  const f = obj?.result?.final?.finalPrompt || obj?.final?.finalPrompt;
  if (!f || typeof f !== "string") throw new Error("finalPrompt não encontrado no output do workflow");
  // Persona = ponto único de troca. Sem interpolação de token no runtime ->
  // troca literal por "Manu" (= conta real da Bianca). Colapsa o redundante.
  return f
    .replaceAll('{{PERSONA_NOME}} (use "Manu" como default)', "Manu")
    .replaceAll("{{PERSONA_NOME}}", "Manu");
}

const MODULES = ["qualification", "scheduling", "followup", "behavior", "channel", "knowledge", "compliance"];

const DATA_FIELDS = [
  { key: "state", type: "text", label: "Estado onde mora (EUA)", required: true },
  { key: "work_permit", type: "text", label: "Permissão de trabalho (work permit)", required: true },
  { key: "current_occupation", type: "text", label: "O que faz hoje", required: true },
  { key: "motivation", type: "text", label: "Motivação / o que chamou atenção no conteúdo da Bianca", required: true },
  // coletados no FECHAMENTO (booking) — required:false, não bloqueiam a qualificação
  { key: "email", type: "text", label: "Email (pro time confirmar/dar suporte)", required: false },
  { key: "whatsapp", type: "text", label: "WhatsApp (pro time dar o toque fora do IG)", required: false },
];

const FOLLOW_UP_CONFIG = {
  mode: "ai_auto",
  enabled: true,
  intensity: 7,
  manual_steps: [{ delay_minutes: 180 }, { delay_minutes: 600 }, { delay_minutes: 1080 }],
  max_attempts: 3,
  // tom RAPPORT + correção cross-canal (nunca promete lembrete por email/WhatsApp)
  custom_prompt:
    "Canal Instagram DM, janela 24h. Você está retomando um CANDIDATO que demonstrou interesse na carreira (NÃO é cliente). Mensagem curta e CALOROSA (<=280 chars), tom rapport/acolhedor, espelha a emoção e retoma o ASSUNTO exato onde parou. Emoji caloroso com naturalidade (🥰😊), nunca 🚀💰🔥, nunca 2 emojis iguais seguidos. NUNCA prometa renda/número. NÃO se apresente de novo. NÃO prometa lembrete por email/WhatsApp (o canal não entrega).",
  max_delay_minutes: 1380,
  min_delay_minutes: 10,
};

async function main() {
  const supabase = createAdminClient();
  const prompt = loadFinalPrompt();
  if (prompt.includes("{{PERSONA_NOME}}")) throw new Error("PERSONA_NOME não foi substituído");

  const configPayload: Record<string, unknown> = {
    personality: {
      name: "Manu",
      identity_mode: "human",
      language: "pt-BR",
      greeting_style: "Oi {name}, tudo bem? 🥰 Sou a Manu, da equipe da Bianca. Me conta, o que te chamou atenção no conteúdo dela?",
      farewell_style: "Tô por aqui sempre que quiser, no seu tempo 🙂",
      persona_description:
        "Recrutadora real do time da Bianca (se apresenta como Manu). Brasileira, mora nos EUA. Calorosa, próxima, escuta mais do que fala, espelha a emoção antes de propor. Vínculo primeiro, pitch depois.",
    },
    tone_creativity: 70,
    tone_formality: 20,
    tone_naturalness: 90,
    tone_aggressiveness: 45,
    specialist_name: "Bianca",
    specialist_role: "recrutadora",
    check_legal_docs: false,
    preferred_time_slot: "afternoon_evening",
    objective: "qualification_and_booking",
    calendar_id: "", // 👤 Andrea/Pedro passam o calendar da turma da Bianca
    targeting_rules: [{ id: "t1", type: "tag", tag: "maria-teste" }], // trava de teste
    enabled_channels: ["Instagram"],
    enable_audio_transcription: true,
    auto_pause_on_human_message: true,
    debounce_seconds: 10,
    max_messages_per_conversation: 50,
    timezone_config: { use_location_default: true, custom_timezone: "", confirm_before_booking: true, auto_detect_from_state: true },
    working_hours: { enabled: false, timezone: "America/New_York", mode: "only_during", schedule: {} },
    lead_history_config: { enabled: true, messages_count: 20, include_notes: true, include_opportunities: true, include_tags: true },
    handoff_policy: {
      enabled: true,
      skip_if_human_replied_within_minutes: 60,
      skip_if_lead_requested_human: true,
      notify_rep_via_sparkbot: true,
      notify_on_opp_stage_closed: true,
      custom_keywords_handoff: ["humano", "atendente", "pessoa", "falar com alguém", "quero falar com alguém", "real person", "alguém do time"],
    },
    follow_up_config: FOLLOW_UP_CONFIG,
    data_fields: DATA_FIELDS,
    custom_instructions: prompt,
  };

  // Idempotência: já existe recruitment_agent nesta location?
  const { data: existing } = await supabase
    .from("agents")
    .select("id, status")
    .eq("location_id", LOCATION)
    .eq("type", "recruitment_agent")
    .maybeSingle();

  let agentId: string;
  if (existing) {
    agentId = existing.id;
    const { error: ue } = await supabase.from("agent_configs").update(configPayload).eq("agent_id", agentId);
    if (ue) throw new Error("UPDATE config: " + ue.message);
    console.log(`↻ recruitment_agent já existia (${agentId}, status=${existing.status}) — config atualizada`);
  } else {
    const { data: agentRow, error: ae } = await supabase
      .from("agents")
      .insert({
        location_id: LOCATION,
        type: "recruitment_agent",
        template_key: "recruitment",
        audience: "lead",
        status: "inactive", // NÃO fala com ninguém até o Pedro ativar
        name: "Manu — Recrutamento Bianca [TESTE]",
      })
      .select("id")
      .single();
    if (ae || !agentRow) throw new Error("INSERT agent: " + (ae?.message || "sem id"));
    agentId = agentRow.id;

    const { error: ce } = await supabase.from("agent_configs").insert({ agent_id: agentId, ...configPayload });
    if (ce) throw new Error("INSERT config: " + ce.message);
    console.log(`✅ recruitment_agent criado (${agentId}) — INATIVO + tag maria-teste`);
  }

  // Module instances (espelha o wizard canônico) — upsert idempotente
  const rows = MODULES.map((module_key, i) => ({
    agent_id: agentId,
    module_key,
    module_version: 1,
    enabled: true,
    sort_order: (i + 1) * 10,
  }));
  // limpa e reinsere pra ficar idempotente
  await supabase.from("agent_module_instances").delete().eq("agent_id", agentId);
  const { error: me } = await supabase.from("agent_module_instances").insert(rows);
  if (me) console.warn("⚠️ module instances:", me.message);
  else console.log(`✅ ${rows.length} module instances: ${MODULES.join(", ")}`);

  // Entitlement (AGENT_ENTITLEMENTS_ENFORCED está ON em prod) — libera pra
  // quando o Pedro ativar. Não ativa o agente.
  try {
    const ent = await grantEntitlement({
      locationId: LOCATION,
      capability: "recruitment_agent",
      grantedBy: "claude-setup-bianca",
      expiresAt: null,
      notes: "Setup recrutamento Bianca (Manu) — 2026-06-18",
    });
    console.log(`✅ entitlement recruitment_agent liberado ($${ent.monthly_price_usd}/mês)`);
  } catch (e) {
    console.warn("⚠️ entitlement:", e instanceof Error ? e.message : e);
  }

  console.log(`\nDONE. Bianca recruitment_agent = ${agentId} | location ${LOCATION} | prompt ${prompt.length} chars`);
  process.exit(0);
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
