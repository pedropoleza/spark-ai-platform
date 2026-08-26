/**
 * Bianca Amorim / Five Rings (cRavIlyC52vFYgJATgi7) — FASE 0 do plano
 * `_planning/bianca-agentes-2026-08/PLANO.md`. Config-only, idempotente.
 *
 * O que corrige (tudo medido em 26/08):
 *  0.1 GATE (A2): a regra era UMA frase exata ("Sim! Quero me tornar um Agente
 *      Financeiro nos Estados Unidos," — com a vírgula). Resultado: 274
 *      targeting_skip / 222 contatos únicos contra 4 send_message desde 28/07.
 *      Vira um set v2: ENTRADA (any: atribuição paga OU frase curta OU tag da
 *      SDR) + EXCLUSÃO (all: nenhuma tag de cliente/pessoal/agência).
 *  0.2 CALENDÁRIO (A6): objective era qualification_and_booking com calendar_id
 *      VAZIO — o runtime só busca horários com calendário preenchido, então a
 *      IA nunca conseguiu agendar. Preenche o 1:1 com Bianca Amorim.
 *      slot_window_days=14 (H80): medido 7d→2 dias/7 horários; 14d→6 dias/43.
 *  0.3 EXCLUSÃO (H81): a conta é a operação INTEIRA da Bianca (tem client,
 *      contato pessoal, pessoal bia, membro da agencia). Abrir gate sem isso
 *      repetiria o incidente da Jussara (19/08).
 *  0.4 NOME: "[TESTE]" num agente de produção já confundiu na conta da Marina.
 *
 * Alavancas da SDR pelo CELULAR (o app mobile não roda a pílula, que é JS na
 * web — por isso as duas viram TAG):
 *   + `ia-ligada`    → liga a IA pra um contato que não casaria o gate
 *   + `ia-desligada` → desliga a IA pra um contato que casaria (exclusão H81)
 *
 *   npx tsx scripts/apply-bianca-fase0.ts            (aplica)
 *   npx tsx scripts/apply-bianca-fase0.ts --revert   (restaura verbatim)
 *   npx tsx scripts/apply-bianca-fase0.ts --dry      (mostra sem gravar)
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import type { TargetingRuleSet } from "@/types/agent";

const AGENT_ID = "17860a86-ace9-4299-9328-2452151348a0";
const LOC = "cRavIlyC52vFYgJATgi7";
const CALENDARIO_1ON1 = "7esidBgOQphCRLUt4YaL"; // "1:1 com Bianca Amorim" (único ativo)
const NOME_NOVO = "Bianca — Tráfego Pago (IG)";
const NOME_ANTIGO = "Manu — Recrutamento Bianca [TESTE]";

const REVERT = process.argv.includes("--revert");
const DRY = process.argv.includes("--dry");

/* ── BACKUP VERBATIM do estado pré-fix (lido do banco em 26/08) ────────── */
const TARGETING_ANTIGO = {
  match: "all",
  groups: [
    {
      id: "wtazqvia",
      match: "all",
      rules: [
        {
          id: "n7t2fpx2",
          type: "message",
          message_value: "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,",
          message_operator: "contains",
        },
      ],
    },
  ],
  version: 2,
};
const CALENDAR_ANTIGO = "";
const SLOT_WINDOW_ANTIGO = null;

/* ── ESTADO NOVO ───────────────────────────────────────────────────────── */

// Tags que NUNCA podem ser atendidas por um agente de RECRUTAMENTO.
// (`cliente` e `client` são tags distintas na conta — as duas existem.)
const TAGS_EXCLUIDAS = [
  "client",
  "cliente",
  "contato pessoal",
  "pessoal bia",
  "membro da agencia",
  "ia-desligada", // alavanca de DESLIGAR da SDR pelo celular
];

const TARGETING_NOVO: TargetingRuleSet = {
  version: 2,
  match: "all", // ENTRADA e EXCLUSÃO valem as duas
  groups: [
    {
      id: "g-entrada",
      match: "any",
      rules: [
        // 1) Veio de anúncio — PRIMEIRO toque (H74: quem veio de anúncio não
        //    deixa de ter vindo porque depois mandou DM orgânica).
        {
          id: "ent-attr-paid",
          type: "attribution",
          attribution_field: "sessionSource",
          attribution_operator: "contains",
          attribution_value: "Paid",
          attribution_scope: "first",
        },
        // 2) Frase do anúncio — ENCURTADA de propósito: a original exigia o
        //    texto inteiro com vírgula final e por isso quase ninguém casava.
        {
          id: "ent-msg-anuncio",
          type: "message",
          message_operator: "contains",
          message_value: "Quero me tornar um Agente Financeiro",
        },
        // NOTA (26/08): `ia-ligada` NÃO entra aqui de propósito. Ela liga o
        // agente de NOVOS SEGUIDORES. O roteador de inbound escolhe o agente
        // mais ANTIGO entre os que casam (created_at ASC) — se os dois
        // aceitassem a mesma tag, este (18/06) ganharia sempre e a alavanca da
        // SDR nunca chegaria no agente de seguidores. Se um dia for preciso
        // forçar ESTE agente à mão, criar uma tag própria (`ia-anuncio`).
      ],
    },
    {
      id: "g-exclusao",
      match: "all", // nenhuma das excluídas pode estar presente
      rules: TAGS_EXCLUIDAS.map((tag, i) => ({
        id: `exc-${i}`,
        type: "tag" as const,
        tag,
        negate: true, // H81
      })),
    },
  ],
};

async function main() {
  const sb = createAdminClient();

  const { data: agent } = await sb
    .from("agents")
    .select("id,name,status,location_id")
    .eq("id", AGENT_ID)
    .single();
  if (!agent || agent.location_id !== LOC) {
    console.error("❌ agente não encontrado ou fora da location esperada");
    process.exit(1);
  }

  if (REVERT) {
    if (DRY) { console.log("dry-run do revert"); process.exit(0); }
    await sb.from("agent_configs").update({
      targeting_rules: TARGETING_ANTIGO,
      calendar_id: CALENDAR_ANTIGO,
      slot_window_days: SLOT_WINDOW_ANTIGO,
      updated_at: new Date().toISOString(),
    }).eq("agent_id", AGENT_ID);
    await sb.from("agents").update({ name: NOME_ANTIGO }).eq("id", AGENT_ID);
    console.log("↩️  REVERTIDO: targeting/calendário/janela/nome restaurados verbatim.");
    process.exit(0);
  }

  console.log("=== FASE 0 — Bianca (Five Rings) ===");
  console.log(`agente: ${agent.name} [${agent.status}]`);
  console.log(`\nentrada (any): atribuição 'Paid' (1º toque) · frase curta do anúncio`);
  console.log(`exclusão (all, negadas): ${TAGS_EXCLUIDAS.join(" · ")}`);
  console.log(`calendário: ${CALENDARIO_1ON1} · slot_window_days: 14`);
  console.log(`nome: "${agent.name}" → "${NOME_NOVO}"`);

  if (DRY) {
    console.log("\n(dry-run — nada gravado)");
    console.log(JSON.stringify(TARGETING_NOVO, null, 2));
    process.exit(0);
  }

  const { error: cfgErr } = await sb
    .from("agent_configs")
    .update({
      targeting_rules: TARGETING_NOVO,
      calendar_id: CALENDARIO_1ON1,
      slot_window_days: 14,
      updated_at: new Date().toISOString(),
    })
    .eq("agent_id", AGENT_ID);
  if (cfgErr) { console.error("❌ update config:", cfgErr.message); process.exit(1); }

  const { error: agErr } = await sb.from("agents").update({ name: NOME_NOVO }).eq("id", AGENT_ID);
  if (agErr) { console.error("❌ update agents:", agErr.message); process.exit(1); }

  // Verificação: RELÊ do banco (nunca confiar no write)
  const { data: check } = await sb
    .from("agent_configs")
    .select("targeting_rules, calendar_id, slot_window_days")
    .eq("agent_id", AGENT_ID)
    .single();
  const { data: ag2 } = await sb.from("agents").select("name").eq("id", AGENT_ID).single();
  const tr = check?.targeting_rules as TargetingRuleSet;
  const nExc = tr?.groups?.find((g) => g.id === "g-exclusao")?.rules.filter((r) => r.negate).length ?? 0;
  const nEnt = tr?.groups?.find((g) => g.id === "g-entrada")?.rules.length ?? 0;

  console.log("\n=== VERIFICAÇÃO (relido do banco) ===");
  console.log(`nome: ${ag2?.name}`);
  console.log(`entrada: ${nEnt} folha(s) | exclusão: ${nExc} folha(s) negadas`);
  console.log(`calendar_id: ${check?.calendar_id || "(vazio!)"} | slot_window_days: ${check?.slot_window_days}`);
  const ok = nEnt === 2 && nExc === TAGS_EXCLUIDAS.length && check?.calendar_id === CALENDARIO_1ON1 && check?.slot_window_days === 14;
  console.log(ok ? "\n✅ Fase 0 aplicada." : "\n❌ Estado divergente — conferir.");
  console.log("Rollback: npx tsx scripts/apply-bianca-fase0.ts --revert");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
