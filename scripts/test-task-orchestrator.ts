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
import { interpolateContactName, firstNameOf, hasNamePlaceholder } from "../src/lib/account-assistant/task-orchestrator/interpolate";
import { rankSavedFlows } from "../src/lib/account-assistant/task-orchestrator/flow-resolver";
import { markFlowSaved, listSavedFlows, type SavedFlowRow } from "../src/lib/repositories/task-drafts.repo";
import { buildSnapshot } from "../src/lib/account-assistant/task-orchestrator/core";
import * as core from "../src/lib/account-assistant/task-orchestrator/core";
import { materializeDraft, getDraftProgress, computeScheduledAt, applyFlowToContacts } from "../src/lib/account-assistant/task-orchestrator/materializer";
import { renderFlowPdf, sanitizeForPdf } from "../src/lib/account-assistant/task-orchestrator/flow-pdf";
import { sendMediaToContact } from "../src/lib/ghl/operations";
import { TASK_ORCHESTRATOR_TOOLS } from "../src/lib/account-assistant/tools/task-orchestrator";
import type { ToolContext } from "../src/lib/account-assistant/tools/types";
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

  console.log("\n=== Interpolação de [nome] (Fix caso Jussara 2026-06-29) ===");
  check("firstNameOf pega 1º nome", firstNameOf("Matheus Albuquerque") === "Matheus");
  check("firstNameOf vazio → ''", firstNameOf(null) === "" && firstNameOf("  ") === "");
  check("[nome] vira primeiro nome", interpolateContactName("Oi [nome], tudo bem?", "Matheus Albuquerque") === "Oi Matheus, tudo bem?");
  check("{nome} também", interpolateContactName("Oi {nome}!", "Lunna") === "Oi Lunna!");
  check("{first_name} / {primeiro_nome} também", interpolateContactName("{first_name} e {primeiro_nome}", "Ana Paula") === "Ana e Ana");
  check("case-insensitive [NOME]", interpolateContactName("Oi [NOME]", "Bia") === "Oi Bia");
  check("sem placeholder → inalterado", interpolateContactName("Oi, tudo bem?", "Bia") === "Oi, tudo bem?");
  check("idempotente (texto já interpolado)", interpolateContactName("Oi Matheus, tudo bem?", "Matheus") === "Oi Matheus, tudo bem?");
  check("sem nome → remove placeholder + limpa pontuação", interpolateContactName("Oi, [nome]?", null) === "Oi?");
  check("sem nome no meio → limpa", interpolateContactName("Olá [nome], bem-vindo!", "") === "Olá, bem-vindo!");
  check("NÃO toca em {tags[0]} / {custom.slug}", interpolateContactName("seu {custom.cidade} e {tags[0]}", "Bia") === "seu {custom.cidade} e {tags[0]}");
  check("hasNamePlaceholder detecta", hasNamePlaceholder("Oi [nome]") && !hasNamePlaceholder("Oi Bia"));
  check("hasNamePlaceholder é stateless (2x seguidas)", hasNamePlaceholder("Oi [nome]") && hasNamePlaceholder("Oi [nome]"));

  console.log("\n=== F7: resolver de fluxo salvo (rankSavedFlows, puro) ===");
  const mkFlow = (title: string, steps = 3): SavedFlowRow => ({ draft_id: title.toLowerCase().replace(/\s+/g, "-"), title, step_count: steps, saved_at: "", created_at: "" });
  const lib = [mkFlow("Fluxo no-show seguro", 5), mkFlow("Aniversário cliente"), mkFlow("Boas-vindas lead")];
  const rNoShow = rankSavedFlows("no-show", lib);
  check("acha 'no-show' com confidence high", rNoShow.confidence === "high" && rNoShow.best?.title === "Fluxo no-show seguro");
  check("best traz step_count", rNoShow.best?.step_count === 5);
  const rTypo = rankSavedFlows("noshow", lib);
  check("tolera typo 'noshow'", rTypo.best?.title === "Fluxo no-show seguro");
  const rAcc = rankSavedFlows("aniversario", lib); // sem acento
  check("tolera falta de acento 'aniversario'", rAcc.best?.title === "Aniversário cliente");
  const rLow = rankSavedFlows("cobrança fiscal xyz", lib);
  check("query sem match → low / sem best", rLow.confidence === "low" && rLow.best === null);
  const ambLib = [mkFlow("Fluxo no-show seguro"), mkFlow("Fluxo no-show college")];
  const rAmb = rankSavedFlows("no-show", ambLib);
  check("2 fluxos 'no-show' → ambiguous", rAmb.confidence === "ambiguous" && rAmb.candidates.length === 2);
  check("rank vazio → low", rankSavedFlows("qualquer", []).confidence === "low");

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
  await sendMediaToContact(fakeClient, "ABCdef1234567890XYZ", "https://x.com/f.pdf", "Segue o PDF", "SMS");
  check("POST em /conversations/messages", captured.path === "/conversations/messages");
  check("body com attachments:[url]", JSON.stringify((captured.body as { attachments?: string[] })?.attachments) === JSON.stringify(["https://x.com/f.pdf"]));
  check("type=SMS (Stevo→WhatsApp)", (captured.body as { type?: string })?.type === "SMS");
  check("helper repassa o message verbatim", (captured.body as { message?: string })?.message === "Segue o PDF");

  // Probe F5 (prod 2026-06-21): anexo nativo funciona → a TOOL manda legenda LIMPA
  // (sem despejar a URL assinada, que expira). Sem legenda, cai no fallback = a URL.
  const sendTool = TASK_ORCHESTRATOR_TOOLS.find((t) => t.def.name === "send_media_to_contact");
  const toolCtx = { rep: { id: "r" }, locationId: "l", companyId: "c", ghlClient: fakeClient } as unknown as ToolContext;
  captured = {};
  await sendTool!.handler(toolCtx, { contact_id: "AAAA1111bbbb2222CCCC", media_url: "https://x.com/f.pdf", caption: "Segue o PDF do fluxo" });
  check("tool: legenda LIMPA (sem URL na message)", (captured.body as { message?: string })?.message === "Segue o PDF do fluxo");
  captured = {};
  await sendTool!.handler(toolCtx, { contact_id: "AAAA1111bbbb2222CCCC", media_url: "https://x.com/f.pdf" });
  check("tool: sem legenda → texto neutro (NUNCA a URL, que expira)", (captured.body as { message?: string })?.message === "Segue o arquivo 📎");

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

    // Fix caso Jussara 2026-06-29: o [nome] do passo vira o nome REAL do contato no
    // followup_messages (antes saía "[nome]" cru). Round-trip no DB.
    const nameDraft = await core.startDraft(repId, LOC, null, { kind: "campaign", title: "Nome" });
    const nameId = nameDraft.ok ? nameDraft.snapshot.draft_id : "";
    await core.addStep(repId, nameId, { offset_days: 0, message_text: "Oi [nome], tudo bem?" });
    // guard anti-duplicata: 2º passo com texto IGUAL → vem com note (não bloqueia)
    const dupStep = await core.addStep(repId, nameId, { offset_days: 1, message_text: "Oi [nome], tudo bem?" });
    check("add_step duplicado → ok COM note de aviso", dupStep.ok && !!dupStep.note);
    await core.setMeta(repId, nameId, { target: { contact_id: "NAME1111bbbb2222CCCC", contact_name: "Matheus Albuquerque" } });
    const matName = await materializeDraft(repId, nameId, "America/New_York");
    check("materializou fluxo com [nome]", matName.ok && matName.count === 2);
    const { data: nameMsgs } = await db.from("followup_messages").select("message_text").eq("sequence_id", matName.ok ? matName.sequence_id : "").order("position");
    check("[nome] → 'Matheus' no DB (não sai cru)", !!nameMsgs && nameMsgs[0].message_text === "Oi Matheus, tudo bem?");
    check("nenhum placeholder [nome] cru no DB", !!nameMsgs && nameMsgs.every((m) => !hasNamePlaceholder(m.message_text)));

    console.log("\n=== F6: aplicar fluxo a N contatos (template) ===");
    const tmpl = await core.startDraft(repId, LOC, null, { kind: "followup_sequence", title: "Template no-show" });
    const tId = tmpl.ok ? tmpl.snapshot.draft_id : "";
    await core.addStep(repId, tId, { offset_days: 0, message_text: "Oi [nome]! passo A" });
    await core.addStep(repId, tId, { offset_days: 2, message_text: "passo B" });
    const applied = await applyFlowToContacts(repId, tId, [
      { contact_id: "AAAA1111bbbb2222CCCC" }, // sem nome → placeholder removido
      { contact_id: "DDDD3333eeee4444FFFF", contact_name: "Lany" },
    ], "America/New_York");
    check("apply a 2 contatos → 2 sucessos", "succeeded" in applied && applied.succeeded === 2);
    check("total_messages = 4 (2 passos × 2 contatos)", "total_messages" in applied && applied.total_messages === 4);
    // [nome] interpolado POR-CONTATO: cada sequência usa o nome do SEU contato.
    const perContact = "per_contact" in applied ? applied.per_contact : [];
    const seqLany = perContact.find((p) => p.contact_id === "DDDD3333eeee4444FFFF")?.sequence_id ?? "";
    const seqNoName = perContact.find((p) => p.contact_id === "AAAA1111bbbb2222CCCC")?.sequence_id ?? "";
    const { data: lanyMsgs } = await db.from("followup_messages").select("message_text").eq("sequence_id", seqLany).order("position");
    const { data: noNameMsgs } = await db.from("followup_messages").select("message_text").eq("sequence_id", seqNoName).order("position");
    check("apply: [nome] → 'Lany' na sequência da Lany", !!lanyMsgs && lanyMsgs[0].message_text === "Oi Lany! passo A");
    check("apply: sem nome → placeholder removido ('Oi! passo A')", !!noNameMsgs && noNameMsgs[0].message_text === "Oi! passo A");
    const progT = await getDraftProgress(tId);
    check("progresso do template: total=4 pending=4", progT.ok && progT.total === 4 && progT.pending === 4);
    const { data: tRow } = await db.from("task_drafts").select("status").eq("id", tId).maybeSingle();
    check("template continua reusável (status != materialized)", tRow?.status === "building");

    console.log("\n=== Review 2026-06-21: guardas dos fixes ===");

    // IDOR: draft de OUTRO rep não vaza/muta (rep_id forçado nos resolvers)
    const otherRep = "00000000-0000-0000-0000-000000000000";
    const idorRead = await core.showDraft(otherRep, tId);
    check("IDOR: showDraft de outro rep → recusado", !idorRead.ok);
    const idorWrite = await core.addStep(otherRep, tId, { offset_days: 1, message_text: "hack" });
    check("IDOR: mutator de outro rep → recusado", !idorWrite.ok);

    // Idempotência: re-aplicar o MESMO template aos MESMOS contatos → 0 novos (dup skip)
    const reapply = await applyFlowToContacts(repId, tId, [
      { contact_id: "AAAA1111bbbb2222CCCC" },
      { contact_id: "DDDD3333eeee4444FFFF" },
    ], "America/New_York");
    check("idempotência: re-aplicar aos mesmos → succeeded=0 (não duplica)", "succeeded" in reapply && reapply.succeeded === 0);

    // Cap anti-spam: >MAX_APPLY_CONTACTS contatos → rejeitado no handler
    const applyTool = TASK_ORCHESTRATOR_TOOLS.find((t) => t.def.name === "apply_flow_to_contacts");
    const capCtx = { rep: { id: repId, timezone: null }, locationId: LOC, companyId: "c", ghlClient: null } as unknown as ToolContext;
    const manyContacts = Array.from({ length: 201 }, (_, i) => ({ contact_id: "AAAA1111bbbb2222" + String(i).padStart(4, "0") }));
    const capRes = await applyTool!.handler(capCtx, { draft_id: tId, contacts: manyContacts });
    check("cap: >200 contatos → rejeitado", capRes.status === "error");

    // Intra-day delay: 2 passos no MESMO dia/horário, 2º com +30s → scheduled_at espaçado.
    // kind 'file_export' (livre) pra NÃO retomar o template followup_sequence ainda ativo (tId).
    const idd = await core.startDraft(repId, LOC, null, { kind: "file_export", title: "Intra-day" });
    const iddId = idd.ok ? idd.snapshot.draft_id : "";
    await core.addStep(repId, iddId, { offset_days: 0, send_time: "06:00", message_text: "msg 1" });
    await core.addStep(repId, iddId, { offset_days: 0, send_time: "06:00", intra_day_delay_s: 30, message_text: "msg 2" });
    await core.setMeta(repId, iddId, { target: { contact_id: "EEEE5555ffff6666GGGG", contact_name: "Intra" } });
    const matIdd = await materializeDraft(repId, iddId, "America/Sao_Paulo");
    check("intra-day: materializou 2 msgs", matIdd.ok && matIdd.count === 2);
    const { data: iddMsgs } = await db.from("followup_messages").select("scheduled_at").eq("sequence_id", matIdd.ok ? matIdd.sequence_id : "").order("scheduled_at");
    const delta = iddMsgs && iddMsgs.length === 2 ? new Date(iddMsgs[1].scheduled_at).getTime() - new Date(iddMsgs[0].scheduled_at).getTime() : -1;
    check("intra-day: 2ª msg +30s da 1ª (intra_day_delay_s aplicado)", delta === 30000);

    // F7 por último: cria fluxos salvos (não polui as retomadas por-kind acima).
    console.log("\n=== F7: biblioteca de fluxos salvos (round-trip DB) ===");
    // Salva o template do F6 na biblioteca com um nome
    const saved = await markFlowSaved(tId, repId, "No-show seguro de vida");
    check("markFlowSaved → 1 afetado", saved.ok && saved.affected === 1);
    const savedOther = await markFlowSaved(tId, "00000000-0000-0000-0000-000000000000", "hack");
    check("markFlowSaved de outro rep → 0 afetado (escopo)", savedOther.affected === 0);
    // Lista a biblioteca
    const myFlows = await listSavedFlows(repId);
    check("listSavedFlows traz o fluxo salvo + step_count", myFlows.length === 1 && myFlows[0].title === "No-show seguro de vida" && myFlows[0].step_count === 2);
    // Resolve por nome (fuzzy) sobre a biblioteca real
    const resolved = rankSavedFlows("no show", myFlows);
    check("resolveFlow acha 'no show' → high + flow certo", resolved.confidence === "high" && resolved.best?.draft_id === tId);
    // Aplica o fluxo salvo via a TOOL (apply_saved_flow) por flow_query
    const applySaved = TASK_ORCHESTRATOR_TOOLS.find((t) => t.def.name === "apply_saved_flow");
    const savedCtx = { rep: { id: repId, timezone: null }, locationId: LOC, companyId: "c", ghlClient: null } as unknown as ToolContext;
    const applyByName = await applySaved!.handler(savedCtx, { flow_query: "no-show", contacts: [{ contact_id: "HHHH7777iiii8888JJJJ", contact_name: "Gislene Souza" }] });
    check("apply_saved_flow por nome → aplicou", applyByName.status === "ok" && (applyByName.data as { applied?: boolean }).applied === true);
    check("apply_saved_flow reporta o nome do fluxo", (applyByName.data as { flow_name?: string }).flow_name === "No-show seguro de vida");
    // [nome] interpolado no fluxo salvo aplicado
    const gisSeq = ((applyByName.data as { per_contact?: Array<{ contact_id: string; sequence_id?: string }> }).per_contact || [])[0]?.sequence_id ?? "";
    const { data: gisMsgs } = await db.from("followup_messages").select("message_text").eq("sequence_id", gisSeq).order("position");
    check("fluxo salvo: [nome] → 'Gislene' no envio", !!gisMsgs && gisMsgs[0].message_text === "Oi Gislene! passo A");
    // Ambíguo NÃO aplica (devolve candidatos): cria um 2º fluxo salvo "No-show ..."
    const amb = await core.startDraft(repId, LOC, null, { kind: "file_export", title: "No-show college" });
    const ambId = amb.ok ? amb.snapshot.draft_id : "";
    await core.addStep(repId, ambId, { offset_days: 0, message_text: "oi" });
    await markFlowSaved(ambId, repId, "No-show college");
    const applyAmb = await applySaved!.handler(savedCtx, { flow_query: "no-show", contacts: [{ contact_id: "HHHH7777iiii8888JJJJ" }] });
    check("apply_saved_flow ambíguo → NÃO aplica, pede desambiguação", (applyAmb.data as { needs_disambiguation?: boolean })?.needs_disambiguation === true);
  } finally {
    // cleanup: deletar a rep cascateia draft/steps/events
    await db.from("rep_identities").delete().eq("id", repId);
    console.log("  (cleanup: rep de teste removida)");
  }

  console.log(`\n=== RESULTADO: ${pass} passou, ${fail} falhou ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
