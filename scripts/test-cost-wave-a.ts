/**
 * Testes da Onda A do estudo de custo (2026-07-20):
 *  A1 — TTL 1h revertido (verificação estática: processor não passa mais "1h")
 *  A2 — present_options terminal (shouldEndOnTerminalTool, decisão pura)
 *  A3 — pricing: claude-sonnet-5 / opus-4-6 corrigido / isKnownModel
 *  A4 — dispatcher desliga cache em regra scheduled (verificação estática)
 *  A6 — prompt sem a contradição "TTL 30 min" e sem o header stale "~43 tools"
 *
 * Rodar: npx tsx scripts/test-cost-wave-a.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import { shouldEndOnTerminalTool } from "../src/lib/account-assistant/llm-client";
import { extractInteractiveFromToolCalls } from "../src/lib/account-assistant/core/interactive";
import { calculateCost, isKnownModel } from "../src/lib/billing/pricing";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ─── A2: shouldEndOnTerminalTool (decisão pura) ───────────────────────────────
console.log("\nA2 — shouldEndOnTerminalTool");

const validPayload = {
  body: "Confirma a nota pro João?",
  options: [
    { id: "confirm", label: "Confirmar ✅" },
    { id: "cancel", label: "Cancelar" },
  ],
};
const poValidate = (inp: Record<string, unknown>) =>
  extractInteractiveFromToolCalls([{ name: "present_options", input: inp }]) !== null;
const TERMINALS = [{ name: "present_options", validate: poValidate }];
const okCall = { name: "present_options", result: { status: "ok", data: { presented: true } } };

check(
  "caso feliz: 1 tool_use present_options + payload válido + exec ok → encerra",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: validPayload }],
    terminalTools: TERMINALS,
    lastCall: okCall,
  }) === true,
);
check(
  "multi tool_use na MESMA resposta → NÃO encerra (comportamento antigo)",
  shouldEndOnTerminalTool({
    toolUses: [
      { name: "get_contact", input: {} },
      { name: "present_options", input: validPayload },
    ],
    terminalTools: TERMINALS,
    lastCall: okCall,
  }) === false,
);
check(
  "tool não-terminal → NÃO encerra",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "get_contact", input: {} }],
    terminalTools: TERMINALS,
    lastCall: { name: "get_contact", result: { status: "ok" } },
  }) === false,
);
check(
  "sem terminalTools registradas → NÃO encerra",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: validPayload }],
    terminalTools: undefined,
    lastCall: okCall,
  }) === false,
);
check(
  "execução devolveu status:error → NÃO encerra (LLM precisa reagir)",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: validPayload }],
    terminalTools: TERMINALS,
    lastCall: { name: "present_options", result: { status: "error", message: "boom" } },
  }) === false,
);
check(
  "lastCall de OUTRA tool (defensivo) → NÃO encerra",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: validPayload }],
    terminalTools: TERMINALS,
    lastCall: { name: "get_contact", result: { status: "ok" } },
  }) === false,
);
check(
  "sem lastCall (tool nem executou) → NÃO encerra",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: validPayload }],
    terminalTools: TERMINALS,
    lastCall: null,
  }) === false,
);
check(
  "payload INVÁLIDO (sem body) → NÃO encerra (os ~2% que o LLM resolve em texto)",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: { options: validPayload.options } }],
    terminalTools: TERMINALS,
    lastCall: okCall,
  }) === false,
);
check(
  "payload INVÁLIDO (options vazias) → NÃO encerra",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: { body: "x", options: [] } }],
    terminalTools: TERMINALS,
    lastCall: okCall,
  }) === false,
);
check(
  "payload INVÁLIDO (option sem id/label) → NÃO encerra",
  shouldEndOnTerminalTool({
    toolUses: [
      { name: "present_options", input: { body: "x", options: [{ id: "", label: "" }] } },
    ],
    terminalTools: TERMINALS,
    lastCall: okCall,
  }) === false,
);
check(
  "validate que LANÇA → NÃO encerra (conta como reprovado)",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "boom_tool", input: {} }],
    terminalTools: [{ name: "boom_tool", validate: () => { throw new Error("boom"); } }],
    lastCall: { name: "boom_tool", result: { status: "ok" } },
  }) === false,
);
check(
  "terminal SEM validate → encerra no exec ok",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "simple_terminal", input: {} }],
    terminalTools: [{ name: "simple_terminal" }],
    lastCall: { name: "simple_terminal", result: { status: "ok" } },
  }) === true,
);
check(
  "result sem campo status (tool não-padronizada) → encerra (só 'error' explícito barra)",
  shouldEndOnTerminalTool({
    toolUses: [{ name: "simple_terminal", input: {} }],
    terminalTools: [{ name: "simple_terminal" }],
    lastCall: { name: "simple_terminal", result: { anything: 1 } },
  }) === true,
);

// ─── A2: paridade validador ↔ extração (o que encerra TEM que extrair depois) ─
console.log("\nA2 — paridade validate ↔ extractInteractiveFromToolCalls");
const payloads: Array<[string, Record<string, unknown>, boolean]> = [
  ["payload de botões válido", validPayload, true],
  ["lista 5 opções válida", { body: "Qual contato?", options: Array.from({ length: 5 }, (_, i) => ({ id: `c${i}`, label: `Contato ${i}` })) }, true],
  ["sem body", { options: validPayload.options }, false],
  ["body vazio (espaços)", { body: "   ", options: validPayload.options }, false],
  ["options não-array", { body: "x", options: "nope" }, false],
];
for (const [label, p, expected] of payloads) {
  check(`${label} → validate=${expected}`, poValidate(p) === expected);
  const wouldEnd = shouldEndOnTerminalTool({
    toolUses: [{ name: "present_options", input: p }],
    terminalTools: TERMINALS,
    lastCall: okCall,
  });
  check(`${label} → encerra=${expected} E extração=${expected} (nunca diverge)`,
    wouldEnd === expected &&
    (extractInteractiveFromToolCalls([{ name: "present_options", input: p }]) !== null) === expected,
  );
}

// ─── A3: pricing ──────────────────────────────────────────────────────────────
console.log("\nA3 — pricing (sonnet-5 / opus / isKnownModel)");
{
  // sonnet-5 deve cobrar tarifa SONNET ($3/$0.30/$3.75/$15), não gpt-4.1-mini
  const c = calculateCost({
    model: "claude-sonnet-5",
    promptTokens: 1_000_000,
    completionTokens: 100_000,
    cachedTokens: 200_000,
    cacheCreationTokens: 100_000,
  });
  // fresh 700K×$3 + cached 200K×$0.30 + write 100K×$3.75 + out 100K×$15 = 2.1+0.06+0.375+1.5 = $4.035
  check("claude-sonnet-5 custo exato $4.035 (tarifa sonnet)", Math.abs(c.costUsd - 4.035) < 1e-6, `got ${c.costUsd}`);
  check("claude-sonnet-5 charge com markup 10% = $4.4385", Math.abs(c.totalChargeUsd - 4.4385) < 1e-6, `got ${c.totalChargeUsd}`);
  // antes (DEFAULT gpt-4.1-mini) daria: 700K×0.40 + 200K×0.10 + 100K×0.40 + 100K×1.60 = $0.50
  check("claude-sonnet-5 NÃO cobra mais a tarifa do DEFAULT (~$0.50)", c.costUsd > 4, `got ${c.costUsd}`);
}
{
  const c = calculateCost({ model: "claude-opus-4-6", promptTokens: 1_000_000, completionTokens: 0 });
  check("claude-opus-4-6 corrigido: 1M fresh = $5.00 (era $15)", Math.abs(c.costUsd - 5.0) < 1e-6, `got ${c.costUsd}`);
}
{
  const c = calculateCost({ model: "claude-opus-4-8", promptTokens: 0, completionTokens: 1_000_000 });
  check("claude-opus-4-8 presente: 1M output = $25.00", Math.abs(c.costUsd - 25.0) < 1e-6, `got ${c.costUsd}`);
}
check("isKnownModel: claude-sonnet-5 → true", isKnownModel("claude-sonnet-5") === true);
check("isKnownModel: sufixo de data (prefix match) → true", isKnownModel("claude-sonnet-4-6-20251103") === true);
check("isKnownModel: whisper-1 (áudio) → true", isKnownModel("whisper-1") === true);
check("isKnownModel: gpt-4.1-mini → true", isKnownModel("gpt-4.1-mini") === true);
check("isKnownModel: modelo desconhecido → false", isKnownModel("claude-fantasia-9") === false);
check("isKnownModel: string vazia → false", isKnownModel("") === false);

// ─── A1/A4/A6: verificações estáticas nos fontes ──────────────────────────────
console.log("\nA1/A4/A6 — verificações estáticas");
const read = (p: string) => readFileSync(resolve(__dirname, "..", p), "utf8");
{
  const processor = read("src/lib/account-assistant/processor.ts");
  check("A1: processor NÃO passa mais cacheTtl: \"1h\"", !/cacheTtl:\s*"1h"/.test(processor));
  check("A2: processor registra present_options como terminal", processor.includes("terminalTools") && processor.includes('"present_options"'));
  const dispatcher = read("src/lib/account-assistant/proactive/dispatcher.ts");
  check("A4: dispatcher desliga cache em regra scheduled", /disableCache:\s*rule\.rule_type === "scheduled"/.test(dispatcher));
  const pb = read("src/lib/account-assistant/prompt-builder.ts");
  const pbStrings = pb.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("A6: contradição 'TTL 30 min' REMOVIDA das strings do prompt", !pbStrings.includes("TTL 30 min"));
  check("A6: rascunho 24h presente na regra de planilha", pbStrings.includes("rascunho de import por 24h"));
  check("A6: header '~43 tools' removido", !pbStrings.includes("~43 tools"));
  const llm = read("src/lib/account-assistant/llm-client.ts");
  check("A1: F3 breakpoint do histórico respeita disableCache", llm.includes("!input.disableCache && messages.length >= 2"));
  const charge = read("src/lib/billing/charge.ts");
  check("A3: trackAndCharge sinaliza modelo fora do pricing", charge.includes("isKnownModel") && charge.includes("modelo sem pricing"));
  check("A7: falha de cobrança persiste charge_fail_reason", charge.includes("markChargeFailReason"));
}

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
