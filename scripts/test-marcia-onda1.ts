/**
 * Testes da Onda 1 do review Marcia (MC-1..MC-7 + MC-10, 2026-07-28).
 * Verificações estáticas dos pontos de wiring (padrão test-onda-d.ts) —
 * a lógica é DB-coupled; o comportamento é validado pós-deploy nas queries
 * do plano (targeting_skip ativo ~0, zero processing órfão, etc).
 *
 * Rodar: npx tsx scripts/test-marcia-onda1.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}
const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");

console.log("\nMC-1 — rajada de follow-up (claim 5 + budget + reaper)");
const fu = read("src/lib/queue/follow-up-scheduler.ts");
check("claim limitado a 5", /\.limit\(5\)/.test(fu));
check("reaper de processing órfão → failed", fu.includes('"failed"') && fu.includes("reapCutoff"));
check("reaper NÃO devolve pra pending (anti double-send)", /update\(\{ status: "failed" \}\)\s*\n?\s*\.eq\("status", "processing"\)/.test(fu.replace(/\n\s+/g, " ")) || fu.includes('.update({ status: "failed" })'));
check("time-budget 40s no loop", fu.includes("BUDGET_MS = 40_000"));
check("budget estourado devolve não-iniciadas pra pending", fu.includes("budgetExceededAt") && fu.includes("untouchedIds"));

console.log("\nMC-2 — anti-churn do scheduleFollowUps");
check("processing do par → cancelled (zumbi não sobrevive ao reset)", fu.includes('.eq("status", "processing")') && fu.includes("cancelProcErr"));
check("pending do par → DELETE (fim do churn)", fu.includes(".delete()") && fu.includes('.eq("status", "pending")'));
check("captura 23505 com retry único", fu.includes('insErr?.code === "23505"'));

console.log("\nMC-3 — webhook não dropa lead novo sem tag");
const wh = read("src/app/api/webhooks/inbound-message/route.ts");
check("firstWithRules rastreado", wh.includes("firstWithRules"));
check("recheck adiado gated em lead NOVO (sem estado + sem fila)", wh.includes("states.length === 0") && wh.includes("priorRows"));
check("process_after +120s no deferred", wh.includes("deferredTargetingRecheck") && wh.includes("120_000"));
check("drop antigo preservado como fallback (audit)", wh.includes("no_agent_matched_targeting"));

console.log("\nMC-4/MC-5 — recuperação de wallet completa");
const wb = read("src/lib/billing/wallet-block.ts");
const rr = read("src/lib/queue/resume-reenqueue.ts");
check("janela começa NO bloqueio (sem +90s cego)", wb.includes("const sinceIso = blockedAtIso"));
check("dedupe por RESULTADO (send após último skip)", wb.includes("sentAfter") && wb.includes("lastSkipAt"));
check("janela real do episódio capada em 7d", wb.includes("episodeMs") && wb.includes("7 * 24 * 60 * 60 * 1000"));
check("resume-reenqueue aceita windowMs", rr.includes("windowMs?: number"));
check("resume-reenqueue aceita bypassTargeting (ai_resumed_at)", rr.includes("bypassTargeting") && rr.includes("ai_resumed_at"));
check("wallet passa bypassTargeting: true", wb.includes("bypassTargeting: true"));

console.log("\nMC-6 — rajada de inbound não vira turnos paralelos");
const qp = read("src/lib/queue/queue-processor.ts");
check("detecção de par in-flight pós-claim", qp.includes("inFlightPairs"));
check("grupo in-flight devolvido pra pending +30s", qp.includes("30_000") && qp.includes("groups.delete(key)"));
check("exclui as próprias rows claimadas", qp.includes("claimedIds.has(row.id)"));

console.log("\nMC-7 — F52 staleness guard (caso Geralda)");
check("constante 72h", qp.includes("HUMAN_TAKEOVER_STALE_MS = 72 * 60 * 60 * 1000"));
check("outbound humano velho NÃO pausa + audit", qp.includes("stale_human_outbound_ignored"));
check("pausa exige !humanOutboundIsStale", qp.includes("isHuman && !humanOutboundIsStale"));

console.log("\nMC-10 — hardening");
const ae = read("src/lib/ai/action-executor.ts");
check("reschedule marcado no log (mode)", ae.includes('"reschedule"') && ae.includes("rescheduled_from"));
check("ORDER BY na query de agentes do webhook", wh.includes('.order("created_at", { ascending: true })'));
check("sinal no_agent_matched com location no título", wh.includes("nenhum agente casou o targeting do contato (${locationId})"));

console.log("\nmigration 00128");
const mig = read("supabase/migrations/00128_followup_hygiene.sql");
check("UNIQUE parcial live", mig.includes("uq_followups_live_attempt"));
check("purge cancelled 7d", mig.includes("interval '7 days'"));
check("one-off zumbis", mig.includes("status='failed'"));

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
