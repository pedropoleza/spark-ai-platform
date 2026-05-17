// Validação rápida do detector pós fix H32.7 (negation/preview check)
// Roda com: npx tsx -r tsconfig-paths/register scripts/test-hallucination-detector.ts

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

// Import detector — não exportado, vou recriar inline pra teste
// (Alternativa: exportar de processor.ts; por enquanto re-implementa)

const HALLUCINATION_PATTERNS: Array<{
  family: string;
  regex: RegExp;
  satisfying_tools: string[];
}> = [
  {
    family: "opportunity",
    regex:
      /\b(oportunidade|opp|opportunity|deal|neg[oó]cio|pipeline)\s+(criad[ao]|adicionad[ao]|atualizad[ao]|movid[ao]|deletad[ao]|fechad[ao]|trocad[ao]|atribu[ií]d[ao])s?\b/i,
    satisfying_tools: ["create_opportunity"],
  },
  {
    family: "message",
    regex:
      /\b(mensagem|msg|mensagens|msgs)\s+(enviad[ao]|mandad[ao]|dispar[aá]d[ao]|agendad[ao]|cancelad[ao])s?\b/i,
    satisfying_tools: ["send_message_to_contact"],
  },
  {
    family: "reminder",
    regex: /\blembrete\s+(agendado|marcado|criado|salvo|cancelado|removido)s?\b/i,
    satisfying_tools: ["schedule_reminder"],
  },
  {
    family: "note",
    regex:
      /\b(nota\s+(salva|criada|adicionada)|salvei\s+a\s+nota|salvei.*como\s+nota)\b/i,
    satisfying_tools: ["create_note"],
  },
];

const GENERIC_WRITE_VERB_REGEX =
  /\b(criei|criamos|agendei|agendamos|marquei|marcamos|salvei|salvamos|anotei|anotamos)\b/i;

function isNegatedOrPreviewContext(text: string, matchIndex: number): boolean {
  const lookBehind = text.slice(Math.max(0, matchIndex - 80), matchIndex).toLowerCase();
  if (lookBehind.length === 0) return false;
  if (/\b(n[aã]o|nenhum[ao]?|jamais|nunca)\s+(automaticamente\s+|ainda\s+|mais\s+|tem\s+|tenho\s+|temos\s+|h[aá]\s+|existe\s+|existem\s+|nenhum[ao]?\s+)?[\w\s,]{0,15}$/i.test(lookBehind)) return true;
  if (/\b(n[aã]o\s+(tem|tenho|temos|h[aá]|existe|existem|preciso|consegui|consigo|d[aá]|posso)|sem\s+nenhum[ao]?|nem\s+)[\w\s,]{0,60}$/i.test(lookBehind)) return true;
  if (/(mensagem|texto|template|preview)\s+(que\s+)?(vai|ser[aá]|vou)\s+[\w\s,]{0,30}$/i.test(lookBehind)) return true;
  if (/(disparo|mensagem|texto)\s+(que\s+(vou\s+)?(mandar|enviar|disparar|ser[aá]|vai))/i.test(lookBehind)) return true;
  if (/\b(que|os\s+que|disparos?\s+que|tarefas?\s+que|notas?\s+que|reuni[aã]o\s+que)\s+(j[aá]\s+)?$/i.test(lookBehind)) return true;
  return false;
}

function detect(text: string, toolsCalled: string[]) {
  const found: Array<{ family: string; matched_text: string; detector: string }> = [];
  for (const pattern of HALLUCINATION_PATTERNS) {
    const match = text.match(pattern.regex);
    if (!match) continue;
    if (match.index !== undefined && isNegatedOrPreviewContext(text, match.index)) continue;
    const hasTool = pattern.satisfying_tools.some((t) => toolsCalled.includes(t));
    if (!hasTool) found.push({ family: pattern.family, matched_text: match[0], detector: "specific" });
  }
  const generic = text.match(GENERIC_WRITE_VERB_REGEX);
  if (generic && generic.index !== undefined) {
    if (!isNegatedOrPreviewContext(text, generic.index)) {
      if (toolsCalled.length === 0) {
        const dup = found.some((f) => f.matched_text === generic[0]);
        if (!dup) found.push({ family: "generic_write", matched_text: generic[0], detector: "generic" });
      }
    }
  }
  return found;
}

// === Casos reais do admin_signals ===
const cases: Array<{ name: string; text: string; tools: string[]; expect: "hit" | "skip"; reason: string }> = [
  {
    name: "REAL #1 — Gustavo lembrete sem tool",
    text: "Ótimo! Lembrete agendado pra amanhã às *9:00 AM* (Florida — EDT)",
    tools: [],
    expect: "hit",
    reason: "Real hallucination — bot falou agendou mas tools=[]",
  },
  {
    name: "REAL #2 — salvei policy como nota sem tool",
    text: "Entendo. eu salvei o policy number como nota no contato, mas não preenchi os custom fields",
    tools: [],
    expect: "hit",
    reason: "Real — 'salvei como nota' sem create_note",
  },
  {
    name: "FALSO POSITIVO #1 — Henry não tem oportunidade criada",
    text: "O Henry não tem oportunidade criada ainda no pipeline 1- Prospects",
    tools: [],
    expect: "skip",
    reason: "Negação 'não tem' antes",
  },
  {
    name: "FALSO POSITIVO #2 — não tem nenhuma mensagens agendadas",
    text: "Não tem nenhum job de disparo ativo nem mensagens agendadas pendentes no sistema",
    tools: [],
    expect: "skip",
    reason: "Negação 'nem mensagens agendadas' (continuação de não tem)",
  },
  {
    name: "FALSO POSITIVO #3 — Não criei lembrete recorrente",
    text: "Não automaticamente — eu não criei nenhum lembrete recorrente ainda",
    tools: [],
    expect: "skip",
    reason: "Negação 'não criei'",
  },
  {
    name: "FALSO POSITIVO #4 — disparos que agendamos",
    text: "Vejo que os dois disparos que agendamos já estão ativos no sistema",
    tools: ["preview_bulk_message_v2"],
    expect: "skip",
    reason: "Referência ao passado conjunto 'disparos que agendamos'",
  },
  {
    name: "FALSO POSITIVO #5 — preview template Agendamos",
    text: "Mensagem que vai ser enviada: 'Olá, Agendamos pra terça reunião'",
    tools: [],
    expect: "skip",
    reason: "Preview de template 'mensagem que vai ser enviada'",
  },
  {
    name: "REAL #3 — criei sem tool",
    text: "Pronto! Criei o lembrete pra você, vou te avisar amanhã.",
    tools: [],
    expect: "hit",
    reason: "Bot disse criei sem chamar tool",
  },
];

let pass = 0;
let fail = 0;
console.log("=== Testando detector pós H32.7 (negation/preview check) ===\n");

for (const c of cases) {
  const result = detect(c.text, c.tools);
  const hit = result.length > 0;
  const expected = c.expect === "hit";
  const ok = hit === expected;
  const icon = ok ? "✅" : "❌";
  console.log(`${icon} ${c.name}`);
  console.log(`   Expect: ${c.expect}, Got: ${hit ? "hit" : "skip"} (${result.length} matches)`);
  console.log(`   Why: ${c.reason}`);
  if (!ok) {
    console.log(`   Text: "${c.text}"`);
    console.log(`   Matches: ${JSON.stringify(result)}`);
    fail++;
  } else {
    pass++;
  }
  console.log("");
}

console.log(`\nTotal: ${pass}/${pass + fail} (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
