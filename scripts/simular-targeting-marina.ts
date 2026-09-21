/**
 * Simula a regra de ativação da Manu (agente de recrutamento da Marina) contra
 * contatos REAIS de produção, ANTES de mexer na configuração.
 *
 * Por que existe: a regra hoje só ativa quando o lead escreve "carreira" ou
 * "entender melhor" — o texto que o anúncio do Instagram pré-preenche. Quem
 * chega pela mesma campanha mas digita a própria frase ("gostaria de saber
 * mais", "tenho green card") é barrado. A proposta é acrescentar uma folha de
 * ATRIBUIÇÃO (veio de anúncio), e isso só pode ser ligado depois de provar,
 * contra os contatos reais, que ela NÃO passa a responder os parabéns de
 * aniversário da Marina — que é o volume que a regra atual acerta em barrar.
 */
import { config } from "dotenv";
config({ path: "/tmp/.prodenv-stress" });
const SUP = "A62s5EQj1hldOuvBEowv";
const COMPANY = "TdmQMjj86Y3LgppiB96K";

const REGRA_HOJE = {
  version: 2, match: "any",
  groups: [
    { id: "abertura", match: "any", rules: [{ id: "opener", type: "message", case_sensitive: false, message_values: ["carreira","entender melhor"], message_operator: "in" }] },
    { id: "tag", match: "any", rules: [{ id: "tag-atend", tag: "ia - em atendimento", type: "tag" }] },
  ],
};
const REGRA_NOVA = {
  version: 2, match: "any",
  groups: [
    ...REGRA_HOJE.groups,
    { id: "anuncio", match: "any", rules: [{
      id: "veio-de-anuncio", type: "attribution",
      attribution_field: "sessionSource", attribution_operator: "contains",
      attribution_value: "Paid", attribution_scope: "first",
    }] },
  ],
};

(async () => {
  const { createClient } = await import("@supabase/supabase-js");
  const { checkContactMatchesTargeting } = await import("../src/lib/queue/targeting");
  const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const desde = new Date(Date.now()-14*864e5).toISOString();
  const { data: sk } = await sb.from("execution_log").select("contact_id")
    .eq("location_id",SUP).eq("action_type","targeting_skip").gte("created_at",desde).limit(300);
  const barrados = [...new Set((sk??[]).map(r=>r.contact_id))];
  const { data: msgs } = await sb.from("message_queue").select("contact_id,message_body,received_at")
    .in("contact_id", barrados).order("received_at").limit(1000);
  const prim: Record<string,string> = {};
  for (const m of msgs??[]) if (!prim[m.contact_id]) prim[m.contact_id]=(m.message_body??"").replace(/\s+/g," ").trim();

  const PARABENS = /parab[ée]ns|happy birth|felicidades|feliz anivers|🎂|🥳|🎉/i;
  const LEAD_REAL = /informa|saber mais|conhecer|como funciona|quero|interesse|trabalh|profiss|permit|green ?card|oportunidade|explica|remunera/i;

  let recuperados = 0, parabensLiberados = 0, seguemBarrados = 0;
  const detalhe: string[] = [];
  for (const id of barrados) {
    const texto = prim[id] ?? "";
    const ehParabens = PARABENS.test(texto);
    const ehLead = !ehParabens && LEAD_REAL.test(texto);
    const antes = await checkContactMatchesTargeting(id, REGRA_HOJE as any, COMPANY, SUP, { messageText: texto });
    const depois = await checkContactMatchesTargeting(id, REGRA_NOVA as any, COMPANY, SUP, { messageText: texto });
    if (antes.ok) continue; // já passava
    if (depois.ok) {
      if (ehParabens) { parabensLiberados++; detalhe.push(`  ⚠ PARABÉNS agora PASSA: ${JSON.stringify(texto.slice(0,55))}`); }
      else if (ehLead) { recuperados++; detalhe.push(`  ✓ LEAD recuperado: ${JSON.stringify(texto.slice(0,55))}`); }
      else { detalhe.push(`  ? outro agora passa: ${JSON.stringify(texto.slice(0,55))}`); }
    } else seguemBarrados++;
  }
  console.log(`\n=== SIMULAÇÃO contra ${barrados.length} contatos barrados de verdade ===`);
  console.log(detalhe.slice(0,45).join("\n"));
  console.log(`\nLEADS RECUPERADOS: ${recuperados}`);
  console.log(`PARABÉNS INDEVIDAMENTE LIBERADOS: ${parabensLiberados}   <-- tem que ser 0`);
  console.log(`SEGUEM BARRADOS: ${seguemBarrados}`);
})();
