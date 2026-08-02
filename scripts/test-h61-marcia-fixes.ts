/**
 * Teste H61 (incidente Five Star/Marcia 2026-08-01) — as 3 frentes de código:
 *  F3: idempotência do booking (isSameSlotInstant + interação com o guard H58)
 *  F4: detecção de contexto de anúncio (isAdContextBody)
 *  F5: pass-through do should_send_message no parser + override lead_question
 *      sem falso-positivo de "?" de URL (evaluateLeadSilence)
 *
 * Rodar: npx tsx scripts/test-h61-marcia-fixes.ts
 */
import { isSameSlotInstant, validateBookingSlot } from "../src/lib/ai/slot-guard";
import { isAdContextBody } from "../src/lib/queue/ad-context";
import { evaluateLeadSilence } from "../src/lib/ai/lead-silence";
import { parseAIResponse } from "../src/lib/ai/openai-client";
import { pickFutureAppointment } from "../src/lib/ai/action-executor";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}`);
  }
}

// ─── F3: isSameSlotInstant ───────────────────────────────────────────────────
console.log("\nF3 — isSameSlotInstant (idempotência do booking)");
// Caso real Adriana: turno 2 re-emitiu o MESMO horário do appointment do turno 1
check("mesmo instante, mesmo offset", isSameSlotInstant("2026-08-04T16:00:00-04:00", "2026-08-04T16:00:00-04:00"));
check("mesmo instante, offsets diferentes (-04:00 vs Z)", isSameSlotInstant("2026-08-04T16:00:00-04:00", "2026-08-04T20:00:00Z"));
check("dentro da tolerância (59s)", isSameSlotInstant("2026-08-04T16:00:00-04:00", "2026-08-04T16:00:59-04:00"));
check("fora da tolerância (61s)", !isSameSlotInstant("2026-08-04T16:00:00-04:00", "2026-08-04T16:01:01-04:00"));
check("horário DIFERENTE (17:00) não é duplicata", !isSameSlotInstant("2026-08-04T16:00:00-04:00", "2026-08-04T17:00:00-04:00"));
check("ISO inválido → false (não vira sucesso fantasma)", !isSameSlotInstant("banana", "2026-08-04T16:00:00-04:00"));
check("null/undefined → false", !isSameSlotInstant(null, undefined));

// Interação com o guard: o slot recém-consumido some da lista → guard bloqueia
// (é exatamente o gatilho do fix — o executor então checa isSameSlotInstant)
const offered = ["2026-08-04T11:00:00-04:00", "2026-08-04T17:00:00-04:00"]; // 16:00 já consumido
const guardBlocks = validateBookingSlot("2026-08-04T16:00:00-04:00", offered);
check("guard H58 segue bloqueando o slot consumido (pré-condição do fix)", !guardBlocks.ok);
check("guard H58 segue aceitando slot da lista", validateBookingSlot("2026-08-04T17:00:00-04:00", offered).ok);

// ─── F3 v2: pickFutureAppointment (review adversarial) ───────────────────────
console.log("\nF3 v2 — pickFutureAppointment (contato com 2+ appointments futuros)");
const NOW = new Date("2026-08-01T12:00:00Z");
const apptA = { id: "A", startTime: "2026-08-03T10:00:00-04:00" }; // seg 10h
const apptB = { id: "B", startTime: "2026-08-04T15:00:00-04:00" }; // ter 15h
check("prefere o que casa o instante (B), não o primeiro do array", pickFutureAppointment([apptA, apptB], NOW, "2026-08-04T15:00:00-04:00")?.id === "B");
check("prefere o que casa mesmo com offset diferente (Z)", pickFutureAppointment([apptA, apptB], NOW, "2026-08-04T19:00:00Z")?.id === "B");
check("sem preferStartTime → primeiro futuro (legado)", pickFutureAppointment([apptA, apptB], NOW)?.id === "A");
check("prefer sem match → primeiro futuro (fallback legado)", pickFutureAppointment([apptA, apptB], NOW, "2026-08-05T09:00:00-04:00")?.id === "A");
check("cancelado é filtrado", pickFutureAppointment([{ id: "C", startTime: "2026-08-03T10:00:00-04:00", status: "cancelled" }, apptB], NOW, "2026-08-03T10:00:00-04:00")?.id === "B");
check("passado é filtrado", pickFutureAppointment([{ id: "P", startTime: "2026-07-30T10:00:00-04:00" }], NOW) === null);
check("lista vazia → null", pickFutureAppointment([], NOW) === null);

// ─── F4: isAdContextBody ─────────────────────────────────────────────────────
console.log("\nF4 — isAdContextBody (contexto de anúncio CTWA)");
const realAdBody =
  '📢 Veio de anúncio (instagram): "Márcia Oliveira"\nhttps://www.instagram.com/p/Da5xyz\n\nQuero entender como funciona o seguro com benefício em vida.';
check("body real de prod (instagram) → true", isAdContextBody(realAdBody));
check('variante facebook → true', isAdContextBody('📢 Veio de anúncio (facebook): "Márcia Oliveira"\nhttps://fb.me/6XHSTG7VC\n\nQuero entender'));
check("sem emoji → true (robustez)", isAdContextBody('Veio de anúncio (instagram): "X"'));
check("sem acento → true", isAdContextBody('📢 Veio de anuncio (instagram): "X"'));
check("com dois-pontos direto → true", isAdContextBody("📢 Veio de anúncio: \"X\""));
check("texto normal do lead → false", !isAdContextBody("Quero entender como funciona o seguro com benefício em vida."));
check("frase no MEIO da mensagem → false", !isAdContextBody("Oi! Veio de anúncio (instagram) esse contato?"));
check("dados do lead → false", !isAdContextBody("Silvia Domanoski\n26/07/1972\nMassachusetts\nNão"));
check("placeholder de áudio → false", !isAdContextBody("[audio 0:20]"));
check("vazio → false", !isAdContextBody(""));

// ─── F5a: parseAIResponse pass-through ───────────────────────────────────────
console.log("\nF5a — parseAIResponse: should_send_message pass-through");
const base = { actions: [], collected_data: {}, conversation_status: "active" };
const rFalse = parseAIResponse(JSON.stringify({ ...base, message: "", should_send_message: false }));
check("false LITERAL do modelo → false (era o bug: virava true)", rFalse?.should_send_message === false);
const rTrue = parseAIResponse(JSON.stringify({ ...base, message: "Oi!", should_send_message: true }));
check("true do modelo → true", rTrue?.should_send_message === true);
const rMissing = parseAIResponse(JSON.stringify({ ...base, message: "Oi!" }));
check("ausente → true (fail-open)", rMissing?.should_send_message === true);
const rWeird = parseAIResponse(JSON.stringify({ ...base, message: "Oi!", should_send_message: "nope" }));
check('valor não-booleano ("nope") → true (só false literal silencia)', rWeird?.should_send_message === true);
check("silêncio explícito não ganha fallback 'Pode me contar mais?'", rFalse?.message === "");
check("vazio ACIDENTAL (sem flag) mantém fallback", rMissing && rTrue ? parseAIResponse(JSON.stringify(base))?.message === "Pode me contar mais?" : false);

// ─── F5b: evaluateLeadSilence — "?" de URL não força resposta ────────────────
console.log("\nF5b — evaluateLeadSilence: override lead_question sem falso-positivo de URL");
const silencePedido = {
  shouldSendMessage: false,
  message: "",
  priorTurnCount: 3,
  allowSilence: true,
};
const adInbound = '📢 Veio de anúncio (instagram): "Márcia"\nhttps://www.instagram.com/p/Da5?igsh=abc&x=1\n\nQuero entender como funciona.';
const dUrl = evaluateLeadSilence({ ...silencePedido, inboundText: adInbound });
check("'?' só em URL → silêncio mantido (era: URL forçava resposta)", dUrl.silent === true && dUrl.overridden === null);
const dRealQuestion = evaluateLeadSilence({ ...silencePedido, inboundText: "Quanto custa? https://x.com/a?b=1" });
check("pergunta REAL (fora da URL) → força resposta", dRealQuestion.silent === false && dRealQuestion.overridden === "lead_question");
const dFirstTurn = evaluateLeadSilence({ ...silencePedido, inboundText: "ok", priorTurnCount: 0 });
check("1º turno segue forçando resposta", dFirstTurn.silent === false && dFirstTurn.overridden === "first_turn");
const dGateOff = evaluateLeadSilence({ ...silencePedido, inboundText: "ok", allowSilence: false });
check("gate OFF → nunca silencia (legado intacto)", dGateOff.silent === false);
const dMarker = evaluateLeadSilence({ ...silencePedido, shouldSendMessage: true, message: "[[NAO_ENVIAR]]", inboundText: "ok" });
check("marcador [[NAO_ENVIAR]] segue funcionando", dMarker.silent === true && dMarker.via === "marker");
// v2 (review adversarial): "?" solto no fim de URL é pergunta REAL; gateOn no decision
const dUrlTrailingQ = evaluateLeadSilence({ ...silencePedido, inboundText: "consegue abrir esse link https://site.com/plano?" });
check("'?' SOLTO no fim da URL → pergunta real, força resposta (v2)", dUrlTrailingQ.silent === false && dUrlTrailingQ.overridden === "lead_question");
const dUrlQuery = evaluateLeadSilence({ ...silencePedido, inboundText: "segue https://x.com/a?utm_source=ig obrigada" });
check("query-string real (?utm=...) segue strippada → silêncio mantido", dUrlQuery.silent === true);
check("gateOn=true refletido no decision (gate ON)", dUrl.gateOn === true);
check("gateOn=false refletido no decision (gate OFF)", dGateOff.gateOn === false);

// ─── Resultado ───────────────────────────────────────────────────────────────
console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : ""}`);
process.exit(fail ? 1 : 0);
