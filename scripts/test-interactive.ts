/**
 * Golden suite da camada interativa (core/interactive.ts):
 * extractInteractiveFromToolCalls + interactiveFallbackText.
 * Run: npx tsx -r tsconfig-paths/register scripts/test-interactive.ts
 */
import {
  extractInteractiveFromToolCalls,
  detectNumberedOptionsFallback,
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

// 3b. rótulo longo (>20) → lista mesmo com 2 opções (caso calendários 15:34)
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", {
      body: "Qual calendário?",
      options: [
        { id: "c1", label: "Client Appointment - Spark Leads" },
        { id: "c2", label: "Onboarding Spark Leads" },
      ],
    }),
  ]);
  check("rótulo longo → lista", p?.kind === "list", p?.kind);
}

// 3c. opção com descrição → lista (mesmo com ≤3) — desambiguação de contato
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", {
      body: "Qual contato?",
      options: [
        { id: "1", label: "João", description: "+55 11 99999" },
        { id: "2", label: "Maria" },
      ],
    }),
  ]);
  check("descrição → lista", p?.kind === "list");
}

// 3d. ≤3 curtas sem descrição → botões
{
  const p = extractInteractiveFromToolCalls([
    tc("present_options", {
      body: "Confirma?",
      options: [
        { id: "y", label: "Sim" },
        { id: "n", label: "Não" },
      ],
    }),
  ]);
  check("≤3 curtas → botões", p?.kind === "buttons");
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

// 10. BACKSTOP — caso real 03:21:47 (Pedro pediu "lista" e veio texto numerado)
{
  const bk = detectNumberedOptionsFallback(
    "Qual pipeline quer usar?\n\n1. *1- Prospects* — stage *In Contact*\n2. *Prospecting* — stage *In Contact*\n\nQual dos dois?",
  );
  check("backstop: caso 03:21 → lista", bk?.kind === "list", bk?.kind);
  check("backstop: 2 opções", bk?.options.length === 2);
  check("backstop: body tem 'pipeline'", !!bk && bk.body.toLowerCase().includes("pipeline"));
  check("backstop: label sem *", !!bk && !bk.options[0].label.includes("*"));
}

// 11. BACKSTOP — lista INFORMATIVA (sem cue) NÃO converte
{
  const bk = detectNumberedOptionsFallback(
    "Fiz 3 coisas hoje:\n1. movi a opp\n2. criei a nota\n3. mandei o follow-up",
  );
  check("backstop: informativa (sem cue) → null", bk === null);
}

// 12. BACKSTOP — <2 itens → null
{
  check("backstop: 1 item → null", detectNumberedOptionsFallback("1. só isso\nqual?") === null);
}

// 13. BACKSTOP — curtas + cue → botões
{
  const bk = detectNumberedOptionsFallback("Qual horário?\n1. 13:30\n2. 14:00\n3. 15:30");
  check("backstop: curtas → botões", bk?.kind === "buttons");
  check("backstop: 3 opções", bk?.options.length === 3);
}

console.log(`\n${pass}/${total} PASS`);
process.exit(pass === total ? 0 : 1);
