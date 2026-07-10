/**
 * Testes puros do H47-F2 (tap determinístico + listas legíveis, 2026-07-10).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-interactive-fixes.ts
 */
import { smartRowTitle } from "@/lib/account-assistant/webhook/stevo-send";
import {
  detectNumberedOptionsFallback,
  extractInteractiveFromToolCalls,
} from "@/lib/account-assistant/core/interactive";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`✅ ${name}`); }
  else { fail++; console.log(`❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

// ── smartRowTitle ──
ok("nome curto passa intacto", smartRowTitle("Victor Alves", 24) === "Victor Alves");
{
  const t = smartRowTitle("Maria Aparecida do Nascimento", 24);
  ok("nome longo preserva último sobrenome", t.includes("Nascimento"), t);
  ok("nome longo respeita cap 24", Array.from(t).length <= 24, t);
}
{
  const t = smartRowTitle("Forçar 4 PM mesmo assim ✅ agora", 24);
  ok("label não-nome cai no truncate normal", Array.from(t).length <= 24 && t.endsWith("…"), t);
}
ok("2 tokens não tenta compactar", smartRowTitle("Thalysson Vasconcellos Albuquerque", 24).includes("Albuquerque"));

// ── backstop split label/description ──
{
  const p = detectNumberedOptionsFallback(
    "Qual dos contatos?\n1. Maria Aparecida do Nascimento — +55 11 98888-7777\n2. Maria Aparecida do Norte · maria@x.com",
  );
  ok("backstop converte", !!p);
  ok("backstop separa label", p?.options[0].label === "Maria Aparecida do Nascimento", p?.options[0].label);
  ok("backstop preserva telefone na description", p?.options[0].description === "+55 11 98888-7777", p?.options[0].description);
  ok("backstop separa por ·", p?.options[1].description === "maria@x.com", p?.options[1].description);
  ok("description força lista", p?.kind === "list");
}
{
  const p = detectNumberedOptionsFallback("Escolhe:\n1. Sim\n2. Não");
  ok("sem separador → sem description", !!p && !p.options[0].description);
}

// ── contact_id no present_options ──
{
  const p = extractInteractiveFromToolCalls([
    {
      name: "present_options",
      input: {
        body: "Qual João?",
        options: [
          { id: "c1", label: "João Silva", description: "+55 11 9", contact_id: "GHL123" },
          { id: "c2", label: "João Souza" },
        ],
      },
    },
  ]);
  ok("extract mantém contact_id", p?.options[0].contact_id === "GHL123");
  ok("opção sem contact_id fica undefined", p?.options[1].contact_id === undefined);
}

console.log(`\n${pass}/${pass + fail} OK`);
process.exit(fail > 0 ? 1 : 0);
