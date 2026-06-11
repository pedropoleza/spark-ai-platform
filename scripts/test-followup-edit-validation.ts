// Test pra validação de new_scheduled_at no edit_followup (hardening paridade 2026-06-10).
// Roda com: npx tsx -r tsconfig-paths/register scripts/test-followup-edit-validation.ts
//
// Cobre o gap fechado: edit_followup escrevia new_scheduled_at CRU (sem validar
// ISO nem rejeitar passado), diferente do tool irmão schedule_message_to_contact.
// Exercita o HANDLER real (não o editSequence core) — que é onde a validação mora,
// igual ao irmão. Insere 1 sequence+msg de teste, roda os casos, e limpa em finally.
//
// NÃO envia msgs reais: contato fake + sequence status='draft' (runner ignora) +
// scheduled_at sempre futuro + cleanup imediato (cascade delete).

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "@/lib/supabase/admin";
import { FOLLOWUP_TOOLS } from "@/lib/account-assistant/tools/followup";
import type { ToolContext } from "@/lib/account-assistant/tools/types";
import type { ToolResult } from "@/types/account-assistant";

const LOC = "H09HtG22LZzTU8htMxxg";
const PEDRO_PHONE = "+17867717077";

const editTool = FOLLOWUP_TOOLS.find((t) => t.def.name === "edit_followup");
if (!editTool) throw new Error("edit_followup tool não encontrada no registry");

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name} — ${detail}`);
  }
}

// Handler usa só rep.id + locationId (verifyOwnership via createAdminClient).
// ghlClient nunca é chamado no edit_followup → stub seguro.
function makeCtx(repId: string): ToolContext {
  return {
    rep: { id: repId },
    locationId: LOC,
    companyId: "test",
    ghlClient: {},
  } as unknown as ToolContext;
}

async function main() {
  const supabase = createAdminClient();
  console.log("\n=== Test edit_followup new_scheduled_at validation ===\n");

  const { data: rep } = await supabase
    .from("rep_identities")
    .select("id")
    .eq("phone", PEDRO_PHONE)
    .maybeSingle();
  const repId = rep?.id;
  if (!repId) throw new Error("rep Pedro não encontrado (ajustar PEDRO_PHONE)");

  // Sequence de teste (status draft = runner não pega) + 1 msg pending no futuro.
  const futureBase = new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString();
  const { data: seq, error: seqErr } = await supabase
    .from("followup_sequences")
    .insert({
      rep_id: repId,
      location_id: LOC,
      contact_id: "EDITVALIDATIONTESTfakecontact",
      goal: "[edit-validation-test] cleanup-me",
      status: "draft",
      source: "chat",
    })
    .select("id")
    .single();
  if (seqErr || !seq) throw new Error(`insert sequence falhou: ${seqErr?.message}`);
  const seqId = seq.id as string;

  try {
    const { error: msgErr } = await supabase.from("followup_messages").insert({
      sequence_id: seqId,
      position: 1,
      message_text: "ORIGINAL",
      scheduled_at: futureBase,
      status: "pending",
    });
    if (msgErr) throw new Error(`insert message falhou: ${msgErr.message}`);

    const ctx = makeCtx(repId);
    const r = (res: ToolResult) => res as { status: string; message?: string; data?: { updated_messages?: number } };

    // 1. Data no passado → erro + DB inalterado
    const past = new Date(Date.now() - 3 * 3600 * 1000).toISOString();
    const r1 = r(await editTool!.handler(ctx, { sequence_id: seqId, edits: [{ position: 1, new_scheduled_at: past }] }));
    check("1. data no passado rejeitada", r1.status === "error" && /passado/i.test(r1.message || ""), JSON.stringify(r1));
    const { data: m1 } = await supabase
      .from("followup_messages")
      .select("scheduled_at")
      .eq("sequence_id", seqId)
      .eq("position", 1)
      .single();
    check(
      "1b. DB inalterado após rejeição de passado",
      !!m1 && new Date(m1.scheduled_at).getTime() === new Date(futureBase).getTime(),
      `esperava ${futureBase}, got ${m1?.scheduled_at}`,
    );

    // 2. ISO inválido → erro
    const r2 = r(await editTool!.handler(ctx, { sequence_id: seqId, edits: [{ position: 1, new_scheduled_at: "amanhã 9h" }] }));
    check("2. ISO inválido rejeitado", r2.status === "error", JSON.stringify(r2));

    // 3. Data futura válida (com offset) → ok + normaliza pra ISO canônico + DB atualizado
    const future2 = "2027-03-15T14:30:00-03:00";
    const r3 = r(await editTool!.handler(ctx, { sequence_id: seqId, edits: [{ position: 1, new_scheduled_at: future2 }] }));
    check("3. data futura aceita", r3.status === "ok", JSON.stringify(r3));
    check("3b. updated_messages=1", r3.data?.updated_messages === 1, JSON.stringify(r3.data));
    const { data: m3 } = await supabase
      .from("followup_messages")
      .select("scheduled_at")
      .eq("sequence_id", seqId)
      .eq("position", 1)
      .single();
    check(
      "3c. DB gravou o instante certo (normalizado)",
      !!m3 && new Date(m3.scheduled_at).getTime() === new Date(future2).getTime(),
      `esperava ${new Date(future2).toISOString()}, got ${m3?.scheduled_at}`,
    );

    // 4. Edição só de texto (sem data) continua funcionando
    const r4 = r(await editTool!.handler(ctx, { sequence_id: seqId, edits: [{ position: 1, new_text: "EDITADO" }] }));
    check("4. edição de texto sem data ok", r4.status === "ok" && r4.data?.updated_messages === 1, JSON.stringify(r4));
  } finally {
    await supabase.from("followup_sequences").delete().eq("id", seqId);
    console.log(`\n🧹 cleanup: sequence ${seqId} deletada (cascade → messages/events)`);
  }

  console.log(`\n========================================`);
  console.log(`Total: ${pass}/${pass + fail} (${fail} fail)`);
  console.log(`========================================`);
  console.log(fail === 0 ? "ALL GREEN" : "TEM FALHA");
  if (fail > 0) process.exit(1);
}

main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
