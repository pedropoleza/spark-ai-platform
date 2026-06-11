/**
 * Test suite F37 — Lead Awareness + Handoff Inteligente.
 *
 * Unit tests pra:
 *  - evaluateShouldRespond: cenários happy path + edge cases
 *  - buildLeadHistorySection: format output
 *  - loadLeadHistory: cache, fail-soft (sem fetch real)
 */
import { evaluateShouldRespond } from "../src/lib/queue/should-respond";
import { invalidateLeadHistoryCache, isHumanOutboundMessage } from "../src/lib/queue/lead-history";
import { buildLeadHistorySection, type PromptContext } from "../src/lib/ai/sales-prompt-builder";
import { isHumanOutboundSource, AUTOMATION_SOURCES, NON_HUMAN_SOURCES } from "../src/lib/ghl/message-sources";
import { classifyLastOutbound } from "../src/lib/queue/human-takeover";
import { DEFAULT_HANDOFF_POLICY, type LeadContext, type HandoffPolicy } from "../src/types/agent";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function eq<T>(actual: T, expected: T, label?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label || "values"} differ:\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`);
  }
}

function emptyContext(): LeadContext {
  return {
    contact: { id: "c1", name: "Maria", tags: [], customFields: [] },
    recent_messages: [],
    notes: [],
    opportunities: [],
    last_human_outbound_at: null,
    last_inbound_at: null,
    has_closed_opp: false,
    fetch_ms: 0,
  };
}

// Renderiza a seção de histórico. buildLeadHistorySection só lê ctx.leadHistory,
// então passamos um PromptContext mínimo (cast — os outros campos não são tocados).
function renderHistory(ctx: LeadContext): string {
  return buildLeadHistorySection({ leadHistory: ctx } as unknown as PromptContext);
}

function ctxWithOutbound(source: string | undefined): LeadContext {
  const c = emptyContext();
  c.recent_messages = [
    { direction: "outbound", body: "Olá! Seja bem-vindo 👋", dateAdded: "2026-06-10T12:00:00Z", source },
  ];
  return c;
}

console.log("\n=== F37 Test Suite ===\n");

console.log("evaluateShouldRespond:");

test("policy disabled → always respond", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: false };
  const d = evaluateShouldRespond(emptyContext(), "qualquer msg", p);
  eq(d.decision, "respond");
});

test("policy on, sem historico → respond", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true };
  const d = evaluateShouldRespond(emptyContext(), "oi", p);
  eq(d.decision, "respond");
});

test("humano respondeu há 30min, threshold 60 → skip", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true, skip_if_human_replied_within_minutes: 60 };
  const ctx = emptyContext();
  ctx.last_human_outbound_at = new Date(Date.now() - 30 * 60 * 1000).toISOString();
  const d = evaluateShouldRespond(ctx, "oi", p, new Date().toISOString());
  eq(d.decision, "skip");
  if (d.decision === "skip") {
    if (!d.reason.startsWith("human_replied_recently")) throw new Error(`bad reason: ${d.reason}`);
    eq(d.notify_rep, true);
  }
});

test("humano respondeu há 90min, threshold 60 → respond", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true, skip_if_human_replied_within_minutes: 60 };
  const ctx = emptyContext();
  ctx.last_human_outbound_at = new Date(Date.now() - 90 * 60 * 1000).toISOString();
  const d = evaluateShouldRespond(ctx, "oi", p, new Date().toISOString());
  eq(d.decision, "respond");
});

test("lead pediu humano via keyword → skip + notify", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true };
  const d = evaluateShouldRespond(emptyContext(), "Quero falar com alguém da equipe", p);
  eq(d.decision, "skip");
  if (d.decision === "skip") {
    if (!d.reason.startsWith("lead_requested_human")) throw new Error(`bad reason: ${d.reason}`);
    eq(d.notify_rep, true);
  }
});

test("acentos/case insensitive em keywords", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true };
  const d = evaluateShouldRespond(emptyContext(), "PRECISO DE UM ATENDENTE", p);
  eq(d.decision, "skip");
  if (d.decision === "skip") {
    if (!d.reason.startsWith("lead_requested_human")) throw new Error(`bad reason: ${d.reason}`);
  }
});

test("opp em status 'won' → skip silently", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true };
  const ctx = emptyContext();
  ctx.has_closed_opp = true;
  ctx.opportunities = [{ id: "o1", status: "won" }];
  const d = evaluateShouldRespond(ctx, "oi tudo bem?", p);
  eq(d.decision, "skip");
  if (d.decision === "skip") {
    if (!d.reason.startsWith("opp_closed")) throw new Error(`bad reason: ${d.reason}`);
    eq(d.notify_rep, false);
  }
});

test("opp 'won' mas skip_if_lead_requested_human pega antes", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true };
  const ctx = emptyContext();
  ctx.has_closed_opp = true;
  ctx.opportunities = [{ id: "o1", status: "won" }];
  const d = evaluateShouldRespond(ctx, "humano por favor", p);
  eq(d.decision, "skip");
  if (d.decision === "skip") {
    if (!d.reason.startsWith("lead_requested_human")) throw new Error(`reason esperada lead_requested_human, veio ${d.reason}`);
  }
});

test("opp 'open' não dispara opp_closed", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true };
  const ctx = emptyContext();
  ctx.opportunities = [{ id: "o1", status: "open" }];
  // has_closed_opp default false
  const d = evaluateShouldRespond(ctx, "oi", p);
  eq(d.decision, "respond");
});

test("skip_if_human_replied desligado (threshold 0) → não silencia", () => {
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true, skip_if_human_replied_within_minutes: 0 };
  const ctx = emptyContext();
  ctx.last_human_outbound_at = new Date(Date.now() - 5 * 60 * 1000).toISOString();
  const d = evaluateShouldRespond(ctx, "oi", p);
  eq(d.decision, "respond");
});

test("keyword 'humano' substring em 'humanoide' NÃO mata (acidentalmente match)", () => {
  // Note: nosso match é includes substring, então "humanoide" DEVE matchear
  // "humano" — esse é o comportamento esperado dado a simplicidade.
  // Esse test documenta a limitação atual.
  const p: HandoffPolicy = { ...DEFAULT_HANDOFF_POLICY, enabled: true };
  const d = evaluateShouldRespond(emptyContext(), "esse robô parece humanoide demais", p);
  eq(d.decision, "skip"); // intentional substring match
});

console.log("\nisHumanOutboundSource (fonte ÚNICA humano×bot):");

test("source 'app' (rep no inbox) → humano", () => eq(isHumanOutboundSource("app"), true));
test("source 'workflow' (automação/welcome) → NÃO humano", () => eq(isHumanOutboundSource("workflow"), false));
test("source 'campaign' → NÃO humano", () => eq(isHumanOutboundSource("campaign"), false));
test("source 'api' → NÃO humano", () => eq(isHumanOutboundSource("api"), false));
test("source vazio/undefined → NÃO humano", () => {
  eq(isHumanOutboundSource(undefined), false);
  eq(isHumanOutboundSource(""), false);
});
test("case-insensitive: 'WORKFLOW' → NÃO humano", () => eq(isHumanOutboundSource("WORKFLOW"), false));

console.log("\nisHumanOutboundMessage (fallback userId + anti-eco quando source ausente):");

// Fix review 2026-06-10: o GHL nem sempre devolve `source` no
// /conversations/{id}/messages. Sem source, a checagem só-por-source dava false e
// o gate "humano respondeu" (should-respond) morria silenciosamente — o rep ligava
// "pausa quando eu responder" e a IA seguia atropelando. Estes casos cobrem o
// fallback no userId + o anti-eco contra o próprio envio da IA (carimbado pelo GHL
// com o userId do admin), espelhando a defesa do F52/F56 em human-takeover.ts.
test("source ausente + userId (rep mandou manual) → humano", () =>
  eq(isHumanOutboundMessage({ direction: "outbound", body: "deixa comigo", userId: "u_rep" }, []), true));

test("source ausente, SEM userId → NÃO humano (não dá pra confirmar)", () =>
  eq(isHumanOutboundMessage({ direction: "outbound", body: "oi", userId: undefined }, []), false));

test("automação (source 'workflow') COM userId → NÃO humano (source manda, e06f409)", () =>
  eq(isHumanOutboundMessage({ direction: "outbound", body: "Seja bem-vindo!", source: "workflow", userId: "u_admin" }, []), false));

test("source 'app' (rep no inbox) → humano (userId nem é consultado)", () =>
  eq(isHumanOutboundMessage({ direction: "outbound", body: "oi", source: "app", userId: "u_rep" }, []), true));

test("eco da IA: source ausente + userId do admin + corpo = envio registrado da IA → NÃO humano", () => {
  const aiSent = ["Perfeito! Tenho horário hoje às 11:30 ou 16:00. Qual prefere?"];
  eq(isHumanOutboundMessage(
    { direction: "outbound", body: "Perfeito! Tenho horário hoje às 11:30 ou 16:00. Qual prefere?", userId: "u_admin" },
    aiSent,
  ), false);
});

test("humano genuíno: source ausente + userId + corpo ≠ envios da IA → humano", () => {
  const aiSent = ["Perfeito! Tenho horário hoje às 11:30 ou 16:00. Qual prefere?"];
  eq(isHumanOutboundMessage(
    { direction: "outbound", body: "Oi, aqui é a Márcia, vou assumir daqui 🙂", userId: "u_rep" },
    aiSent,
  ), true);
});

test("source ausente + userId mas aiTexts null (fetch do execution_log falhou) → NÃO humano (fail-open)", () =>
  eq(isHumanOutboundMessage({ direction: "outbound", body: "qualquer", userId: "u_admin" }, null), false));

test("inbound nunca conta como outbound-humano", () =>
  eq(isHumanOutboundMessage({ direction: "inbound", body: "oi", userId: "u_rep" }, []), false));

console.log("\nbuildLeadHistorySection — rótulo humano×bot:");

// Bug-fix 2026-06-10: antes o rótulo usava `source !== \"api\"` (estreito), então
// o welcome de automação (source 'workflow'/'campaign') aparecia como
// \"Humano (rep)\" no prompt — soft nudge pro modelo achar que um humano já
// atendia o lead. Agora alinhado com o should-respond gate (lead-history.ts).
test("outbound source='workflow' → rótulo 'Bot/sistema', NUNCA 'Humano (rep)'", () => {
  const section = renderHistory(ctxWithOutbound("workflow"));
  if (!section.includes('Bot/sistema: "')) throw new Error(`esperava 'Bot/sistema':\n${section}`);
  if (section.includes("Humano (rep)")) throw new Error(`workflow virou 'Humano (rep)':\n${section}`);
});
test("outbound source='campaign' → rótulo 'Bot/sistema'", () => {
  const section = renderHistory(ctxWithOutbound("campaign"));
  if (!section.includes('Bot/sistema: "')) throw new Error(`esperava 'Bot/sistema':\n${section}`);
  if (section.includes("Humano (rep)")) throw new Error(`campaign virou 'Humano (rep)':\n${section}`);
});
test("outbound source='app' (rep no inbox) → rótulo 'Humano (rep)'", () => {
  const section = renderHistory(ctxWithOutbound("app"));
  if (!section.includes('Humano (rep): "')) throw new Error(`esperava 'Humano (rep)':\n${section}`);
});
test("outbound source='api' (IA/integração) → rótulo 'Bot/sistema'", () => {
  const section = renderHistory(ctxWithOutbound("api"));
  if (!section.includes('Bot/sistema: "')) throw new Error(`esperava 'Bot/sistema':\n${section}`);
});
test("inbound → rótulo 'Lead'", () => {
  const c = emptyContext();
  c.recent_messages = [{ direction: "inbound", body: "oi", dateAdded: "2026-06-10T12:00:00Z" }];
  const section = renderHistory(c);
  if (!section.includes('Lead: "oi"')) throw new Error(`esperava 'Lead':\n${section}`);
});

console.log("\nParidade webhook(F51) ↔ ladder(F52) — conjunto de fontes (Fix 2026-06-10):");

// Trava anti-divergência: o early-return do webhook (branch outbound de
// inbound-message/route.ts) usa NON_HUMAN_SOURCES.has(source); o discriminador 1
// do classifyLastOutbound (F52) usa AUTOMATION_SOURCES. Antes do fix o webhook
// tinha lista inline estreita (api|workflow) e furava campaign/bulk/automation/
// scheduled — pausava a IA em TODO lead novo (welcome de campanha). Agora ambos
// leem a MESMA base de @/lib/ghl/message-sources; estes asserts garantem que não
// voltem a divergir no conjunto de fontes.

// Espelha a predicate inline do route (branch outbound): String → lower → .has.
const webhookEarlyReturns = (src: string) =>
  NON_HUMAN_SOURCES.has(String(src).toLowerCase());

test("NON_HUMAN_SOURCES === AUTOMATION_SOURCES ∪ {'api'} (sem drift de set)", () => {
  eq([...NON_HUMAN_SOURCES].sort(), [...new Set([...AUTOMATION_SOURCES, "api"])].sort());
  // "api" é não-humano mas NÃO é automação (a IA envia por ela; o F52 a pega via
  // anti-eco, não pelo set). Asserta a assimetria intencional.
  eq(AUTOMATION_SOURCES.has("api"), false);
});

test("toda fonte de automação: webhook early-returns E ladder classifica não-humano", () => {
  for (const src of AUTOMATION_SOURCES) {
    // pior caso F56: welcome de automação carimbado com o userId do admin.
    const { isHuman } = classifyLastOutbound({
      lastOutbound: { source: src, body: "Seja bem-vindo!", userId: "u_admin" },
      aiTexts: [],
    });
    eq(isHuman, false, `ladder deveria classificar '${src}' como NÃO humano`);
    eq(webhookEarlyReturns(src), true, `webhook deveria early-return em '${src}'`);
    // case-insensitive: mesma conclusão em UPPER (welcome real chega variado).
    eq(webhookEarlyReturns(src.toUpperCase()), true, `webhook case-insensitive falhou em '${src}'`);
  }
});

test("'api' (IA/integração): webhook early-returns (F52 trata via anti-eco)", () =>
  eq(webhookEarlyReturns("api"), true));

test("'app' (rep no inbox) NÃO early-returns → segue pro anti-eco do webhook", () =>
  eq(webhookEarlyReturns("app"), false));

test("source desconhecido/vazio NÃO early-returns → segue pro anti-eco", () => {
  eq(webhookEarlyReturns(""), false);
  eq(webhookEarlyReturns("custom_thing"), false);
});

console.log("\nlead-history cache invalidate:");

test("invalidateLeadHistoryCache não throw", () => {
  invalidateLeadHistoryCache("c1");
  invalidateLeadHistoryCache("");
});

console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
process.exit(failed > 0 ? 1 : 0);
