/**
 * UR-1 (ultra-review 2026-07-17) — testes dos guards P0:
 *   - withDeadline (anti-timeout por tool; casos Luciano/Fabiana)
 *   - detectPingPongLoop (loop bot-a-bot; caso Fabiana)
 *   - isInsufficientFundsError + copy do bloqueio de wallet (decisão Pedro)
 *
 * Rodar: npx tsx scripts/test-ur1-guards.ts
 */
import { withDeadline, DeadlineExceededError } from "../src/lib/utils/deadline";
import {
  detectPingPongLoop,
  LOOP_MIN_EXCHANGES,
  type LoopGuardMsg,
} from "../src/lib/account-assistant/loop-guard";
import {
  isInsufficientFundsError,
  WALLET_BLOCKED_REP_MESSAGE,
  WALLET_BLOCKED_OWNER_MESSAGE,
} from "../src/lib/billing/wallet-block";

let passed = 0,
  failed = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  if (actual === expected) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name} (esperava ${expected}, veio ${actual})`);
    failed++;
  }
}

async function main() {
  console.log("\n=== withDeadline ===");
  eq("promise rápida resolve", await withDeadline(Promise.resolve(42), 1000), 42);
  try {
    await withDeadline(new Promise((r) => setTimeout(r, 500)), 50, "tool_lenta");
    eq("promise lenta rejeita", "não lançou", "DeadlineExceededError");
  } catch (err) {
    eq("promise lenta rejeita", err instanceof DeadlineExceededError, true);
    eq("mensagem carrega o label", (err as Error).message.includes("tool_lenta"), true);
  }
  try {
    await withDeadline(Promise.reject(new Error("erro real da tool")), 1000);
    eq("erro da tool propaga", "não lançou", "Error");
  } catch (err) {
    eq("erro da tool propaga (não vira deadline)", err instanceof DeadlineExceededError, false);
  }

  console.log("\n=== detectPingPongLoop ===");
  const t0 = Date.parse("2026-07-15T00:54:00Z");
  const mk = (role: string, offsetS: number, len = 80): LoopGuardMsg => ({
    role,
    created_at: new Date(t0 + offsetS * 1000).toISOString(),
    content_len: len,
  });
  // Caso Fabiana: 7 trocas agent→user com ~30s de gap, textos longos → LOOP
  const fabiana: LoopGuardMsg[] = [];
  for (let k = 0; k < 7; k++) {
    fabiana.push(mk("agent", k * 60));
    fabiana.push(mk("user", k * 60 + 30));
  }
  eq("loop Fabiana (7 trocas ~30s, textos longos) → looping", detectPingPongLoop(fabiana).looping, true);
  eq("conta as trocas", detectPingPongLoop(fabiana).exchanges >= LOOP_MIN_EXCHANGES, true);

  // Humano rápido mas com textos CURTOS ("sim", "ok") → NÃO é loop
  const humanoCurto: LoopGuardMsg[] = [];
  for (let k = 0; k < 8; k++) {
    humanoCurto.push(mk("agent", k * 60));
    humanoCurto.push(mk("user", k * 60 + 20, 8));
  }
  eq("humano rápido com textos curtos → NÃO looping", detectPingPongLoop(humanoCurto).looping, false);

  // 5 trocas (abaixo do mínimo) → NÃO
  const cinco = fabiana.slice(0, 10);
  eq("5 trocas → NÃO looping (abaixo do mínimo)", detectPingPongLoop(cinco).looping, false);

  // Respostas lentas (>90s) → NÃO
  const lento: LoopGuardMsg[] = [];
  for (let k = 0; k < 7; k++) {
    lento.push(mk("agent", k * 300));
    lento.push(mk("user", k * 300 + 120));
  }
  eq("respostas >90s → NÃO looping", detectPingPongLoop(lento).looping, false);

  // Double-text do rep (user atrás de user) quebra o padrão → NÃO
  const doubleText = [...fabiana.slice(0, 12), mk("user", 999, 80), mk("user", 1000, 80)];
  eq("double-text humano quebra o padrão", detectPingPongLoop(doubleText).looping, false);

  // Bubbles múltiplas do agent entre trocas → ainda detecta
  const comBubbles: LoopGuardMsg[] = [];
  for (let k = 0; k < 7; k++) {
    comBubbles.push(mk("agent", k * 90));
    comBubbles.push(mk("agent", k * 90 + 5));
    comBubbles.push(mk("user", k * 90 + 35));
  }
  eq("bubbles duplas do agent → ainda looping", detectPingPongLoop(comBubbles).looping, true);

  eq("conversa vazia → NÃO looping", detectPingPongLoop([]).looping, false);
  eq("só agent (proativos sem resposta) → NÃO looping", detectPingPongLoop([mk("agent", 0), mk("agent", 10)]).looping, false);
  // H52 review adversarial: rep já flagrado re-silencia com 2 trocas
  const duasTrocas = [mk("agent", 0), mk("user", 30), mk("agent", 60), mk("user", 90)];
  eq("rep flagrado: 2 trocas bastam (minExchanges=2)", detectPingPongLoop(duasTrocas, 2).looping, true);
  eq("rep não-flagrado: 2 trocas NÃO bastam (default 6)", detectPingPongLoop(duasTrocas).looping, false);

  console.log("\n=== wallet-block (partes puras) ===");
  eq(
    "detecta o 400 do GHL",
    isInsufficientFundsError(new Error("GHL billing charge failed: 400 Location wallet has insufficient funds")),
    true,
  );
  eq("case-insensitive", isInsufficientFundsError("INSUFFICIENT FUNDS"), true);
  eq("outro erro 400 NÃO marca", isInsufficientFundsError(new Error("400 Price is not within the allowed range")), false);
  eq("null-safe", isInsufficientFundsError(null), false);
  // Naming user-facing: sempre "Spark Leads", nunca "GHL"/"GoHighLevel"
  for (const [label, msg] of [
    ["rep", WALLET_BLOCKED_REP_MESSAGE],
    ["owner", WALLET_BLOCKED_OWNER_MESSAGE],
  ] as const) {
    eq(`copy ${label} menciona Spark Leads`, msg.includes("Spark Leads"), true);
    eq(`copy ${label} tem o telefone do suporte`, msg.includes("+1 (786) 771-7077"), true);
    eq(`copy ${label} NÃO vaza "GHL"`, /GHL|GoHighLevel/i.test(msg), false);
  }

  console.log(`\n=== ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
