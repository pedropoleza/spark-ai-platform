/**
 * Unit test do anti-repeat guard (F57). Roda a detecção pura (sem LLM/DB).
 * Uso: npx tsx scripts/test-repeat-guard.ts
 */
import {
  normalizeForRepeat,
  isNearDuplicate,
  findBotEcho,
} from "../src/lib/account-assistant/core/repeat-guard";
import type { LLMMessage } from "../src/lib/account-assistant/llm-client";

let pass = 0;
let fail = 0;
function eq(name: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    fail++;
    console.log(`❌ ${name}\n   esperado: ${JSON.stringify(expected)}\n   recebido: ${JSON.stringify(actual)}`);
  }
}

// Mensagens reais dos casos de prod
const APOLOGY =
  "Na real, ainda não consegui concluir isso aqui - não quero te dizer que fiz algo que não foi feito. Pode confirmar pra eu tentar de novo?";
const CONFIRM =
  "Marcar com *Thad Gourley*, seg 08/06 às 3:00 PM, no *1.1 - First Meeting*, com você. Confirma?\n\n1. Confirmar ✅\n2. Editar ✏️";
const NOTE_FOLLOWUP = "Nota salva na *Maria Gouveia Nobre*. Quer criar um follow-up pra quando ela voltar da Europa?";

const A = (content: string): LLMMessage => ({ role: "assistant", content });
const U = (content: string): LLMMessage => ({ role: "user", content });

// 1. Eco verbatim exato (caso Sieder)
eq("apology echo verbatim → detecta", findBotEcho(APOLOGY, [A(APOLOGY), U("Sim")]) !== null, true);

// 2. present_options confirm repetido (caso Soraia) — com user no meio
eq(
  "confirm menu repetido → detecta",
  findBotEcho(CONFIRM, [A(CONFIRM), U("A mensagem não foi para o cliente")]) !== null,
  true,
);

// 3. "Nota salva ... follow-up?" repetido (caso Soraia 2)
eq("nota+followup repetido → detecta", findBotEcho(NOTE_FOLLOWUP, [A(NOTE_FOLLOWUP), U("Obrigada")]) !== null, true);

// 4. Ack curto repetido → NÃO detecta (abaixo do MIN_REPEAT_LEN)
eq("ack curto 'Beleza! 😊' repetido → ignora", findBotEcho("Beleza! 😊", [A("Beleza! 😊"), U("ok")]), null);
eq("ack curto 'Feito!' repetido → ignora", findBotEcho("Feito!", [A("Feito!")]), null);

// 5. Mensagens diferentes → NÃO detecta
eq(
  "mensagens diferentes → ignora",
  findBotEcho("Qual o nome completo do contato?", [A(APOLOGY), U("sei lá")]),
  null,
);

// 6. Near-dup: bot adiciona 1 frase curta (>90% contido) → detecta
const CONFIRM_PLUS = CONFIRM + "\n\nÉ pra confirmar?";
eq("near-dup (confirm + frase) → detecta", isNearDuplicate(CONFIRM, CONFIRM_PLUS), true);

// 7. Eco 2 turnos atrás (A-B-A) com lookback=2 → detecta
eq(
  "eco A-B-A (2 atrás) → detecta",
  findBotEcho(APOLOGY, [A(APOLOGY), U("o que?"), A("Deixa eu ver aqui..."), U("e aí?")], 2) !== null,
  true,
);

// 8. Diferença só de emoji/acento/travessão NÃO esconde o eco
const CONFIRM_NOEMOJI = "Marcar com Thad Gourley, seg 08/06 as 3:00 PM, no 1.1 - First Meeting, com voce. Confirma? 1. Confirmar 2. Editar";
eq("emoji/acento não escondem eco", isNearDuplicate(CONFIRM, CONFIRM_NOEMOJI), true);

// 9. normalize sanity
eq("normalize tira espaços/pontuação/acento", normalizeForRepeat("Olá, MUNDO! 😊"), "olamundo");

// 10. histórico sem msg do assistant → null
eq("sem assistant no histórico → null", findBotEcho(APOLOGY, [U("oi"), U("tudo bem?")]), null);

console.log(`\n${pass} passaram, ${fail} falharam`);
process.exit(fail === 0 ? 0 : 1);
