/**
 * Manu (Support / pré-venda, agente 3976b4b6) — trava anti-invenção de curso,
 * material e valor. Pedido do Pedro em 2026-08-29.
 *
 * O QUE ACONTECIA: a Manu ofereceu "curso de pré-licença com desconto especial"
 * a 5 contatos desde 03/08 e em 25/08 cravou valores ("começa em torno de $50,
 * originalmente $199"). Nada disso existe em NENHUMA fonte de config dela
 * (instruções, exemplos, KB, override) — é invenção do modelo.
 *
 * DE ONDE VEM: o bloco "# PROVA PRO CÉTICO" autoriza "já peço pro time te mandar
 * o material oficial" (então o modelo aprendeu que PODE oferecer material) e o
 * "# CUSTO DA LICENÇA" só proíbe valor no contexto da LICENÇA. Curso ficou em
 * terra de ninguém e o modelo preencheu com conhecimento de mercado (curso de
 * pré-licença nos EUA custa mesmo perto de $199).
 *
 * ONDE ENTRA: dentro do "# CUSTO DA LICENÇA", posição ~4085 de um prompt que o
 * builder corta em 8000 — ou seja, É LIDO. Bloco novo no fim seria descartado.
 *
 * COMPENSAÇÃO DE TAMANHO: a CI já tem 9123 chars (1123 acima do teto). Pra não
 * empurrar mais nada pro corte, o script remove redundância PURA junto — nenhuma
 * regra some, só exemplos e uma duplicata.
 *
 *   npx tsx scripts/apply-manu-anti-curso.ts [--dry] [--revert]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const MANU = "3976b4b6-0345-4f25-b964-138bb7960058";
const REVERT = process.argv.includes("--revert");
const DRY = process.argv.includes("--dry");
const MARCADOR = "(v-anticurso 2026-08-29)";

const ANCORA = "Dinheiro SEMPRE recebe resposta.";
const NOVO =
  ANCORA +
  ' NÃO existe curso, material nem desconto pra você oferecer: quem explica licença, curso e valores é a Marina NO ENCONTRO. PROIBIDO oferecer/mencionar curso, material ou desconto, e PROIBIDO citar QUALQUER valor em dólar. Perguntou? 1 linha ("é processo oficial do estado, a Marina explica no encontro") e volta pro agendamento. ' +
  MARCADOR;

// Redundância pura — a REGRA fica em todos os casos, saem só exemplos/duplicata.
const CORTES: Array<[string, string]> = [
  // regra de URL duplicada (idêntica no item 7 do BLOCO ENCONTRO, também lido)
  [" NUNCA escreva chaves { } nem invente URL.", ""],
  // exemplos da regra de fundação/idade
  ['nem fundação/idade ("X anos"/"desde 18xx"/"mais de X anos")', "nem fundação/idade"],
  // exemplos da regra de dedução de nome por email
  [' (carlos@... ≠ "Carlos"; camila.rn@... ≠ "Camila")', ""],
  // lista de fusos como exemplo (a regra "não converta" fica)
  [" (Arizona/Central/Pacific)", ""],
];

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const sb = createAdminClient();
  const { data, error } = await sb
    .from("agent_configs").select("custom_instructions").eq("agent_id", MANU).single();
  if (error || !data) throw new Error("config não encontrada: " + error?.message);

  let ci = data.custom_instructions as string;
  const antes = ci.length;

  if (REVERT) {
    if (!ci.includes(MARCADOR)) { console.log("nada pra reverter"); process.exit(0); }
    ci = ci.replace(NOVO, ANCORA);
    for (const [de, para] of CORTES) if (para !== "" && ci.includes(para)) ci = ci.replace(para, de);
    console.log("(revert restaura a regra; exemplos cortados ficam no backup /tmp/manu-backup.json)");
  } else {
    if (ci.includes(MARCADOR)) { console.log("já aplicado (idempotente)"); process.exit(0); }
    if (!ci.includes(ANCORA)) throw new Error("âncora não encontrada — config mudou, abortando");
    ci = ci.replace(ANCORA, NOVO);
    for (const [de, para] of CORTES) {
      if (ci.includes(de)) ci = ci.replace(de, para);
      else console.warn("  (corte não encontrado, seguindo: " + de.slice(0, 38) + "…)");
    }
  }

  console.log("ci: " + antes + " → " + ci.length + " chars (delta " + (ci.length - antes >= 0 ? "+" : "") + (ci.length - antes) + ")");
  if (ci.length > 8000) console.warn("⚠️  " + (ci.length - 8000) + " chars do FIM continuam fora do prompt (teto 8000).");
  if (DRY) { console.log("[dry] nada gravado"); process.exit(0); }

  const { error: upErr } = await sb
    .from("agent_configs")
    .update({ custom_instructions: ci, updated_at: new Date().toISOString() })
    .eq("agent_id", MANU);
  if (upErr) throw new Error("update falhou: " + upErr.message);

  const { data: conf } = await sb
    .from("agent_configs").select("custom_instructions").eq("agent_id", MANU).single();
  const texto = conf?.custom_instructions || "";
  const pos = texto.indexOf(MARCADOR);
  console.log((REVERT ? "revertido" : "aplicado") + ": " + ((pos >= 0) !== REVERT ? "✅ confirmado no banco" : "❌ não confirmou"));
  if (!REVERT) console.log("posição da regra: " + pos + " (precisa ser < 8000 pra ser lida) → " + (pos < 8000 && pos >= 0 ? "✅ DENTRO" : "❌ FORA"));
}

main().then(() => process.exit(0)).catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
