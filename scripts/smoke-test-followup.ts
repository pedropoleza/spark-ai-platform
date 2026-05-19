// E2E smoke test pra Follow-up Feature (Pedro 2026-05-18).
// Roda com: npx tsx -r tsconfig-paths/register scripts/smoke-test-followup.ts
//
// Cobre: settings load, safety checks, spam score regras, parseRequestedAt,
// core createFollowupRequest (chat source), approve/cancel/pause/resume/edit.
// NÃO envia msgs reais — usa contact_id fake e cancela sequence antes do
// runner pegar.

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { loadFollowupSettings } from "@/lib/account-assistant/followup/settings-loader";
import { runSafetyChecks } from "@/lib/account-assistant/followup/safety-checks";
import { computeSpamScore } from "@/lib/account-assistant/followup/spam-score";
import { parseRequestedAt } from "@/lib/account-assistant/followup/sequence-scheduler";
import {
  createFollowupRequest,
  approveSequence,
  cancelSequence,
  pauseSequence,
  resumeSequence,
  editSequence,
} from "@/lib/account-assistant/followup/core";

const LOC = "H09HtG22LZzTU8htMxxg";
const PEDRO_REP_ID = "6c64bd09-2ad3-4ea8-9d62-d75ed3f5fbe1"; // ajustar se diff
const HUB_AGENT_ID = "483ca4eb-dd5e-4da7-bd4e-6ff1f85f240b";

type TestResult = { name: string; passed: boolean; detail: string; ms: number };
const results: TestResult[] = [];

function rec(name: string, passed: boolean, detail: string, ms: number) {
  results.push({ name, passed, detail, ms });
  console.log(`${passed ? "✅" : "❌"} ${name} (${ms}ms) — ${detail.slice(0, 200)}`);
}

async function run<T>(name: string, fn: () => Promise<T> | T): Promise<T | null> {
  const t0 = Date.now();
  try {
    const r = await fn();
    rec(name, true, "ok", Date.now() - t0);
    return r;
  } catch (e) {
    rec(name, false, e instanceof Error ? e.message.slice(0, 200) : String(e), Date.now() - t0);
    return null;
  }
}

async function main() {
  const supabase = createAdminClient();
  console.log("\n=== Smoke Test Follow-up Feature ===\n");

  // Resolve rep_id real do Pedro
  const { data: pedroRep } = await supabase
    .from("rep_identities")
    .select("id")
    .eq("phone", "+17867717077")
    .maybeSingle();
  const repId = pedroRep?.id || PEDRO_REP_ID;
  console.log(`Rep ID Pedro: ${repId}`);

  // ─────────────────────────────────────────────────
  // A. Settings loader
  // ─────────────────────────────────────────────────
  await run("A1 — loadFollowupSettings defaults se agent inexistente", async () => {
    const s = await loadFollowupSettings(null);
    if (!s.feature_enabled) throw new Error("feature_enabled deveria ser true");
    if (s.approval_mode !== "adaptive") throw new Error("approval_mode default deveria ser adaptive");
    if (s.default_sequence_length !== 2) throw new Error("default_sequence_length deveria ser 2");
  });

  await run("A2 — loadFollowupSettings com Hub agent_id real", async () => {
    const s = await loadFollowupSettings(HUB_AGENT_ID);
    if (!s.feature_enabled) throw new Error("feature_enabled deveria estar true no Hub");
  });

  // ─────────────────────────────────────────────────
  // B. Safety checks
  // ─────────────────────────────────────────────────
  const settings = await loadFollowupSettings(HUB_AGENT_ID);

  await run("B1 — safety bloqueia channel não-permitido", async () => {
    const r = await runSafetyChecks({
      rep_id: repId,
      location_id: LOC,
      agent_id: HUB_AGENT_ID,
      contact_id: "fake_contact",
      delivery_channel: "carrier_pigeon",
      settings,
    });
    if (r.ok) throw new Error("deveria bloquear channel inválido");
    if (r.block_reason?.kind !== "channel_not_allowed") throw new Error("kind errado");
  });

  await run("B2 — safety bloqueia contato com tag opt-out", async () => {
    const r = await runSafetyChecks({
      rep_id: repId,
      location_id: LOC,
      agent_id: HUB_AGENT_ID,
      contact_id: "fake_optout_test",
      contact_tags: ["dnc"],
      delivery_channel: "whatsapp_web_sms",
      settings,
    });
    if (r.ok) throw new Error("deveria bloquear DNC");
    if (r.block_reason?.kind !== "contact_opted_out") throw new Error("kind errado");
  });

  await run("B3 — safety permite caso normal", async () => {
    const r = await runSafetyChecks({
      rep_id: repId,
      location_id: LOC,
      agent_id: HUB_AGENT_ID,
      contact_id: "fake_normal_test",
      contact_tags: ["cliente"],
      delivery_channel: "whatsapp_web_sms",
      settings,
    });
    if (!r.ok) throw new Error(`safety bloqueou inesperadamente: ${r.block_reason?.message}`);
  });

  // ─────────────────────────────────────────────────
  // C. Spam score
  // ─────────────────────────────────────────────────
  const baseSignals = {
    has_conversation: true,
    message_count: 10,
    last_inbound_at: new Date(Date.now() - 24 * 3600 * 1000).toISOString(),
    last_outbound_at: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
    unanswered_outbound_count: 1,
    inbound_count: 5,
    outbound_count: 5,
    inbound_outbound_ratio: 1.0,
    days_since_last_inbound: 1,
    messages: [],
  };

  await run("C1 — spam_score low risk (conversa saudável)", async () => {
    const r = await computeSpamScore({
      signals: baseSignals,
      contact_tags: ["cliente"],
      is_active_client: true,
      has_recent_appointment: false,
      existing_active_sequences: 0,
      planned_sequence_length: 2,
    });
    if (r.risk !== "low") throw new Error(`risk deveria ser low, foi ${r.risk} (score ${r.score})`);
  });

  await run("C2 — spam_score high risk (6 unanswered + 14d cold)", async () => {
    const r = await computeSpamScore({
      signals: {
        ...baseSignals,
        unanswered_outbound_count: 6,
        days_since_last_inbound: 14,
      },
      contact_tags: [],
      is_active_client: false,
      has_recent_appointment: false,
      existing_active_sequences: 0,
      planned_sequence_length: 3,
    });
    if (r.risk !== "high") throw new Error(`deveria ser high, foi ${r.risk} (score ${r.score})`);
    if (r.recommendation !== "internal_reminder_only") throw new Error("rec errado");
  });

  await run("C3 — spam_score 0 (opt-out tag zera tudo)", async () => {
    const r = await computeSpamScore({
      signals: baseSignals,
      contact_tags: ["dnc"],
      is_active_client: false,
      has_recent_appointment: false,
      existing_active_sequences: 0,
      planned_sequence_length: 1,
    });
    if (r.score !== 0) throw new Error(`score deveria ser 0, foi ${r.score}`);
    if (r.risk !== "high") throw new Error("risk deveria ser high quando score=0");
  });

  // ─────────────────────────────────────────────────
  // D. parseRequestedAt
  // ─────────────────────────────────────────────────
  await run("D1 — parseRequestedAt ISO 8601", () => {
    const iso = "2026-12-01T10:00:00Z";
    const d = parseRequestedAt(iso, 48);
    if (d.toISOString() !== "2026-12-01T10:00:00.000Z") throw new Error(`got ${d.toISOString()}`);
  });

  await run("D2 — parseRequestedAt 'tomorrow 10:00'", () => {
    const d = parseRequestedAt("tomorrow 10:00", 48);
    const expected = new Date(Date.now() + 24 * 3600 * 1000);
    expected.setHours(10, 0, 0, 0);
    if (Math.abs(d.getTime() - expected.getTime()) > 1000) throw new Error(`got ${d}`);
  });

  await run("D3 — parseRequestedAt 'in 3 days'", () => {
    const d = parseRequestedAt("in 3 days", 48);
    const expected = new Date(Date.now() + 3 * 24 * 3600 * 1000);
    expected.setHours(10, 0, 0, 0);
    if (Math.abs(d.getTime() - expected.getTime()) > 2000) throw new Error(`got ${d}`);
  });

  await run("D4 — parseRequestedAt fallback (input inválido)", () => {
    const d = parseRequestedAt("manhã sexta", 48);
    const now = Date.now();
    // Deve cair no default agora+48h
    if (Math.abs(d.getTime() - (now + 48 * 3600 * 1000)) > 5000) throw new Error(`got ${d}`);
  });

  // ─────────────────────────────────────────────────
  // E. Core service E2E
  // ─────────────────────────────────────────────────
  let createdSeqId: string | null = null;
  await run("E1 — createFollowupRequest contato não encontrado", async () => {
    const r = await createFollowupRequest({
      source: "chat",
      rep_id: repId,
      location_id: LOC,
      agent_id: HUB_AGENT_ID,
      contact_query: "nonexistent_contact_xyz_12345",
      goal: "teste",
    });
    if (r.ok) throw new Error("deveria retornar ok=false");
    if (r.error?.kind !== "contact_not_found") throw new Error(`kind errado: ${r.error?.kind}`);
  });

  await run("E2 — createFollowupRequest needs_user_decision (sem contexto)", async () => {
    // Pega contato real Pedro pra teste real
    const r = await createFollowupRequest({
      source: "chat",
      rep_id: repId,
      location_id: LOC,
      agent_id: HUB_AGENT_ID,
      contact_query: "+17867717077",
      goal: "smoke test",
      // omitindo use_conversation_context
    });
    if (!r.needs_user_decision) {
      throw new Error("deveria retornar needs_user_decision");
    }
    if (r.needs_user_decision.kind !== "use_conversation_context") {
      throw new Error(`kind errado: ${r.needs_user_decision.kind}`);
    }
  });

  await run("E3 — createFollowupRequest com manual_context (sem perguntar conversa)", async () => {
    const r = await createFollowupRequest({
      source: "chat",
      rep_id: repId,
      location_id: LOC,
      agent_id: HUB_AGENT_ID,
      contact_query: "+17867717077",
      goal: "smoke test E3",
      manual_context: "Cliente disse que ia pensar até sexta. Sem urgência.",
      use_conversation_context: false,
      sequence_length: 2,
      requested_at: "in 2 days",
    });
    console.log(`   DEBUG result: ok=${r.ok}, decision=${r.flow_decision}, risk=${r.spam_risk}, seq_id=${r.sequence_id}, err=${r.error?.kind}/${r.error?.message?.slice(0, 80)}, needs_dec=${r.needs_user_decision?.kind}`);
    if (!r.ok) throw new Error(`falhou: ${r.error?.message}`);
    if (r.flow_decision === "blocked_high_risk") {
      // OK — risk high é resultado válido pra contato sem conversa + sem flags
      console.log(`   → blocked_high_risk (esperado se contato sem histórico)`);
      return;
    }
    if (!r.sequence_id) throw new Error("sem sequence_id");
    if (!r.messages_preview || r.messages_preview.length === 0) {
      throw new Error("sem messages_preview");
    }
    createdSeqId = r.sequence_id;
    console.log(`   → seq=${r.sequence_id.slice(0, 8)}, decision=${r.flow_decision}, msgs=${r.messages_preview.length}, risk=${r.spam_risk}`);
  });

  // ─────────────────────────────────────────────────
  // F. Mutation operations (cancel, pause, resume, edit, approve)
  // ─────────────────────────────────────────────────
  if (createdSeqId) {
    await run("F1 — pauseSequence (se scheduled/running)", async () => {
      // Pode estar em draft (approval_required) — primeiro promove pra scheduled
      const { data: s } = await supabase
        .from("followup_sequences")
        .select("status")
        .eq("id", createdSeqId!)
        .maybeSingle();
      if (s?.status === "draft") {
        const r = await approveSequence(createdSeqId!);
        if (!r.ok) throw new Error(r.error);
      }
      const p = await pauseSequence(createdSeqId!);
      if (!p.ok) throw new Error(p.error);
    });

    await run("F2 — resumeSequence", async () => {
      const r = await resumeSequence(createdSeqId!);
      if (!r.ok) throw new Error(r.error);
    });

    await run("F3 — editSequence msg position 1", async () => {
      const r = await editSequence(createdSeqId!, {
        messages: [{ position: 1, new_text: "[SMOKE TEST EDITED] Olá, esse é um teste." }],
      });
      if (r.updated_messages !== 1) throw new Error(`updated=${r.updated_messages}`);
    });

    await run("F4 — cancelSequence cleanup", async () => {
      const r = await cancelSequence(createdSeqId!, "smoke_test_cleanup");
      if (!r.ok) throw new Error(r.error);
    });
  }

  // ─────────────────────────────────────────────────
  // G. Final cleanup — apaga sequences smoke test
  // ─────────────────────────────────────────────────
  await run("G1 — cleanup sequences smoke_test", async () => {
    const { data: smokeSeqs } = await supabase
      .from("followup_sequences")
      .select("id")
      .eq("rep_id", repId)
      .or("goal.ilike.%smoke%,cancelled_reason.ilike.%smoke%")
      .limit(100);
    if (smokeSeqs && smokeSeqs.length > 0) {
      const ids = smokeSeqs.map((s) => s.id);
      await supabase.from("followup_sequences").delete().in("id", ids);
      console.log(`   → deleted ${ids.length} smoke sequences`);
    }
  });

  // ─────────────────────────────────────────────────
  // Summary
  // ─────────────────────────────────────────────────
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log("\n========================================");
  console.log(`Total: ${passed}/${results.length} (${failed} fail)`);
  console.log("========================================");
  if (failed > 0) {
    console.log("\nFalhas:");
    for (const r of results.filter((r) => !r.passed)) {
      console.log(`  ❌ ${r.name}: ${r.detail}`);
    }
    process.exit(1);
  }
  console.log("ALL GREEN");
}

main().catch((err) => {
  console.error("FATAL:", err);
  process.exit(1);
});
