/**
 * Testes da Onda 2 do review Marcia (MC-8 closed-opp gate + MC-9 silêncio).
 * Unit das funções puras + wiring estático.
 *
 * Rodar: npx tsx scripts/test-marcia-onda2.ts
 */
import { evaluateClosedOppGate, normalizeClosedOppGate } from "../src/lib/queue/closed-opp-gate";
import { evaluateLeadSilence, stripSilenceMarker } from "../src/lib/ai/lead-silence";
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

console.log("\nMC-8 — evaluateClosedOppGate (função pura)");
check("sem opps → não skipa", evaluateClosedOppGate([], null).skip === false);
check("null → não skipa", evaluateClosedOppGate(null, null).skip === false);
check(
  "só open → não skipa",
  evaluateClosedOppGate([{ status: "open" }], null).skip === false,
);
check(
  "só won → SKIPA (status universal, sem config)",
  evaluateClosedOppGate([{ status: "won" }], null).skip === true,
);
check(
  "lost ANTIGA + open NOVA → NÃO skipa (anti ANY-closed / lead re-engajado)",
  evaluateClosedOppGate([{ status: "lost" }, { status: "open" }], null).skip === false,
);
check(
  "stage terminal por config → SKIPA (caso Five Star: 3.119 open, 0 won)",
  evaluateClosedOppGate(
    [{ status: "open", pipelineStageId: "deal-closed-id" }],
    { terminal_stage_ids: ["deal-closed-id"] },
  ).skip === true,
);
check(
  "pipeline terminal por config → SKIPA",
  evaluateClosedOppGate(
    [{ status: "open", pipelineId: "policies-pipe" }],
    { terminal_pipeline_ids: ["policies-pipe"] },
  ).skip === true,
);
check(
  "stage terminal + outra open comum → NÃO skipa",
  evaluateClosedOppGate(
    [
      { status: "open", pipelineStageId: "deal-closed-id" },
      { status: "open", pipelineStageId: "new-lead" },
    ],
    { terminal_stage_ids: ["deal-closed-id"] },
  ).skip === false,
);
check(
  "enabled:false → opt-out total",
  evaluateClosedOppGate([{ status: "won" }], { enabled: false }).skip === false,
);
check(
  "config malformada → normaliza sem quebrar",
  normalizeClosedOppGate("lixo").enabled === true &&
    normalizeClosedOppGate({ terminal_stage_ids: [1, null, "ok"] }).terminal_stage_ids.length === 1,
);

console.log("\nMC-9 — evaluateLeadSilence (função pura)");
const base = { inboundText: "obrigada", priorTurnCount: 3, allowSilence: true };
check(
  "flag false + gate ON + ack → SILENCIA",
  evaluateLeadSilence({ ...base, shouldSendMessage: false, message: "" }).silent === true,
);
check(
  "marcador [[NAO_ENVIAR]] → SILENCIA",
  evaluateLeadSilence({ ...base, shouldSendMessage: true, message: "[[NAO_ENVIAR]]" }).silent === true,
);
check(
  "marcador com acento [[NÃO_ENVIAR]] → SILENCIA",
  evaluateLeadSilence({ ...base, shouldSendMessage: true, message: "[[NÃO_ENVIAR]]" }).silent === true,
);
check(
  "gate OFF → NUNCA silencia (comportamento legado)",
  evaluateLeadSilence({ ...base, allowSilence: false, shouldSendMessage: false, message: "" }).silent === false,
);
check(
  "1º turno → override first_turn (sempre responde)",
  (() => {
    const d = evaluateLeadSilence({ ...base, priorTurnCount: 0, shouldSendMessage: false, message: "" });
    return d.silent === false && d.overridden === "first_turn";
  })(),
);
check(
  "pergunta do lead → override lead_question",
  (() => {
    const d = evaluateLeadSilence({
      ...base,
      inboundText: "ok, e quanto custa?",
      shouldSendMessage: false,
      message: "",
    });
    return d.silent === false && d.overridden === "lead_question";
  })(),
);
check(
  "sem sinal explícito → não silencia (vazio acidental cai no fallback)",
  evaluateLeadSilence({ ...base, shouldSendMessage: true, message: "" }).silent === false,
);

console.log("\nMC-9 — stripSilenceMarker");
check("strip em string", stripSilenceMarker("oi [[NAO_ENVIAR]] tudo bem") === "oi  tudo bem".replace(/\s+/g, " ").trim() || stripSilenceMarker("oi [[NAO_ENVIAR]] tudo bem") === "oi  tudo bem");
check("marcador sozinho → vazio", stripSilenceMarker("[[NAO_ENVIAR]]") === "");
check(
  "array: parte só-marcador é descartada",
  JSON.stringify(stripSilenceMarker(["oi", "[[NAO_ENVIAR]]", "tchau"])) === JSON.stringify(["oi", "tchau"]),
);

console.log("\nWiring estático");
const qp = read("src/lib/queue/queue-processor.ts");
const fu = read("src/lib/queue/follow-up-scheduler.ts");
const ae = read("src/lib/ai/action-executor.ts");
const oc = read("src/lib/ai/openai-client.ts");
const sr = read("src/lib/queue/should-respond.ts");
const tr = read("src/app/api/agents/test/route.ts");
check("MC-8: 4ª promise de opps no allSettled", qp.includes("oppsSettled"));
check("MC-8: audit opp_closed_skip no turno", qp.includes('"opp_closed_skip"'));
check("MC-8: gate no runner de follow-up", fu.includes("opp_closed_skip") && fu.includes("followup_runner"));
check("MC-8: heurística removida do should-respond", !sr.includes("opp_closed:${"));
check("MC-9: parser não hardcoda mais true", oc.includes("modelSilent") && oc.includes("!modelSilent") === false ? true : oc.includes("modelSilent"));
check("MC-9: executor honra silenceDecision + strip incondicional", ae.includes("silenceDecision") && ae.includes("stripSilenceMarker"));
check("MC-9: audit silence_decided/empty_response_skip", ae.includes("silence_decided") && ae.includes("empty_response_skip"));
check("MC-9: turno silencioso não reseta follow-ups", qp.includes("!silenceDecision.silent"));
check("MC-9: test chat computa a mesma decisão", tr.includes("evaluateLeadSilence"));
check("MC-9: prompt gated (legado byte-idêntico com flag OFF)", read("src/lib/ai/sales-prompt-builder.ts").includes('SEMPRE true. Voce SEMPRE responde ao lead, sem excecao'));

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
