/**
 * E2E REAL do Motor de Orquestração (Pedro 2026-06-21, alvo: nº dele).
 *
 * Prova a cadeia INTEIRA em produção, sem depender do LLM digitar:
 *   start_task_draft → set_task_meta → add_step → commit_draft (materializa,
 *   count REAL) → [cron followup-runner de PROD, a cada 30s] → entrega no WhatsApp.
 *
 * A flag TASK_ORCHESTRATOR_ENABLED é setada SÓ NESTE PROCESSO (não toca a Vercel),
 * apenas pra registrar as tools localmente e exercitar o executeTool (caminho real).
 * A ENTREGA é feita pelo cron de produção (runFollowupTick global, 30s) — por isso
 * NÃO chamamos o runner aqui: zero colateral em sequências de outros leads.
 *
 * Uso (a flag PRECISA ir no COMANDO — import é hoisted, registro é gated no load):
 *   TASK_ORCHESTRATOR_ENABLED=1 npx tsx -r tsconfig-paths/register scripts/e2e-orchestrator-live.ts
 *   (LOCAL only — não altera prod/Vercel.)
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { createAdminClient } from "../src/lib/supabase/admin";
import { executeTool } from "../src/lib/account-assistant/tools/index";
import { GHLClient } from "../src/lib/ghl/client";
import type { ToolContext } from "../src/lib/account-assistant/tools/types";
import type { RepIdentity, ToolResult } from "../src/types/account-assistant";

const HUB_LOC = "RBFxlEQZobaDjlF2i5px";
const COMPANY = "TdmQMjj86Y3LgppiB96K";
const CONTACT = "61ZDGmCxZW0V2OODGcHo"; // pedro poleza +17867717077 NA hub (mesmo do probe)
const REP_ID = "1eeb02cc-1a48-4b56-b177-52dcbca07ac2"; // rep do Pedro
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const data = (r: ToolResult) => (r.status === "ok" ? (r.data as Record<string, unknown>) : {});

async function main() {
  const db = createAdminClient();
  const { data: rep } = await db.from("rep_identities").select("*").eq("id", REP_ID).single();
  if (!rep) { console.error("ABORTA: rep não encontrada"); process.exit(1); }

  const client = new GHLClient(COMPANY, HUB_LOC);

  // Pré-check: DND do contato (o runner PULA contato DND — fail-safe). Avisa.
  try {
    const c = await client.get<{ contact?: { dnd?: boolean; dndSettings?: { all?: { status?: string } } } }>(`/contacts/${CONTACT}`);
    const dnd = c.contact?.dnd || c.contact?.dndSettings?.all?.status === "active";
    console.log(`Contato ${CONTACT} | DND: ${dnd ? "SIM (runner vai PULAR!)" : "não"}`);
  } catch (e) { console.warn("não deu pra checar DND:", e instanceof Error ? e.message : e); }

  const ctx: ToolContext = {
    rep: rep as RepIdentity,
    locationId: HUB_LOC,
    companyId: COMPANY,
    ghlClient: client,
    confirmationMode: "high_only",
  };

  console.log("\n=== Montagem via executeTool (caminho real do LLM) ===");
  const start = await executeTool("start_task_draft", { title: "TESTE E2E orquestrador (Pedro)" }, ctx);
  console.log("start_task_draft:", start.status, "draft:", data(start).draft_id);
  await executeTool("set_task_meta", { contact_id: CONTACT, contact_name: "Pedro (teste E2E)", contact_phone: "+17867717077" }, ctx);
  const add = await executeTool("add_step", {
    offset_days: 0,
    send_time: "06:00", // no passado → scheduled_at = agora → cron pega no próximo tick
    message_text:
      "Teste E2E do motor de orquestracao do SparkBot: esta mensagem foi MONTADA como rascunho, MATERIALIZADA (com contagem real) e DISPARADA pelo followup-runner de producao - a cadeia inteira ponta a ponta. Se voce recebeu isto, o motor do caso Jussara funciona de verdade.",
  }, ctx);
  console.log("add_step:", add.status, "step_count:", data(add).step_count);

  console.log("\n=== Commit (H8) → materialização honesta ===");
  const noConfirm = await executeTool("commit_draft", {}, ctx);
  console.log("commit SEM confirmação:", noConfirm.status, noConfirm.status === "error" ? "(bloqueado, esperado)" : "");
  const commit = await executeTool("commit_draft", { confirmed_by_rep: true }, ctx);
  if (commit.status !== "ok") { console.error("ABORTA commit:", JSON.stringify(commit)); process.exit(1); }
  const seqId = data(commit).sequence_id as string;
  const count = data(commit).count as number;
  console.log(`commit OK → count REAL = ${count}, sequence = ${seqId}`);

  // Confirma no banco que o count bate
  const { count: dbMsgs } = await db.from("followup_messages").select("id", { count: "exact", head: true }).eq("sequence_id", seqId);
  console.log(`followup_messages no banco: ${dbMsgs} (bate com count: ${dbMsgs === count})`);

  console.log("\n=== Aguardando o cron de PROD (followup-runner, 30s) entregar... ===");
  let final: Record<string, unknown> | null = null;
  for (let i = 1; i <= 9; i++) {
    await wait(12000);
    const { data: msgs } = await db
      .from("followup_messages")
      .select("position,status,sent_at,error_message,ghl_message_id")
      .eq("sequence_id", seqId)
      .order("position");
    const m = msgs?.[0];
    console.log(`  [${i * 12}s] status=${m?.status} ghl_msg=${m?.ghl_message_id ?? "-"} ${m?.error_message ? "err=" + m.error_message : ""}`);
    if (m && m.status !== "pending" && m.status !== "sending") { final = m as Record<string, unknown>; break; }
  }

  const { data: seq } = await db.from("followup_sequences").select("status,sent_messages,failed_messages,skipped_messages").eq("id", seqId).single();
  console.log("\n=== RESULTADO ===");
  console.log("mensagem final:", JSON.stringify(final));
  console.log("sequence:", JSON.stringify(seq));
  if (final?.status === "sent") {
    console.log("\n✅ E2E COMPLETO: montagem → materialização (count real) → runner de prod → ENVIADO. Confere no WhatsApp.");
  } else if (!final) {
    console.log("\n⏳ Ainda pending após ~108s. O cron pega no próximo tick — rode a query de status de novo em 1min.");
  } else {
    console.log(`\n⚠️ Mensagem terminou em status='${final.status}' (${final.error_message ?? ""}). Ver acima o motivo (DND/reply/optout?).`);
  }
}

main().catch((e) => { console.error("ERRO:", e instanceof Error ? e.message : e); process.exit(1); });
