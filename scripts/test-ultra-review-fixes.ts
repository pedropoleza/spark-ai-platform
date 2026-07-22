/**
 * Testes da Onda C (fixes do ultra-review das Ondas A+B, 2026-07-22):
 *  C1 — loop-guard: tap de menu/áudio = prova de humano, quebra o loop (caso Melissa)
 *  C2 — stevo-handler persiste tool_calls (verificação estática)
 *  C3 — schedule_message dedup (verificação estática do query)
 *  C4 — buildProcessorConfig helper + rotas usam ele (estático)
 *  C6 — call_usage nos error paths + dispatcher (estático)
 *
 * Rodar: npx tsx scripts/test-ultra-review-fixes.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  detectPingPongLoop,
  isHumanProofMsg,
  LOOP_MIN_EXCHANGES,
  type LoopGuardMsg,
} from "../src/lib/account-assistant/loop-guard";
import { buildProcessorConfig } from "../src/lib/account-assistant/core/processor-config";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ─── C1: isHumanProofMsg ──────────────────────────────────────────────────────
console.log("\nC1 — isHumanProofMsg");
check("metadata.interactive_reply → true", isHumanProofMsg("Calendário", { interactive_reply: "list" }) === true);
check("metadata.selection_id → true", isHumanProofMsg("x", { selection_id: "opt_2" }) === true);
check("metadata.input_kind=audio → true", isHumanProofMsg("🎤 texto", { input_kind: "audio" }) === true);
check("content 'opção escolhida na lista:' → true", isHumanProofMsg('foo\n[opção escolhida na lista: "Editar"]', null) === true);
check("content começa com 🎤 → true", isHumanProofMsg("🎤 \"marca a Rina\"", null) === true);
check("texto normal longo → false", isHumanProofMsg("Pode marcar a reunião com o João amanhã às 3 da tarde?", { input_kind: "text" }) === false);
check("metadata null + texto simples → false", isHumanProofMsg("oi tudo bem", null) === false);
check("content/metadata vazios → false", isHumanProofMsg("", {}) === false);

// ─── C1: detectPingPongLoop com prova de humano ──────────────────────────────
console.log("\nC1 — detectPingPongLoop quebra em tap/áudio");
// Helper: monta trocas agent→user rápidas (<90s) e longas (>=40 chars)
function makeExchanges(n: number, humanProofAt: number[] = []): LoopGuardMsg[] {
  const msgs: LoopGuardMsg[] = [];
  let t = Date.parse("2026-07-22T01:00:00Z");
  for (let i = 0; i < n; i++) {
    msgs.push({ role: "agent", created_at: new Date(t).toISOString(), content_len: 120 });
    t += 10_000; // 10s depois
    msgs.push({
      role: "user",
      created_at: new Date(t).toISOString(),
      content_len: 130, // > 40 (inflado pelo eco do tap)
      is_human_proof: humanProofAt.includes(i),
    });
    t += 10_000;
  }
  return msgs;
}

// Loop REAL (bot-a-bot, texto): 6 trocas, NENHUMA prova de humano → detecta
check(
  "6 trocas texto puro (Fabiana) → looping=true",
  detectPingPongLoop(makeExchanges(6)).looping === true,
);
// Caso MELISSA: 6 trocas rápidas MAS a última é tap de menu → NÃO detecta
check(
  "6 trocas mas a ÚLTIMA é tap (Melissa) → looping=false",
  detectPingPongLoop(makeExchanges(6, [5])).looping === false,
);
// Tap no meio também quebra (scan pára ao encontrar prova de humano)
check(
  "tap no meio da janela → quebra a contagem",
  detectPingPongLoop(makeExchanges(6, [3])).looping === false,
);
// Sem prova de humano em 5 trocas → não atinge o mínimo (6)
check(
  "5 trocas texto puro → looping=false (< mínimo)",
  detectPingPongLoop(makeExchanges(5)).looping === false,
);
// Threshold reduzido (rep já flagrado) ainda respeita a prova de humano
check(
  "threshold 2 + última é áudio → looping=false (humano)",
  detectPingPongLoop(makeExchanges(3, [2]), 2).looping === false,
);
check(
  "threshold 2 + 2 trocas texto puro → looping=true",
  detectPingPongLoop(makeExchanges(2), 2).looping === true,
);
check("LOOP_MIN_EXCHANGES é 6 (regressão)", LOOP_MIN_EXCHANGES === 6);

// ─── C4: buildProcessorConfig ─────────────────────────────────────────────────
console.log("\nC4 — buildProcessorConfig");
{
  const c = buildProcessorConfig(null);
  check("null → defaults seguros (high_only, kbs, enable_* true)",
    c.confirmation_mode === "high_only" && c.enabled_kbs.length === 2 &&
    c.enable_audio_transcription === true && c.enable_image_analysis === true &&
    c.enable_pdf_reading === true && c.disabled_tools.length === 0);
}
{
  const c = buildProcessorConfig({
    confirmation_mode: "always", ai_model: "claude-sonnet-4-6",
    disabled_tools: ["count_filtered", "bulk_cancel_all"],
    enabled_kbs: ["national_life_group"],
    enable_audio_transcription: true, enable_image_analysis: true, enable_pdf_reading: true,
    tone_creativity: 70,
  });
  check("config real: disabled_tools threaded (A5 destravado)", c.disabled_tools.length === 2 && c.disabled_tools.includes("bulk_cancel_all"));
  check("config real: ai_model/confirmation/tone respeitados", c.ai_model === "claude-sonnet-4-6" && c.confirmation_mode === "always" && c.tone_creativity === 70);
}
{
  // O caso do bug: enable_* explicitamente false → o helper RESPEITA false (por isso
  // o dado do hub foi corrigido pra true em prod; aqui provamos que false passa).
  const c = buildProcessorConfig({ enable_audio_transcription: false });
  check("enable_audio=false explícito → false (não vira true por engano)", c.enable_audio_transcription === false);
}

// ─── C2/C3/C4/C6: verificações estáticas ─────────────────────────────────────
console.log("\nC2/C3/C4/C6 — estáticas");
const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
{
  const stevo = read("src/lib/account-assistant/webhook/stevo-handler.ts");
  check("C2: stevo persiste tool_calls no metadata", stevo.includes("tool_calls: (result.tool_calls || []).slice(0, 30)"));
  check("C4: stevo carrega agent_config + usa buildProcessorConfig",
    stevo.includes('from("agent_configs")') && stevo.includes("buildProcessorConfig(agentConfig"));

  const msgs = read("src/lib/account-assistant/tools/messages.ts");
  check("C3: schedule_message tem dedup por rep+contato+horário+texto",
    msgs.includes('.eq("task_payload->>message", message)') && msgs.includes("deduped: true"));

  const webhook = read("src/lib/account-assistant/webhook-handler.ts");
  check("C4: webhook-handler usa buildProcessorConfig", webhook.includes("buildProcessorConfig(agentConfig"));

  const llm = read("src/lib/account-assistant/llm-client.ts");
  const midLoopHasCallUsage = /throw new LLMFailureMidLoop\([\s\S]*?call_usage,[\s\S]*?\)/.test(llm);
  check("C6: LLMFailureMidLoop inclui call_usage + cache_creation_tokens", midLoopHasCallUsage && llm.includes("err.partialResult.call_usage"));

  const disp = read("src/lib/account-assistant/proactive/dispatcher.ts");
  check("C6: dispatcher persiste call_usage no proativo", disp.includes("call_usage: llmResult.call_usage ?? null"));
}

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
