/**
 * Aplica os custom_instructions reescritos (review 2026-06-17) nas 2 IAs de
 * recrutamento: UPDATE na Marina (agente de teste existente) + cria a Bianca
 * test-ready (inativa + escopada no tag maria-teste, tom rapport). Lê os prompts
 * do output do workflow (sem retypar). Ambas ficam prontas pro Test chat do Hub.
 *   npx tsx -r tsconfig-paths/register scripts/apply-marina-bianca-prompts.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
import { readFileSync } from "fs";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const OUTPUT = "/private/tmp/claude-501/-Users-pedropoleza-SPARK-APPS-AI-platform/39eeb6c6-538c-4fe1-b0f1-2c57bda9df98/tasks/who3ypxr3.output";
const MARINA_AGENT = "3976b4b6-0345-4f25-b964-138bb7960058";
const LOCATION = "A62s5EQj1hldOuvBEowv"; // conta da Marina/Bianca (mesma company)

async function main() {
  const o = JSON.parse(readFileSync(OUTPUT, "utf8"));
  const marina: string = o.result.marina;
  const bianca: string = o.result.bianca;
  if (!marina || !bianca) throw new Error("prompts não encontrados no output");
  const supabase = createAdminClient();

  // 1) UPDATE Marina
  const { error: uerr } = await supabase
    .from("agent_configs")
    .update({ custom_instructions: marina })
    .eq("agent_id", MARINA_AGENT);
  if (uerr) throw new Error("UPDATE Marina: " + uerr.message);
  console.log(`✅ Marina atualizada (custom_instructions ${marina.length} chars)`);

  // 2) Cria a Bianca (inativa + escopada), se ainda não existe
  const { data: existing } = await supabase
    .from("agents")
    .select("id")
    .eq("location_id", LOCATION)
    .ilike("name", "%Bianca%TESTE%")
    .maybeSingle();

  let biancaId: string;
  if (existing) {
    biancaId = existing.id;
    const { error: be } = await supabase
      .from("agent_configs")
      .update({ custom_instructions: bianca })
      .eq("agent_id", biancaId);
    if (be) throw new Error("UPDATE Bianca: " + be.message);
    console.log(`✅ Bianca já existia (${biancaId}) — custom_instructions atualizado`);
  } else {
    const { data: agentRow, error: aerr } = await supabase
      .from("agents")
      .insert({
        // custom_agent (não recruitment_agent) porque a constraint
        // agents_location_type_noncustom_uniq só deixa 1 recruitment por
        // location e a Marina já ocupa A62s5. Custom é isento; pro teste o
        // framing custom roda em cima do custom_instructions (design completo).
        // A Bianca REAL vai como recruitment_agent na sub-account dela.
        location_id: LOCATION,
        type: "custom_agent",
        template_key: "custom",
        status: "inactive",
        name: "Maria — Recrutamento Bianca [TESTE-custom]",
        audience: "lead",
      })
      .select("id")
      .single();
    if (aerr || !agentRow) throw new Error("INSERT agente Bianca: " + (aerr?.message || "sem id"));
    biancaId = agentRow.id;

    const { error: cerr } = await supabase.from("agent_configs").insert({
      agent_id: biancaId,
      personality: {
        name: "Maria",
        identity_mode: "human",
        language: "pt-BR",
        greeting_style: "Oi {name}, tudo bem? 😊 Vi que você comentou no anúncio — me conta, o que te chamou atenção nele?",
        farewell_style: "Tô aqui sempre que precisar, no seu tempo.",
        persona_description: "Recrutadora real do time da Bianca. Brasileira, mora nos EUA. Calorosa, próxima, escuta mais do que fala, espelha a emoção antes de propor. Já passou pela mesma virada de carreira.",
      },
      tone_creativity: 70,
      tone_formality: 20,
      tone_naturalness: 90,
      tone_aggressiveness: 45,
      specialist_name: "Bianca",
      specialist_role: "recrutadora",
      check_legal_docs: false,
      preferred_time_slot: "afternoon_evening",
      objective: "qualification_only",
      calendar_id: "",
      targeting_rules: [{ id: "t1", type: "tag", tag: "maria-teste" }],
      enabled_channels: ["Instagram"],
      enable_audio_transcription: true,
      auto_pause_on_human_message: true,
      debounce_seconds: 10,
      max_messages_per_conversation: 50,
      timezone_config: { use_location_default: true, custom_timezone: "", confirm_before_booking: true, auto_detect_from_state: true },
      working_hours: { enabled: false, timezone: "America/New_York", mode: "only_during", schedule: {} },
      lead_history_config: { enabled: true, messages_count: 20, include_notes: true, include_opportunities: true, include_tags: true },
      handoff_policy: {
        enabled: true, skip_if_human_replied_within_minutes: 60, skip_if_lead_requested_human: true,
        notify_rep_via_sparkbot: true, notify_on_opp_stage_closed: true,
        custom_keywords_handoff: ["humano", "atendente", "pessoa", "falar com alguém", "quero falar com alguém", "real person", "alguém do time"],
      },
      follow_up_config: { enabled: false },
      data_fields: [
        { key: "state", type: "text", label: "Estado onde mora (EUA)", required: true },
        { key: "work_permit", type: "text", label: "Permissão de trabalho (work permit)", required: true },
        { key: "current_occupation", type: "text", label: "O que faz hoje", required: true },
        { key: "motivation", type: "text", label: "Motivação / o que chamou atenção no anúncio", required: true },
      ],
      custom_instructions: bianca,
    });
    if (cerr) throw new Error("INSERT config Bianca: " + cerr.message);
    console.log(`✅ Bianca criada (${biancaId}) — inativa + tag maria-teste, custom_instructions ${bianca.length} chars`);
  }

  console.log("\nDONE. Marina:", MARINA_AGENT, "| Bianca:", biancaId);
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
