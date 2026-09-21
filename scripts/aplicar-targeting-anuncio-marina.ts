/**
 * Liga a folha de ATRIBUIÇÃO na ativação da Manu (recrutamento Marina Couto).
 *
 * POR QUÊ: a regra só ativava por (a) o lead escrever "carreira"/"entender
 * melhor" — que é o texto que o anúncio do Instagram PRÉ-PREENCHE — ou (b) a
 * tag "ia - em atendimento". Quem vem da MESMA campanha mas digita a própria
 * frase ("gostaria de saber mais", "acabei de receber meu work permit") caía
 * fora. Medido em 14 dias: 135 contatos barrados, dos quais ~22 eram lead real.
 *
 * POR QUE NÃO BASTA AFROUXAR: 43 dos 135 eram "Parabéns" de amigos no
 * aniversário da Marina (15/09). Abrir a regra no texto faria a IA oferecer
 * carreira pra quem só deu os parabéns. A separação que funciona não é o texto,
 * é a ORIGEM: medido contra os contatos reais, 17 de 20 leads perdidos vieram
 * de `Paid Social` e 35 de 35 parabéns vieram de `Social media`.
 *
 * Simulado com `scripts/simular-targeting-marina.ts` contra os 135 contatos
 * reais ANTES de aplicar: 20 leads recuperados, 0 parabéns liberados.
 *
 * Reverter: `npx tsx scripts/aplicar-targeting-anuncio-marina.ts --reverter`
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
import { createClient } from "@supabase/supabase-js";
import { writeFileSync, readFileSync, existsSync } from "fs";

const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const AGENTE = "3976b4b6-0345-4f25-b964-138bb7960058";
const BACKUP = "_planning/marina-review-2026-09-21/backup-targeting-manu.json";
const GRUPO_ANUNCIO = {
  id: "anuncio",
  match: "any",
  rules: [{
    id: "veio-de-anuncio",
    type: "attribution",
    attribution_field: "sessionSource",
    attribution_operator: "contains",
    attribution_value: "Paid",
    attribution_scope: "first",
  }],
};

(async () => {
  const reverter = process.argv.includes("--reverter");
  const { data, error } = await sb.from("agent_configs").select("targeting_rules").eq("agent_id", AGENTE).maybeSingle();
  if (error || !data) { console.error("não li a config:", error?.message); process.exit(1); }
  const atual = data.targeting_rules as any;

  if (reverter) {
    if (!existsSync(BACKUP)) { console.error("sem backup pra reverter"); process.exit(1); }
    const antigo = JSON.parse(readFileSync(BACKUP, "utf8"));
    const { error: e } = await sb.from("agent_configs").update({ targeting_rules: antigo }).eq("agent_id", AGENTE);
    if (e) { console.error("falhou:", e.message); process.exit(1); }
    console.log("REVERTIDO para:", JSON.stringify(antigo));
    return;
  }

  if ((atual?.groups ?? []).some((g: any) => g.id === "anuncio")) {
    console.log("grupo 'anuncio' JÁ existe — nada a fazer."); return;
  }
  writeFileSync(BACKUP, JSON.stringify(atual, null, 2));
  console.log(`backup salvo em ${BACKUP}`);

  const novo = { ...atual, groups: [...(atual.groups ?? []), GRUPO_ANUNCIO] };
  const { error: e2 } = await sb.from("agent_configs").update({ targeting_rules: novo }).eq("agent_id", AGENTE);
  if (e2) { console.error("falhou:", e2.message); process.exit(1); }

  const { data: v } = await sb.from("agent_configs").select("targeting_rules").eq("agent_id", AGENTE).maybeSingle();
  const g = (v?.targeting_rules as any)?.groups ?? [];
  console.log(`\nAPLICADO. Grupos agora (${g.length}):`);
  for (const x of g) console.log(`  - ${x.id}: ${x.rules.map((r: any) => r.type).join(",")}`);
})();
