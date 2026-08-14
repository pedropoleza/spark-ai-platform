// Golden test do silence-gate (Onda 1 · V2).
// Roda: npx tsx -r tsconfig-paths/register scripts/test-silence-gate.ts
//
// Garante: (1) NUDGE mantém o comportamento (soft@1, hard@2, pausa@3);
// (2) lembrete REQUESTED nunca ameaça, nunca incrementa, mas respeita a pausa;
// (3) o recado de silêncio vai DEPOIS da mensagem, nunca antes.

import {
  checkSilenceGate,
  appendSilenceNote,
  type SilenceState,
} from "@/lib/account-assistant/proactive/silence-gate";

const st = (counter: number, paused = false, warned = false, pauseSource: string | null = null): SilenceState => ({
  consecutive_proactive_without_reply: counter,
  proactive_paused_at: paused ? new Date().toISOString() : null,
  proactive_warned_at: warned ? new Date().toISOString() : null,
  proactive_pause_source: pauseSource,
});

interface Case { name: string; ok: boolean }
const cases: Case[] = [];
function check(name: string, cond: boolean) { cases.push({ name, ok: cond }); }

// ── NUDGE (comportamento atual preservado) ──
const n0 = checkSilenceGate(st(0), "nudge");
check("nudge c0 → envia, sem warning, next 1", n0.canSend === true && n0.canSend && n0.warningNote === null && n0.nextCounter === 1);
const n1 = checkSilenceGate(st(1), "nudge");
// Copy do H43 (humanização 2026-06-24): o tom antigo ("⚠️ Último aviso: vou
// pausar") foi o pior ofensor de naturalidade e virou registro de colega. O
// teste checava a copy ANTIGA e falhava desde então — agora afere o texto vivo.
check("nudge c1 → soft warning, next 2", n1.canSend === true && !!n1.warningNote && n1.warningNote!.includes("meio sumido") && n1.nextCounter === 2);
const n2 = checkSilenceGate(st(2), "nudge");
check("nudge c2 → hard warning, next 3", n2.canSend === true && !!n2.warningNote && n2.warningNote!.includes("dou um tempo nos lembretes") && n2.nextCounter === 3);
const n3 = checkSilenceGate(st(3), "nudge");
check("nudge c3 → não envia, pausa", n3.canSend === false && n3.reason === "should_pause" && n3.shouldSetPaused === true);
const np = checkSilenceGate(st(1, true), "nudge");
check("nudge pausado → não envia", np.canSend === false && np.reason === "already_paused");
const n1w = checkSilenceGate(st(1, false, true), "nudge");
check("nudge c1 já warned → sem warning duplicado, next 2", n1w.canSend === true && n1w.warningNote === null && n1w.nextCounter === 2);

// ── REQUESTED (lembrete que o rep pediu — regra de ouro) ──
const r0 = checkSilenceGate(st(0), "requested");
check("requested c0 → envia limpo, NÃO incrementa", r0.canSend === true && r0.warningNote === null && r0.nextCounter === 0);
const r2 = checkSilenceGate(st(2), "requested");
check("requested c2 → SEM warning (não ameaça), NÃO incrementa", r2.canSend === true && r2.warningNote === null && r2.nextCounter === 2 && r2.markWarned === false);
const r3 = checkSilenceGate(st(3), "requested");
check("requested c3 → ainda envia limpo (não pune lembrete pedido)", r3.canSend === true && r3.warningNote === null && r3.nextCounter === 3);
// 2026-08-14: pausa de SILÊNCIO não segura mais lembrete PEDIDO (sinal de
// 08/08: "O rep PEDIU esse lembrete e não recebeu" — task 3 dias em defer até
// expirar como failed). Pausa de loop_guard (IA×IA) continua barrando tudo.
const rpSil = checkSilenceGate(st(2, true), "requested");
check(
  "requested + pausa de SILÊNCIO → FURA (rep pediu, rep recebe)",
  rpSil.canSend === true && rpSil.warningNote === null && rpSil.nextCounter === 2 && rpSil.markWarned === false,
);
const rpLoop = checkSilenceGate(st(2, true, false, "loop_guard"), "requested");
check(
  "requested + pausa de LOOP_GUARD → respeita (segurança dura)",
  rpLoop.canSend === false && rpLoop.reason === "already_paused",
);
const npSil = checkSilenceGate(st(1, true), "nudge");
check("nudge + pausa de silêncio → continua barrado", npSil.canSend === false && npSil.reason === "already_paused");

// ── Ordem: o recado vem DEPOIS do conteúdo ──
// Caso real (Nathalia Barbosa, 05/08): o Resumo matinal chegou abrindo com "Se
// não rolar resposta hoje eu dou um tempo nos lembretes…" e só embaixo o
// "☀️ Bom dia". A primeira linha do dia virava quase-cobrança.
const briefing = "☀️ Bom dia, *Nathalia*! Dia cheio pela frente.\n\n📅 *4 reunião(ões) hoje:*";
const comNota = appendSilenceNote(briefing, n2.canSend ? n2.warningNote : null);
check("mensagem vem primeiro", comNota.startsWith("☀️ Bom dia"));
check("recado vem no fim", comNota.trimEnd().endsWith("é só me chamar."));
check("separado por linha em branco", comNota.includes("*4 reunião(ões) hoje:*\n\ndou um tempo") === false && comNota.split("\n\n").length >= 3);
check("sem nota, a mensagem sai intacta", appendSilenceNote(briefing, null) === briefing);
check("nota vazia não deixa rastro", appendSilenceNote(briefing, "   ") === briefing);
check("não duplica quebra de linha", !appendSilenceNote("texto\n\n", "recado").includes("\n\n\n"));

let pass = 0, fail = 0;
console.log("=== Golden test: silence-gate (Onda 1) ===\n");
for (const c of cases) { console.log(`${c.ok ? "✅" : "❌"} ${c.name}`); if (c.ok) pass++; else fail++; }
console.log(`\n${pass}/${pass + fail} OK`);
if (fail > 0) process.exit(1);
