// Golden test do silence-gate (Onda 1 · V2).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-silence-gate.ts
//
// Garante: (1) NUDGE mantém o comportamento (soft@1, hard@2, pausa@3);
// (2) lembrete REQUESTED nunca ameaça, nunca incrementa, mas respeita a pausa.

import { checkSilenceGate, type SilenceState } from "@/lib/account-assistant/proactive/silence-gate";

const st = (counter: number, paused = false, warned = false): SilenceState => ({
  consecutive_proactive_without_reply: counter,
  proactive_paused_at: paused ? new Date().toISOString() : null,
  proactive_warned_at: warned ? new Date().toISOString() : null,
});

interface Case { name: string; ok: boolean }
const cases: Case[] = [];
function check(name: string, cond: boolean) { cases.push({ name, ok: cond }); }

// ── NUDGE (comportamento atual preservado) ──
const n0 = checkSilenceGate(st(0), "nudge");
check("nudge c0 → envia, sem warning, next 1", n0.canSend === true && n0.canSend && n0.warningPrefix === null && n0.nextCounter === 1);
const n1 = checkSilenceGate(st(1), "nudge");
check("nudge c1 → soft warning, next 2", n1.canSend === true && !!n1.warningPrefix && n1.warningPrefix!.includes("percebendo") && n1.nextCounter === 2);
const n2 = checkSilenceGate(st(2), "nudge");
check("nudge c2 → hard warning, next 3", n2.canSend === true && !!n2.warningPrefix && n2.warningPrefix!.includes("Último aviso") && n2.nextCounter === 3);
const n3 = checkSilenceGate(st(3), "nudge");
check("nudge c3 → não envia, pausa", n3.canSend === false && n3.reason === "should_pause" && n3.shouldSetPaused === true);
const np = checkSilenceGate(st(1, true), "nudge");
check("nudge pausado → não envia", np.canSend === false && np.reason === "already_paused");
const n1w = checkSilenceGate(st(1, false, true), "nudge");
check("nudge c1 já warned → sem warning duplicado, next 2", n1w.canSend === true && n1w.warningPrefix === null && n1w.nextCounter === 2);

// ── REQUESTED (lembrete que o rep pediu — regra de ouro) ──
const r0 = checkSilenceGate(st(0), "requested");
check("requested c0 → envia limpo, NÃO incrementa", r0.canSend === true && r0.warningPrefix === null && r0.nextCounter === 0);
const r2 = checkSilenceGate(st(2), "requested");
check("requested c2 → SEM warning (não ameaça), NÃO incrementa", r2.canSend === true && r2.warningPrefix === null && r2.nextCounter === 2 && r2.markWarned === false);
const r3 = checkSilenceGate(st(3), "requested");
check("requested c3 → ainda envia limpo (não pune lembrete pedido)", r3.canSend === true && r3.warningPrefix === null && r3.nextCounter === 3);
const rp = checkSilenceGate(st(2, true), "requested");
check("requested pausado → respeita pausa (anti-ban)", rp.canSend === false && rp.reason === "already_paused");

let pass = 0, fail = 0;
console.log("=== Golden test: silence-gate (Onda 1) ===\n");
for (const c of cases) { console.log(`${c.ok ? "✅" : "❌"} ${c.name}`); if (c.ok) pass++; else fail++; }
console.log(`\n${pass}/${pass + fail} OK`);
if (fail > 0) process.exit(1);
