/**
 * Golden suite da camada interativa (core/interactive.ts):
 * extractInteractiveFromToolCalls + interactiveFallbackText.
 * Run: npx tsx -r tsconfig-paths/register scripts/test-interactive.ts
 */
import {
  extractInteractiveFromToolCalls,
  interactiveFallbackText,
} from "@/lib/account-assistant/core/interactive";

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

const tc = (name: string, input: Record<string, unknown>) => ({ name, input, result: { status: "ok" } });

// 1. ≤3 opções → buttons
{
  const p = extractInteractiveFromToolCalls([
    tc("search_contacts", { q: "joao" }),
    tc("present_options", {
      body: "Vou criar a nota. Confirma?",
      options: [
        { id: "confirm", label: "Confirmar ✅" },
        { id: "cancel", label: "Cancelar ❌" },
      ],
    }),
  ]);
  check("buttons: payload != null", p !== null);
  check("buttons: kind=buttons", p?.kind === "buttons");
  check("buttons: body", p?.body === "Vou criar a nota. Confirma?");
  check("buttons: 2 opções", p?.options.length === 2);
  check("buttons: ids", p?.options[0].id === "confirm" && p?.options[1].id === "cancel");
}

// 2. 4+ opções → list
{
  const opts = Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: `Opção ${i}` }));
  const p = extractInteractiveFromToolCalls([tc("present_options", { body: "Qual?", options: opts })]);
  check("list: kind=list (5 opções)", p?.kind === "list");
  check("list: 5 opções", p?.options.length === 5);
}

// 3. style override (force list com 2 opções)
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", { body: "x", style: "list", options: [{ id: "a", label: "A" }, { id: "b", label: "B" }] }),
  ]);
  check("style: force list", p?.kind === "list");
}

// 4. sem present_options → null
{
  const p = extractInteractiveFromToolCalls([tc("create_note", { body: "oi" })]);
  check("sem present_options → null", p === null);
}

// 5. body vazio → null
{
  const p = extractInteractiveFromToolCalls([tc("present_options", { body: "", options: [{ id: "a", label: "A" }] })]);
  check("body vazio → null", p === null);
}

// 6. opções inválidas filtradas (sem id ou label)
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", {
      body: "x",
      options: [{ id: "a", label: "A" }, { id: "", label: "X" }, { id: "c", label: "" }],
    }),
  ]);
  check("filtra opções inválidas", p?.options.length === 1 && p?.options[0].id === "a");
}

// 7. última present_options vence
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", { body: "primeira", options: [{ id: "a", label: "A" }] }),
    tc("present_options", { body: "segunda", options: [{ id: "b", label: "B" }] }),
  ]);
  check("última present_options vence", p?.body === "segunda");
}

// 8. fallback text — corpo + opções numeradas
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", {
      title: "Confirmação",
      body: "Vou criar a nota. Confirma?",
      options: [
        { id: "confirm", label: "Confirmar ✅" },
        { id: "cancel", label: "Cancelar ❌" },
      ],
    }),
  ])!;
  const txt = interactiveFallbackText(p);
  check("fallback: tem o body", txt.includes("Vou criar a nota. Confirma?"));
  check("fallback: tem o título", txt.includes("Confirmação"));
  check("fallback: opção numerada 1", txt.includes("1. Confirmar ✅"));
  check("fallback: opção numerada 2", txt.includes("2. Cancelar ❌"));
}

// 9. fallback com descrição
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", {
      body: "Qual contato?",
      options: [{ id: "c1", label: "João Silva", description: "joao@x.com" }],
    }),
  ])!;
  const txt = interactiveFallbackText(p);
  check("fallback: inclui descrição", txt.includes("João Silva — joao@x.com"));
}

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
