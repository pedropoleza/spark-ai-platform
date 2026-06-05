/**
 * Syntax-check do loader injetado no GHL (GU-7 + anteriores). O código-cliente
 * vive dentro de um template literal no route.ts — um erro de escape quebraria
 * TODO o loader (servido via new Function). Aqui a gente renderiza o JS final e
 * parseia com `new Function` (parseia o corpo SEM executar) pra pegar erro de
 * sintaxe ANTES do deploy.
 * Uso: npx tsx scripts/verify-loader.ts
 */
import { GET } from "../src/app/embed/sparkbot/loader/route";

async function main() {
  const res = await GET();
  const text = await res.text();
  // Parseia o corpo sem executar (Function constructor lança SyntaxError se inválido).
  // eslint-disable-next-line @typescript-eslint/no-implied-eval, no-new-func
  new Function(text);
  // Sanidade: as funções-chave do GU-7 têm que estar no bundle.
  const must = [
    "acTogglePopup",
    "acActivateAgent",
    "acFetchAgents",
    "contact-agents",
    "contact-activate",
    "sap-pop-item",
  ];
  const missing = must.filter((m) => !text.includes(m));
  if (missing.length) {
    console.error("❌ loader compila mas faltam símbolos:", missing.join(", "));
    process.exit(1);
  }
  console.log("✅ loader OK — sintaxe válida, " + text.length + " bytes, GU-7 presente");
}

main().catch((e) => {
  console.error("❌ loader INVÁLIDO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
