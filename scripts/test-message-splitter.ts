/**
 * Testa o splitter determinístico de saída lead-facing (healthcheck 2026-07-23,
 * caso "five star ricos" — walls of text de 700-800 chars numa bolha só).
 *   npx tsx -r tsconfig-paths/register scripts/test-message-splitter.ts
 */
import {
  splitLeadOutbound,
  splitLongBubble,
  condenseFollowUp,
  FOLLOWUP_MAX_CHARS,
  SPLIT_TRIGGER_CHARS,
} from "@/lib/ai/message-splitter";

let pass = 0;
let fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// Conta chars "significativos" (sem espaços) pra provar que nada se perdeu.
const sig = (s: string) => s.replace(/\s/g, "");
const noLoss = (input: string, out: string[]) =>
  sig(out.join("")) === sig(input);

// ── Caso real de prod (787 chars, a maior mensagem do location afetado) ──────
const REAL_787 =
  "Entendi! Então é pra uma outra pessoa, né? Deixa eu te explicar por cima. " +
  "O seguro que a gente trabalha é seguro de vida, diferente do plano de saúde " +
  "(convênio/hospital). São coisas separadas e que se complementam bem. A diferença " +
  "principal é que esse seguro de vida tem o que chamamos de benefício em vida: se a " +
  "pessoa tiver um diagnóstico grave (câncer, ataque cardíaco, derrame, entre outros " +
  "previstos em contrato), ela pode acessar parte do valor do seguro ainda em vida, " +
  "pra usar como precisar, seja pra tratamento, pra despesas do dia a dia ou pra " +
  "qualquer outra coisa. É uma proteção que serve tanto pra família no futuro quanto " +
  "pra própria pessoa se algo grave acontecer antes. Faz sentido pra você?";

console.log(`\n[Caso real de prod — ${REAL_787.length} chars]`);
let r = splitLeadOutbound([REAL_787]);
check("wall real foi quebrado em >1 bolha", r.messages.length > 1, `${r.messages.length} bolhas`);
check("didSplit=true", r.didSplit);
check("nenhuma bolha resultante passa do gatilho", r.messages.every((m) => m.length <= SPLIT_TRIGGER_CHARS), r.messages.map((m) => m.length).join(","));
check("zero perda de conteúdo", noLoss(REAL_787, r.messages));
check("não corta no meio de palavra (bolha termina em pontuação ou palavra inteira)", r.messages.every((m) => /[.!?…)a-zà-ÿ]$/i.test(m.trim())));

// ── Mensagem curta passa intacta (paridade) ─────────────────────────────────
console.log("\n[Curtas — passam intactas]");
r = splitLeadOutbound(["Oi! Tudo bem? 😊"]);
check("curta única intacta", r.messages.length === 1 && r.messages[0] === "Oi! Tudo bem? 😊");
check("didSplit=false na curta", r.didSplit === false);

r = splitLeadOutbound(["Primeira bolha curta.", "Segunda bolha curta."]);
check("array de curtas preservado (2 bolhas)", r.messages.length === 2 && !r.didSplit);

// Bolha exatamente no limite não quebra
const atLimit = "a".repeat(SPLIT_TRIGGER_CHARS);
check("no limite exato não quebra", splitLongBubble(atLimit).length === 1);
check("1 char acima do limite quebra (ou tenta)", splitLongBubble("a".repeat(SPLIT_TRIGGER_CHARS) + " b c").length >= 1);

// ── Parágrafo longo SEM pontuação (fallback hard-split por espaço) ───────────
console.log("\n[Parágrafo corrido sem pontuação — fallback por espaço]");
const noPunct = Array.from({ length: 200 }, (_, i) => `palavra${i}`).join(" ");
r = splitLeadOutbound([noPunct]);
check("parágrafo sem pontuação foi quebrado", r.messages.length > 1, `${r.messages.length} bolhas`);
check("sem pontuação: zero perda", noLoss(noPunct, r.messages));
check("sem pontuação: nenhuma palavra partida ao meio", r.messages.every((m) => /^palavra/.test(m.trim()) && /palavra\d+$/.test(m.trim())));

// ── Teto de bolhas: excedente fundido, nunca descartado (H52) ────────────────
console.log("\n[Teto de bolhas — funde, não descarta]");
// 12 frases de ~250 chars cada → muitos chunks → tem que cap em 5 fundindo o resto
const bigSentence = "Esta é uma frase de exemplo com bastante conteúdo pra ocupar espaço e forçar a quebra em várias bolhas distintas no teste. ".repeat(1);
const many = Array.from({ length: 12 }, (_, i) => `${bigSentence}Item numero ${i}.`).join(" ");
r = splitLeadOutbound([many]);
check("respeita teto de 5 bolhas", r.messages.length <= 5, `${r.messages.length} bolhas`);
check("teto: zero perda (excedente fundido na última)", noLoss(many, r.messages));

// ── Vazio / whitespace ──────────────────────────────────────────────────────
console.log("\n[Bordas]");
check("string vazia → []", splitLongBubble("").length === 0);
check("só espaços → []", splitLongBubble("   \n  ").length === 0);
r = splitLeadOutbound(["", "  ", "Conteúdo real."]);
check("array com vazios → só o real sobra", r.messages.length === 1 && r.messages[0] === "Conteúdo real.");

// ── Quebras de linha explícitas viram fronteiras ────────────────────────────
console.log("\n[Quebras de linha]");
const withNewlines = "Primeira ideia importante aqui.\n\nSegunda ideia também relevante.\n\nTerceira e última ideia do bloco.".repeat(7);
r = splitLeadOutbound([withNewlines]);
check("texto com \\n\\n longo é quebrado", r.messages.length > 1);
check("newlines: zero perda", noLoss(withNewlines, r.messages));

// ── condenseFollowUp: follow-up curto e certeiro (caso five star ricos) ──────
console.log("\n[condenseFollowUp — follow-up curto]");
// Curto passa intacto (a maioria dos follow-ups reais: 90-160 chars)
const shortFu = "Oi Nancy, ficou pendente sua data de nascimento, pode me passar? 😊";
check("follow-up curto passa intacto", condenseFollowUp(shortFu) === shortFu);
check("exemplo da cliente (~75 chars) intacto", condenseFollowUp("Olá, pode mandar os dados pra gente preparar uma cotação pra você analisar?").length <= FOLLOWUP_MAX_CHARS);

// Longo com hedging é condensado, mantendo frase(s) inteira(s) e o pedido
const longFu =
  "Oi Paulo, só um último toque por aqui. Ainda tenho interesse em te ajudar com a proteção, mas não quero ser inconveniente. Se quiser continuar, é só me mandar seu nome completo, data de nascimento, estado onde mora e se é fumante. Se não for o momento, tudo bem também, sem pressão nenhuma, fico à disposição quando quiser.";
const condensed = condenseFollowUp(longFu);
check("follow-up longo foi condensado", condensed.length < longFu.length, `${longFu.length}→${condensed.length}`);
check("condensado dentro do budget", condensed.length <= FOLLOWUP_MAX_CHARS, `${condensed.length}`);
check("condensado começa com a 1ª frase (não corta no meio)", longFu.startsWith(condensed.split(/(?<=[.!?])\s/)[0]));
check("condensado termina em pontuação (frase inteira)", /[.!?…]$/.test(condensed.trim()));

// Frase única gigante sem ponto → corte por espaço (garante algo, sem estourar)
const oneGiant = "Oi " + "palavra ".repeat(80).trim();
check("frase única gigante fica no budget", condenseFollowUp(oneGiant).length <= FOLLOWUP_MAX_CHARS);
check("frase única gigante não parte palavra", /\w$/.test(condenseFollowUp(oneGiant)));

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass} passaram, ${fail} falharam\n`);
process.exit(fail === 0 ? 0 : 1);
