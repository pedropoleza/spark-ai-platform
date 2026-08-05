/**
 * Marina — fixes do stress test válido (2026-06-22, prompt embutido):
 *  - REGRA DE LINK: nunca emitir {{LINK_...}} cru (não há interpolação). Trocar os
 *    2 pontos de emissão por "o time te manda o link" (igual blindagem da Bianca).
 *  - Handoff de identidade: "uma pessoa do meu time" em vez de "alguém real"
 *    (que insinua que ela não é real).
 * Mantém o resto (núcleo do funil está sólido — média 7.3 no stress test).
 * NÃO mexe em "pequeno grupo" (correto: Marina é em grupo, print aprovado do Pedro)
 * nem em "profissão sólida" (correto: Pedro pediu).
 *   npx tsx -r tsconfig-paths/register scripts/fix-marina-links.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const MARINA = "3976b4b6-0345-4f25-b964-138bb7960058";

const REPL: [string, string][] = [
  [
    '"é golpe?/tem site?/manda algo?" → manda {{LINK_NATIONAL_LIFE}} na hora, antes do encontro. Vazio → não inventa link; o time manda + handoff. Nunca emite o token cru.',
    '"é golpe?/tem site?/manda algo?" → você NÃO tem um link pronto pra mandar; diz "já peço pro time te mandar o site oficial da National Life agora 🙂" e faz handoff. NUNCA escreva chaves { } numa mensagem nem invente uma URL.',
  ],
  [
    '7. CONFIRMA em bolhas curtas: "fechado, te coloco no encontro de [dia] às 8pm ET 🙌" / "o link da call é esse: {{LINK_REUNIAO}}" / "salva essa conversa". GUARD: nunca emita {{LINK_REUNIAO}} vazio — se vazio, diz que o time te manda o link antes.',
    '7. CONFIRMA em bolhas curtas: "fechado, te coloco no encontro de [dia] às 8pm ET 🙌" / "o time te manda o link do encontro antes, fica de olho no WhatsApp 🙂" / "salva essa conversa". REGRA DE LINK (inviolável): você NUNCA escreve chaves { } numa mensagem (é placeholder de sistema) nem inventa uma URL — quem entrega o link é o time.',
  ],
  [
    '- "é robô/bot/IA?" → nega UMA vez, natural: "não haha, sou a Isabella, assessora da Marina 😊" e SEGUE pro funil. Insistiu/se incomodou → PARA de negar + handoff.',
    '- "é robô/bot/IA?" → nega UMA vez, natural: "não haha, sou a Isabella, assessora da Marina 😊" e SEGUE pro funil. Insistiu/se incomodou → PARA de negar e passa pra alguém do time (diz "vou te conectar com uma pessoa do meu time", NUNCA "alguém real" — isso insinua que você não é).',
  ],
];

async function main() {
  const supabase = createAdminClient();
  const { data, error } = await supabase.from("agent_configs").select("custom_instructions").eq("agent_id", MARINA).single();
  if (error || !data) throw new Error("load: " + (error?.message || "sem config"));
  let p: string = data.custom_instructions;
  let n = 0;
  for (const [o, nv] of REPL) {
    if (p.includes(nv)) { console.log("• já aplicado"); continue; }
    if (!p.includes(o)) { console.warn("⚠️ âncora não bateu:", o.slice(0, 45) + "…"); continue; }
    p = p.replace(o, nv); n++;
  }
  if (p.length > 8000) throw new Error(`ficou ${p.length} chars`);
  if (p.includes("{{")) throw new Error("ainda tem token {{ no prompt: " + (p.match(/\{\{[^}]*\}\}/g) || []).join(", "));
  if (/\bMaria\b/.test(p)) throw new Error("apareceu 'Maria'");
  if (n === 0) { console.log("nada a aplicar"); process.exit(0); }
  const { error: ue } = await supabase.from("agent_configs").update({ custom_instructions: p }).eq("agent_id", MARINA);
  if (ue) throw new Error("update: " + ue.message);
  console.log(`✅ Marina link-hardening (${p.length} chars, ${n} trechos). Zero token {{ }} no prompt.`);
  process.exit(0);
}
main().catch((e) => { console.error("❌", e instanceof Error ? e.message : e); process.exit(1); });
