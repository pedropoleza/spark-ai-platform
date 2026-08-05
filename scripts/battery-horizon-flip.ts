/**
 * Bateria pré-ativação da Horizon (jA6u) — roda contra o CÓDIGO DE PROD (origin/main)
 * e a CONFIG REAL do banco. npx tsx scripts/battery-horizon-flip.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { writeFileSync } from "fs";
import { createClient } from "@supabase/supabase-js";
import { GHLClient } from "@/lib/ghl/client";
import { buildSystemPrompt } from "@/lib/ai/sales-prompt-builder";
import { pickTriggeredDataFieldRules } from "@/lib/ai/reaction-engine";
import { pickAgentActivatedRules } from "@/lib/queue/agent-activated-automation";
import { normalizeTargeting, checkContactMatchesTargeting } from "@/lib/queue/targeting";
import { matchTextOp } from "@/lib/account-assistant/filter-engine/text-ops";
import type { AutomationRule, TargetingRules } from "@/types/agent";

const AGENT_ID = "7c0a72b7-e37c-463d-be56-73b7822a3037";
const LOC = "jA6uzx6tONyTeocxw4Cj";
const COMPANY = "TdmQMjj86Y3LgppiB96K";
const SCRATCH =
  "/private/tmp/claude-501/-Users-pedropoleza-SPARK-APPS-AI-platform/fb444e91-ba75-4ad5-a50e-6fe4e65495be/scratchpad";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

async function main() {
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
  const { data: agent } = await supabase
    .from("agents")
    .select("*, agent_configs(*)")
    .eq("id", AGENT_ID)
    .single();
  if (!agent) throw new Error("agente não encontrado");
  const cfg = Array.isArray(agent.agent_configs) ? agent.agent_configs[0] : agent.agent_configs;

  // ─── 1. PROMPT REAL (buildSystemPrompt de prod) ───
  console.log("\n1️⃣  Prompt real (buildSystemPrompt origin/main)");
  const prompt = buildSystemPrompt({
    config: cfg,
    agentType: agent.type,
    contactName: "Fernanda",
    collectedData: {},
    locationName: "Horizon",
    currentDate: new Date().toLocaleDateString("en-US"),
    timezone: "America/New_York",
    availableSlots: "",
    cacheOptimized: true, // LEAD_CACHE_OPTIMIZED=1 em prod
  } as Parameters<typeof buildSystemPrompt>[0]);
  writeFileSync(`${SCRATCH}/horizon-prompt-v4.txt`, prompt);
  const has = (s: string) => prompt.includes(s);
  check("seção ABERTURA DO ATENDIMENTO presente", has("ABERTURA DO ATENDIMENTO"));
  check("um dado por vez presente", has("UM DADO POR VEZ"));
  check("data por extenso (mês, dia e ano)", has("mês, dia e ano"));
  check("janela mínima de 1 hora presente", has("JANELA MÍNIMA DE 1 HORA"));
  check("compliance presente", has("COMPLIANCE DE SEGURO"));
  check("aviso do áudio presente (🎧)", has("audiozinho explicando direitinho 🎧"));
  check("era workflow-first REMOVIDA (sem 'REGRA DE OURO')", !has("REGRA DE OURO"));
  check("era workflow-first REMOVIDA (sem 'LEAD DE ANÚNCIO —')", !has("LEAD DE ANÚNCIO (mensagem automática"));
  check("sem 'A equipe já envia' (welcome antigo)", !has("A equipe já envia ao cliente um áudio"));
  check("identity/booking sections preservadas (HIGH-7)", has("JSON") && prompt.length > 6000);
  console.log(`     (prompt: ${prompt.length} chars → ${SCRATCH}/horizon-prompt-v4.txt)`);

  // ─── 2. AUTOMATIONS (funções reais) ───
  console.log("\n2️⃣  Automations (pick* reais de prod)");
  const rules = cfg.automations as AutomationRule[];
  const act = pickAgentActivatedRules(rules, new Set());
  check("agent_activated → 1 regra (áudio de abertura)", act.length === 1 && act[0].id === "abertura-audio");
  check(
    "ação = send_media com a mídia certa",
    act[0]?.actions?.[0]?.type === "send_media" && act[0]?.actions?.[0]?.media_id === "bf9fb113-e6a0-43db-8527-0d705396b0a6",
  );
  check("dedup: já disparada → não re-dispara", pickAgentActivatedRules(rules, new Set(["abertura-audio"])).length === 0);
  const dataFired = pickTriggeredDataFieldRules(rules, {}, { "contact.dateOfBirth": "05/21/1990" }, new Set());
  check("1º dado (dateOfBirth) → funil-em-contato", dataFired.length === 1 && dataFired[0].id === "funil-em-contato");
  check(
    "em-contato aponta pro stage In Contact",
    dataFired[0]?.actions?.[0]?.stage_id === "144fb041-296c-4b4b-8f04-a8f28bd67d58",
  );
  // réplica exata do filtro de evento do queue-processor (1681-1685)
  const evFilter = (finalStatus: string) =>
    rules.filter(
      (r) =>
        (!r.trigger || r.trigger.kind === "event") &&
        (r.trigger?.kind === "event" ? r.trigger.event : r.event) === finalStatus,
    );
  check("qualified → funil-qualified (stage Qualified)", evFilter("qualified")[0]?.actions?.[0]?.stage_id === "ba0e215d-5f4f-4beb-87ef-83b0254e315e");
  check("booked → funil-booked (First Meeting Booked)", evFilter("booked")[0]?.actions?.[0]?.stage_id === "310f75bc-375c-4c53-bb74-efd216477066");
  check("nenhuma regra órfã com kind desconhecido", rules.every((r) => !r.trigger || ["event", "on_data_field_set", "agent_activated"].includes(r.trigger.kind)));

  // ─── 3. MÍDIA (bucket + URL assinada + bytes) ───
  console.log("\n3️⃣  Áudio de abertura");
  const { data: media } = await supabase
    .from("media_library")
    .select("storage_path, mime_type, size_bytes, agent_id")
    .eq("id", "bf9fb113-e6a0-43db-8527-0d705396b0a6")
    .single();
  check("media_library row do agente certo", media?.agent_id === AGENT_ID);
  const signed = await supabase.storage.from("agent-media").createSignedUrl(media!.storage_path, 600);
  check("URL assinada gera", !!signed.data?.signedUrl);
  const resp = await fetch(signed.data!.signedUrl);
  const buf = await resp.arrayBuffer();
  check("download 200 + bytes batem", resp.ok && buf.byteLength === Number(media!.size_bytes), `status=${resp.status} bytes=${buf.byteLength}`);
  check("extensão .ogg na URL (classifica como áudio no gateway)", (signed.data!.signedUrl.split("?")[0] || "").endsWith(".ogg"));

  // ─── 4. CALENDÁRIO (buffer 1h) ───
  console.log("\n4️⃣  Calendário — janela mínima");
  const client = new GHLClient(COMPANY, LOC);
  const cal = await client.get<{ calendar?: Record<string, unknown> }>(`/calendars/14aj8DKXZnaj8GRMdmDy`);
  const c = (cal.calendar ?? cal) as Record<string, unknown>;
  check("allowBookingAfter = 1 hour", c.allowBookingAfter === 1 && c.allowBookingAfterUnit === "hours", JSON.stringify([c.allowBookingAfter, c.allowBookingAfterUnit]));

  // ─── 5. TARGETING (matcher real + gate real fim-a-fim) ───
  console.log("\n5️⃣  Targeting");
  const tgt = cfg.targeting_rules as TargetingRules;
  check("normaliza (set v2 válido)", !!normalizeTargeting(tgt));
  const frases = [
    "Olá! Vim pelo Matheus e gostaria de saber mais sobre benefício em  Vida. Pode me explicar  como funciona?",
    "Video do Matheus",
    "Quero entender como funciona o seguro com benefício em vida.",
    "Quero organizar meu futuro financeiro nos EUA.",
    "Quero saber como proteger minha família aqui nos EUA.",
    "Olá! Tenho interesse e queria mais informações",
    "Eu gostaria de saber mais sobre Seguro de Vida com benefícios em vida.",
    '📢 Veio de anúncio (instagram): "Márcia"\nhttps://x.com/1\n\noi',
  ];
  const needles = (tgt as { groups: Array<{ rules: Array<{ message_values?: string[] }> }> }).groups[0].rules[0].message_values!;
  for (const f of frases) check(`frase ativa: "${f.slice(0, 45)}…"`, matchTextOp("in", f, needles, { caseSensitive: false }));
  for (const n of ["Oi, tudo bem?", "Paguei", "Obrigada!", "Pode ser às 9"])
    check(`não ativa: "${n}"`, !matchTextOp("in", n, needles, { caseSensitive: false }));
  // fim-a-fim pelo gate real (grupo só-message não faz fetch GHL)
  const gate = await checkContactMatchesTargeting("contato-fake", tgt, COMPANY, LOC, {
    messageText: frases[0],
    isProactive: false,
    conversationActive: false,
  });
  check("checkContactMatchesTargeting (gate real) → match", gate.ok === true, JSON.stringify(gate));
  const gateNo = await checkContactMatchesTargeting("contato-fake", tgt, COMPANY, LOC, {
    messageText: "Oi, tudo bem?",
    isProactive: false,
    conversationActive: false,
  });
  // contato-fake não existe no GHL → leaf de tag falha o fetch → fail-open pode dar match. Só reporta.
  console.log(`     (gate com msg neutra: ${JSON.stringify(gateNo)} — leaf de tag em contato inexistente é fail-open, esperado)`);

  // ─── 6. FOLLOW-UP (cadência com a fórmula de prod) ───
  console.log("\n6️⃣  Follow-up — cadência");
  const fu = cfg.follow_up_config as { min_delay_minutes: number; max_delay_minutes: number; intensity: number; max_attempts: number; enabled: boolean; custom_prompt?: string };
  check("enabled, 3 toques", fu.enabled === true && fu.max_attempts === 3);
  // réplica exata de calculateCumulativeDelay (follow-up-scheduler.ts:196-215 de origin/main)
  const cumDelay = (attempt: number) => {
    const minDelay = Math.max(fu.min_delay_minutes || 60, 60);
    const maxDelay = fu.max_delay_minutes || 10080;
    const exponent = 0.3 + ((10 - fu.intensity) / 9) * 2.7;
    const t = (attempt - 1) / (fu.max_attempts - 1);
    return Math.round(minDelay + (maxDelay - minDelay) * Math.pow(t, exponent));
  };
  const [d1, d2, d3] = [cumDelay(1), cumDelay(2), cumDelay(3)];
  console.log(`     toques em: ${(d1 / 60).toFixed(1)}h · ${(d2 / 60).toFixed(1)}h · ${(d3 / 1440).toFixed(1)}d`);
  check("1º toque = 1h", d1 === 60);
  check("2º toque ≈ 24-32h", d2 >= 1440 && d2 <= 1920, `${(d2 / 60).toFixed(1)}h`);
  check("3º toque = 7d", d3 === 10080);
  check("custom_prompt curto e com [[NAO_ENVIAR]]", !!fu.custom_prompt && fu.custom_prompt.includes("NAO_ENVIAR") && fu.custom_prompt.includes("adiantar sua cotação"));

  // ─── 7. ESTADO DA CONTA (pré-flip) ───
  console.log("\n7️⃣  Estado pré-ativação");
  check("agente ainda inactive (ativação é o último passo)", agent.status === "inactive");
  check("suppress_ad_context_turn = false (IA-first)", cfg.suppress_ad_context_turn === false);
  check("lead_history ON", cfg.lead_history_config?.enabled === true);
  check("activation_mode trigger_once", cfg.activation_mode === "trigger_once");
  const { data: wal } = await supabase.from("locations").select("wallet_blocked_at").eq("location_id", LOC).single();
  check("wallet não bloqueada", !wal?.wallet_blocked_at);
  const { count: pendFu } = await supabase
    .from("scheduled_followups")
    .select("id", { count: "exact", head: true })
    .eq("agent_id", AGENT_ID)
    .eq("status", "pending");
  console.log(`     follow-ups pendentes da era antiga: ${pendFu ?? 0}`);
  check("sem backlog de follow-up da era antiga (ou pequeno)", (pendFu ?? 0) <= 50, String(pendFu));

  console.log(`\n═══ ${pass}/${pass + fail} ${fail ? "— FALHAS ACIMA" : "— TUDO VERDE"} ═══`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error("ERRO:", e);
  process.exit(1);
});
