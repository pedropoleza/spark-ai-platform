/**
 * Teste do Motor de Orquestração de Tarefas — F1 (montagem honesta).
 * Pedro 2026-06-20. Plano: _planning/jussara-sparkbot/EXECUCAO.md.
 *
 * Cobre: helpers puros (validação) + buildSnapshot + round-trip no DB (rep
 * descartável). Prova que o estado vem do DB (não da memória) e que mutação
 * inválida NÃO altera o estado.
 *
 * Uso: npx tsx -r tsconfig-paths/register scripts/test-task-orchestrator.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { isValidSendTime, isValidOffsetDays } from "../src/lib/account-assistant/task-orchestrator/config";
import { buildSnapshot } from "../src/lib/account-assistant/task-orchestrator/core";
import * as core from "../src/lib/account-assistant/task-orchestrator/core";
import { materializeDraft, getDraftProgress, computeScheduledAt } from "../src/lib/account-assistant/task-orchestrator/materializer";
import { renderFlowPdf, sanitizeForPdf } from "../src/lib/account-assistant/task-orchestrator/flow-pdf";
import { sendMediaToContact } from "../src/lib/ghl/operations";
import type { DraftWithSteps } from "../src/lib/account-assistant/task-orchestrator/types";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

function fakeStep(over: Partial<DraftWithSteps["steps"][number]>): DraftWithSteps["steps"][number] {
  return {
    id: "x", draft_id: "d", position: 1, offset_days: 0, send_time: null, intra_day_delay_s: 0,
    message_text: "oi", media_url: null, media_type: null, send_condition: null,
    created_at: "", updated_at: "", ...over,
  };
}

async function main() {
  console.log("\n=== Helpers puros ===");
  check("send_time '09:30' válido", isValidSendTime("09:30"));
  check("send_time '24:00' inválido", !isValidSendTime("24:00"));
  check("send_time '9h' inválido", !isValidSendTime("9h"));
  check("offset_days 0 válido", isValidOffsetDays(0));
  check("offset_days -1 inválido", !isValidOffsetDays(-1));
  check("offset_days 2.5 inválido", !isValidOffsetDays(2.5));
  check("offset_days 400 inválido", !isValidOffsetDays(400));

  console.log("\n=== buildSnapshot (mock) ===");
  const snap = buildSnapshot({
    draft: { id: "d1", rep_id: "r", location_id: "l", agent_id: null, kind: "followup_sequence",
      status: "building", title: "T", meta: {}, materialized_job_id: null, materialized_count: null,
      materialized_at: null, created_at: "", updated_at: "" },
    steps: [fakeStep({ offset_days: 0, message_text: "dia0" }), fakeStep({ offset_days: 2, message_text: "" , media_url: null })],
  });
  check("snapshot numera passos 1..N", snap.steps[0].n === 1 && snap.steps[1].n === 2);
  check("day_label correto", snap.steps[1].day_label === "Dia 2");
  check("whats_missing aponta alvo faltando", snap.whats_missing.some((w) => w.includes("ALVO")));
  check("whats_missing aponta passo sem conteúdo", snap.whats_missing.some((w) => w.includes("Passo 2")));

  console.log("\n=== F4: geração de PDF (render) ===");
  check("sanitizeForPdf mantém acento, remove emoji", sanitizeForPdf("Olá ção 😊🙏") === "Olá ção ");
  const pdfSnap = buildSnapshot({
    draft: { id: "d2", rep_id: "r", location_id: "l", agent_id: null, kind: "followup_sequence",
      status: "materialized", title: "Fluxo PDF ção", meta: { contact_name: "Eliz" }, materialized_job_id: null,
      materialized_count: 2, materialized_at: null, created_at: "", updated_at: "" },
    steps: [
      fakeStep({ offset_days: 0, message_text: "Oi [nome], tudo bem? 😊 " + "palavra ".repeat(60) }),
      fakeStep({ offset_days: 2, message_text: "Vídeo importante", media_url: "https://www.instagram.com/reel/" + "x".repeat(120) }),
    ],
  });
  const pdfBytes = await renderFlowPdf(pdfSnap);
  const header = String.fromCharCode(...pdfBytes.slice(0, 4));
  check("PDF começa com %PDF", header === "%PDF");
  check("PDF não-vazio (>800 bytes, multi-página/wrap)", pdfBytes.length > 800);

  console.log("\n=== F5: envio de mídia (payload shape, client falso) ===");
  let captured: { path?: string; body?: Record<string, unknown> } = {};
  const fakeClient = {
    post: async (path: string, body: Record<string, unknown>) => { captured = { path, body }; return { messageId: "fake-msg" }; },
  } as unknown as Parameters<typeof sendMediaToContact>[0];
  await sendMediaToContact(fakeClient, "ABCdef1234567890XYZ", "https://x.com/f.pdf", "Segue o PDF\nhttps://x.com/f.pdf", "SMS");
  check("POST em /conversations/messages", captured.path === "/conversations/messages");
  check("body com attachments:[url]", JSON.stringify((captured.body as { attachments?: string[] })?.attachments) === JSON.stringify(["https://x.com/f.pdf"]));
  check("type=SMS (Stevo→WhatsApp)", (captured.body as { type?: string })?.type === "SMS");
  check("caption (message) carrega o link de fallback", String((captured.body as { message?: string })?.message || "").includes("https://x.com/f.pdf"));

  // --- Integração no DB com rep descartável ---
  console.log("\n=== Integração DB (rep descartável) ===");
  const db = createAdminClient();
  const phone = "+19990000001";
  // limpa resto de execução anterior
  await db.from("rep_identities").delete().eq("phone", phone);
  const { data: rep, error: repErr } = await db
    .from("rep_identities")
    .insert({ phone, display_name: "TEST orchestrator", is_internal: true })
    .select("id")
    .single();
  if (repErr || !rep) { console.error("não criou rep de teste:", repErr?.message); process.exit(1); }
  const repId = rep.id as string;
  const LOC = "TEST_LOC";

  try {
    const s0 = await core.startDraft(repId, LOC, null, { title: "Fluxo teste" });
    check("startDraft ok", s0.ok && s0.snapshot.status === "building" && s0.snapshot.step_count === 0);

    const a1 = await core.addStep(repId, undefined, { offset_days: 2, message_text: "dia 2" });
    check("add dia 2 → 1 passo", a1.ok && a1.snapshot.step_count === 1);

    const a2 = await core.addStep(repId, undefined, { offset_days: 0, message_text: "dia 0" });
    // ordem canônica por offset_days → dia 0 vira passo 1
    check("add dia 0 → 2 passos, ordenado (dia0=passo1)", a2.ok && a2.snapshot.step_count === 2 && a2.snapshot.steps[0].offset_days === 0);

    const bad = await core.addStep(repId, undefined, { offset_days: -1, message_text: "x" });
    check("offset inválido rejeitado (ok:false)", !bad.ok);
    const stillTwo = await core.showDraft(repId, undefined);
    check("estado INALTERADO após mutação inválida (ainda 2)", stillTwo.ok && stillTwo.snapshot.step_count === 2);

    const empty = await core.addStep(repId, undefined, { offset_days: 1, message_text: "" });
    check("passo sem texto E sem mídia rejeitado", !empty.ok);

    const e1 = await core.editStep(repId, undefined, 1, { message_text: "dia 0 editado" });
    check("editStep passo 1 reflete", e1.ok && e1.snapshot.steps[0].message_text === "dia 0 editado");

    const eBad = await core.editStep(repId, undefined, 99, { message_text: "z" });
    check("editStep passo inexistente rejeitado", !eBad.ok);

    const m1 = await core.setMeta(repId, undefined, { target: { contact_id: "ABCdef1234567890XYZ", contact_name: "Eliz" } });
    check("setMeta alvo → whats_missing sem 'ALVO'", m1.ok && !m1.snapshot.whats_missing.some((w) => w.includes("ALVO")));

    const r1 = await core.removeStep(repId, undefined, 1);
    check("removeStep → 1 passo", r1.ok && r1.snapshot.step_count === 1);

    // show_draft bate com o DB (re-leitura independente)
    const { count } = await db.from("draft_steps").select("id", { count: "exact", head: true }).eq("draft_id", s0.ok ? s0.snapshot.draft_id : "");
    const sd = await core.showDraft(repId, undefined);
    check("show_draft === DB", sd.ok && sd.snapshot.step_count === (count ?? -1));

    // audit gravou eventos
    const draftId = s0.ok ? s0.snapshot.draft_id : "";
    const { count: ev } = await db.from("task_events").select("id", { count: "exact", head: true }).eq("draft_id", draftId);
    check("task_events append-only gravou", (ev ?? 0) >= 4);

    console.log("\n=== F2: materialização honesta ===");
    // scheduled_at tz-aware: Dia 2 às 07:30 SP deve cair ~07:30-03:00 = 10:30Z naquele dia
    const sched = computeScheduledAt(2, "07:30", "America/Sao_Paulo", new Date("2026-06-20T12:00:00Z"));
    check("computeScheduledAt Dia2 07:30 SP → 10:30Z", sched.toISOString().includes("T10:30"));

    // o draft tem 1 passo + alvo (contact_id setado no setMeta acima) → materializa
    const mat = await materializeDraft(repId, draftId, "America/Sao_Paulo");
    check("materializeDraft ok, count REAL = 1", mat.ok && mat.count === 1);
    const seqId = mat.ok ? mat.sequence_id : "";
    const { count: msgCount } = await db.from("followup_messages").select("id", { count: "exact", head: true }).eq("sequence_id", seqId);
    check("followup_messages tem 1 row (count===DB)", (msgCount ?? -1) === 1);
    const { data: seqRow } = await db.from("followup_sequences").select("status, total_messages").eq("id", seqId).maybeSingle();
    check("sequence status='scheduled' (runner pega)", seqRow?.status === "scheduled");

    // draft promovido a materialized com count real
    const { data: dRow } = await db.from("task_drafts").select("status, materialized_count").eq("id", draftId).maybeSingle();
    check("draft status='materialized' + count=1", dRow?.status === "materialized" && dRow?.materialized_count === 1);

    // NÃO materializa de novo (guard de status)
    const mat2 = await materializeDraft(repId, draftId, "America/Sao_Paulo");
    check("2ª materialização BLOQUEADA (não duplica)", !mat2.ok && mat2.count === 0);

    // progresso real vem do DB
    const prog = await getDraftProgress(draftId);
    check("get_task_progress: total=1 pending=1", prog.ok && prog.total === 1 && prog.pending === 1);

    // draft vazio → materialização recusada (honestidade: não diz 'agendado')
    const emptyDraft = await core.startDraft(repId, LOC, null, { kind: "campaign", title: "vazio" });
    const emptyId = emptyDraft.ok ? emptyDraft.snapshot.draft_id : "";
    const matEmpty = await materializeDraft(repId, emptyId, null);
    check("materializar fluxo VAZIO → erro, count 0", !matEmpty.ok && matEmpty.count === 0);
  } finally {
    // cleanup: deletar a rep cascateia draft/steps/events
    await db.from("rep_identities").delete().eq("id", repId);
    console.log("  (cleanup: rep de teste removida)");
  }

  console.log(`\n=== RESULTADO: ${pass} passou, ${fail} falhou ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
