/**
 * SMOKE ponta-a-ponta do Motor de Orquestração (Pedro 2026-06-20, validação A).
 * Exercita o caminho REAL via executeTool (registro gated + gate H8 + test-mode +
 * handlers → core → materializer). Prova o núcleo anti-alucinação SEM tocar prod:
 * usa uma rep descartável e limpa no fim. NÃO faz envio real (não roda o runner).
 *
 * Uso: TASK_ORCHESTRATOR_ENABLED=1 npx tsx -r tsconfig-paths/register scripts/smoke-task-orchestrator.ts
 *      (a flag PRECISA estar setada ANTES do import — por isso vai no comando)
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { executeTool, getAllToolDefinitions } from "../src/lib/account-assistant/tools/index";
import type { ToolContext } from "../src/lib/account-assistant/tools/types";
import type { GHLClient } from "../src/lib/ghl/client";
import type { RepIdentity, ToolResult } from "../src/types/account-assistant";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, extra?: string) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? "  — " + extra : ""}`); }
}
function dataOf(r: ToolResult): Record<string, unknown> {
  return r.status === "ok" ? (r.data as Record<string, unknown>) : {};
}

async function main() {
  console.log("=== Registro (flag ON) ===");
  const defs = getAllToolDefinitions().map((d) => d.name);
  check("start_task_draft registrada", defs.includes("start_task_draft"));
  check("commit_draft registrada", defs.includes("commit_draft"));
  check("commit_draft é risk:high", getAllToolDefinitions().find((d) => d.name === "commit_draft")?.risk === "high");

  const db = createAdminClient();
  const phone = "+19990000002";
  await db.from("rep_identities").delete().eq("phone", phone);
  const { data: repRow, error } = await db
    .from("rep_identities")
    .insert({ phone, display_name: "SMOKE orchestrator", is_internal: true })
    .select("*")
    .single();
  if (error || !repRow) { console.error("não criou rep:", error?.message); process.exit(1); }

  const ctx: ToolContext = {
    rep: repRow as RepIdentity,
    locationId: "SMOKE_LOC",
    companyId: "SMOKE_CO",
    ghlClient: null as unknown as GHLClient, // tools do orquestrador não usam GHL
    confirmationMode: "high_only",
  };

  try {
    console.log("\n=== Montagem via executeTool ===");
    const start = await executeTool("start_task_draft", { title: "Smoke no-show" }, ctx);
    check("start_task_draft ok", start.status === "ok");
    await executeTool("add_step", { offset_days: 0, message_text: "Dia 0: oi [nome]" }, ctx);
    const a2 = await executeTool("add_step", { offset_days: 2, message_text: "Dia 2: ainda quer a cotação?" }, ctx);
    check("2 passos montados", (dataOf(a2).step_count as number) === 2);

    console.log("\n=== Persistência cross-session (ctx novo) ===");
    const ctx2: ToolContext = { ...ctx, rep: repRow as RepIdentity };
    const sd = await executeTool("show_draft", {}, ctx2);
    check("nova 'sessão' relê o fluxo do banco (2 passos)", (dataOf(sd).step_count as number) === 2);

    await executeTool("set_task_meta", { contact_id: "ABCdef1234567890XYZ", contact_name: "Eliz" }, ctx);

    console.log("\n=== Gate H8 (honestidade do disparo) ===");
    const noConfirm = await executeTool("commit_draft", {}, ctx);
    check("commit SEM confirmação → BLOQUEADO", noConfirm.status === "error" && /confirma/i.test((noConfirm as { message: string }).message));
    const committed = await executeTool("commit_draft", { confirmed_by_rep: true }, ctx);
    check("commit COM confirmação → ok", committed.status === "ok");
    check("count REAL = 2 (não inventado)", (dataOf(committed).count as number) === 2);

    // o count bate com o banco
    const seqId = dataOf(committed).sequence_id as string;
    const { count: msgs } = await db.from("followup_messages").select("id", { count: "exact", head: true }).eq("sequence_id", seqId);
    check("followup_messages no banco === count reportado", (msgs ?? -1) === (dataOf(committed).count as number));

    console.log("\n=== get_task_progress (verdade do banco) ===");
    const prog = await executeTool("get_task_progress", {}, ctx);
    check("progresso total=2", (dataOf(prog).total as number) === 2);

    console.log("\n=== Test-mode gate (não toca produção) ===");
    const ctxTest: ToolContext = { ...ctx, testSessionId: "smoke-test-session" };
    const mocked = await executeTool("add_step", { offset_days: 5, message_text: "x" }, ctxTest);
    check("add_step em test-mode → simulado (mock)", mocked.status === "ok" && (dataOf(mocked).simulated as boolean) === true);
    const readInTest = await executeTool("show_draft", {}, ctxTest);
    check("show_draft (safe) executa mesmo em test-mode", readInTest.status === "ok");
  } finally {
    await db.from("rep_identities").delete().eq("id", (repRow as { id: string }).id);
    console.log("  (cleanup: rep de smoke removida)");
  }

  console.log(`\n=== RESULTADO SMOKE: ${pass} passou, ${fail} falhou ===`);
  process.exit(fail === 0 ? 0 : 1);
}
main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
