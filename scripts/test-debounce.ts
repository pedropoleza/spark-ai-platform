/**
 * Golden suite da lógica pura do debounce (core/debounce.ts resolveBurstTurn).
 * Run: npx tsx -r tsconfig-paths/register scripts/test-debounce.ts
 */
import { resolveBurstTurn, type ChronoMessage } from "@/lib/account-assistant/core/debounce";
import type { RepInput } from "@/types/account-assistant";

let pass = 0;
let total = 0;
function check(name: string, cond: boolean, detail?: string) {
  total++;
  if (cond) {
    pass++;
    console.log(`✅ ${name}`);
  } else {
    console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const txt = (t: string): RepInput => ({ kind: "text", text: t });
const media = (): RepInput =>
  ({ kind: "tabular", tabular: { filename: "f.csv", columns: [], total_rows: 0, rows: [] } }) as RepInput;

// 1. Rajada de 3 textos, sem agente antes → combina os 3, histórico vazio
{
  const chrono: ChronoMessage[] = [
    { role: "user", content: "a" },
    { role: "user", content: "b" },
    { role: "user", content: "c" },
  ];
  const r = resolveBurstTurn(chrono, true, txt("c"));
  check("rajada 3: combina a\\nb\\nc", r.input.kind === "text" && (r.input as { text: string }).text === "a\nb\nc");
  check("rajada 3: histórico vazio", r.history.length === 0);
}

// 2. Rajada após resposta do agente → combina só o run final; histórico até o agente
{
  const chrono: ChronoMessage[] = [
    { role: "user", content: "old" },
    { role: "agent", content: "reply" },
    { role: "user", content: "x" },
    { role: "user", content: "y" },
  ];
  const r = resolveBurstTurn(chrono, true, txt("y"));
  check("após-agente: combina x\\ny", (r.input as { text: string }).text === "x\ny");
  check("após-agente: histórico = [old, reply]", r.history.length === 2);
  check("após-agente: reply vira assistant", r.history[1].role === "assistant" && r.history[1].content === "reply");
}

// 3. Texto único → não combina; histórico = antes dele
{
  const chrono: ChronoMessage[] = [
    { role: "agent", content: "hi" },
    { role: "user", content: "single" },
  ];
  const fb = txt("single");
  const r = resolveBurstTurn(chrono, true, fb);
  check("único: input = fallback (não combinou)", r.input === fb);
  check("único: histórico = [hi]", r.history.length === 1 && r.history[0].role === "assistant");
}

// 4. Mídia atual → input = mídia; histórico exclui só a atual
{
  const chrono: ChronoMessage[] = [
    { role: "agent", content: "hi" },
    { role: "user", content: "📊 f.csv (0 linhas)" },
  ];
  const fb = media();
  const r = resolveBurstTurn(chrono, false, fb);
  check("mídia: input = mídia", r.input.kind === "tabular");
  check("mídia: histórico = [hi]", r.history.length === 1);
}

// 5. Mídia com texto anterior não-respondido → texto FICA no histórico
{
  const chrono: ChronoMessage[] = [
    { role: "user", content: "text before" },
    { role: "user", content: "📎 file" },
  ];
  const r = resolveBurstTurn(chrono, false, media());
  check("mídia+texto: input = mídia", r.input.kind === "tabular");
  check("mídia+texto: texto anterior fica no histórico", r.history.length === 1 && r.history[0].content === "text before");
}

// 6. Histórico vazio (texto) → fallback, sem histórico
{
  const fb = txt("x");
  const r = resolveBurstTurn([], true, fb);
  check("vazio: input = fallback", r.input === fb);
  check("vazio: histórico vazio", r.history.length === 0);
}

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
