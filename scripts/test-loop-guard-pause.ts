/**
 * Testes da pausa do loop-guard e do backoff do lembrete bloqueado
 * (H68, caso Gustavo Couto 2026-08-04).
 *
 * O que se protege aqui: um rep REAL flagrado por engano não pode ficar mudo
 * pra sempre, e um lembrete bloqueado não pode ser destruído.
 *
 * Rodar: npx tsx -r tsconfig-paths/register scripts/test-loop-guard-pause.ts
 */
import { isHumanProofMsg, detectPingPongLoop } from "../src/lib/account-assistant/loop-guard";

let pass = 0,
  fail = 0;
function ok(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

// ── 1. Prova de humano: é o que tira o rep real da armadilha ─────────────────
console.log("\n1. isHumanProofMsg — o que prova que tem gente do outro lado");
ok("tap de menu (interactive_reply)", isHumanProofMsg(null, { interactive_reply: "button" }));
ok("tap de menu (selection_id)", isHumanProofMsg(null, { selection_id: "confirm" }));
ok("áudio gravado", isHumanProofMsg(null, { input_kind: "audio" }));
ok("marcador de opção no content (msg antiga)", isHumanProofMsg('[opção escolhida na lista: "Confirmar ✅"]', null));
ok("marcador de áudio no content", isHumanProofMsg("🎤 \"me lembra amanhã\"", null));
ok("texto puro NÃO é prova de humano", !isHumanProofMsg("ok pode ser", { input_kind: "text" }));
ok("metadata vazia → não é prova", !isHumanProofMsg("oi", null));

// ── 2. O caso Gustavo: digitador rápido não pode ser lido como bot ───────────
console.log("\n2. detectPingPongLoop — o padrão que silenciou o Gustavo");
function troca(n: number, gapMs: number, len: number, humanProof = false) {
  const base = Date.parse("2026-07-22T23:00:00Z");
  const msgs = [];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "agent", created_at: new Date(base + i * 2 * gapMs).toISOString(), content_len: len });
    msgs.push({
      role: "user",
      created_at: new Date(base + i * 2 * gapMs + gapMs).toISOString(),
      content_len: len,
      is_human_proof: humanProof,
    });
  }
  return msgs;
}
ok("6 trocas rápidas e longas, sem prova de humano → acusa (caso Fabiana)", detectPingPongLoop(troca(6, 20_000, 300)).looping);
ok(
  "as MESMAS 6 trocas com tap/áudio no meio → NÃO acusa (fix H55, caso Melissa)",
  !detectPingPongLoop(troca(6, 20_000, 300, true)).looping,
);
ok("resposta lenta (>90s) não é padrão de bot", !detectPingPongLoop(troca(6, 120_000, 300)).looping);
ok("poucas trocas não acusam", !detectPingPongLoop(troca(3, 20_000, 300)).looping);
ok(
  "threshold reduzido (2) re-acusa o loop de verdade na hora",
  detectPingPongLoop(troca(2, 20_000, 300), 2).looping,
);
ok(
  "…mas com prova de humano nem o threshold 2 acusa",
  !detectPingPongLoop(troca(2, 20_000, 300, true), 2).looping,
);

// ── 3. Backoff do lembrete bloqueado ────────────────────────────────────────
// Réplica da fórmula do reminder-runner (deferDelayMs). O ponto: um rep pausado
// com muitos lembretes (a Michelle Melo tem 137 pendentes) não pode gerar
// re-claim a cada 30min por 3 dias.
console.log("\n3. backoff do lembrete bloqueado");
const BASE = 30 * 60 * 1000;
const CAP = 12 * 60 * 60 * 1000;
const MAX = 3 * 24 * 60 * 60 * 1000;
const atraso = (n: number) => Math.min(BASE * 2 ** Math.max(0, n - 1), CAP);
ok("1ª tentativa espera 30min", atraso(1) === BASE);
ok("2ª espera 1h", atraso(2) === 2 * BASE);
ok("5ª espera 8h", atraso(5) === 16 * BASE);
ok("satura em 12h", atraso(9) === CAP && atraso(50) === CAP);
{
  let total = 0,
    tentativas = 0;
  while (total < MAX && tentativas < 200) {
    tentativas++;
    total += atraso(tentativas);
  }
  ok(`chega em 3 dias com ~8 tentativas (deu ${tentativas}), não 144`, tentativas <= 12);
}

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
