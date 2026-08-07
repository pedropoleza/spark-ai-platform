/**
 * Caso F — "a IA aborda quem já está em atendimento humano" (Five Star Ricos).
 *
 * Márcia, 04/08 01:14 (áudio): "essa menina JÁ É CLIENTE e está sendo agente, a
 * Iá mandou mensagem para ela... Corre e avisa a IA que quem já tem contato não
 * pode conversar". Em 04/08 14:33 ela cobrou de novo, e em 04/08 18:58 a gente
 * respondeu "conferimos todas desde a reativação, zero casos". Voltou.
 *
 * Por que voltou: `handoff_policy.enabled` estava FALSE. Sem isso o gate F37
 * (should-respond) nunca roda, e a regra "humano respondeu nos últimos N min →
 * a IA cala" simplesmente não existia nessa conta. A única proteção era o
 * `auto_pause_on_human_message`, que age DEPOIS (pausa o contato) e não impede
 * o turno que já saiu.
 *
 * Por que agora é seguro ligar: o gate foi desligado em contas 100% IA porque a
 * classificação "humano assumiu" misfirava (lia o próprio eco da IA como
 * humano — casos Marina/Vandinha e Alves Cury). Essa escada foi endurecida em
 * 2026-07-28: anti-eco por ID do envio (H56), anti-eco por texto, merge field
 * não-interpolado, `isChatMessageType` (atividade de CRM não conta) e disc-4
 * (lead novo sem IA falando ainda). Ver lead-history.ts:175-215.
 * E, decisivo: esta conta NÃO é 100% IA — a Márcia e a Roberta atendem o inbox
 * ativamente (mandam áudio e texto nas conversas o tempo todo). É exatamente o
 * cenário pro qual o gate foi feito.
 *
 * Segunda trava, pro caso literal que ela relatou (CLIENTE recebendo abordagem):
 * `deactivation_rules` por tag de cliente. Isso é enforced no webhook de inbound
 * (route.ts:787) ANTES de enfileirar — o contato tagueado nunca chega na IA.
 *
 *   npx tsx -r tsconfig-paths/register scripts/apply-marcia-gate-humano.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";

const AGENT_ID = "7c0a72b7-e37c-463d-be56-73b7822a3037";

// Tags de cliente que existem NA CONTA (conferidas via API do Spark Leads).
// Contato com qualquer uma delas não é lead: a IA não abre conversa.
const TAGS_CLIENTE = ["cliente", "client", "active client", "apólice ativa", "personal contact"];

const HANDOFF = {
  enabled: true,
  // Ela e a Roberta respondem em rajada; 60min é a janela padrão e cobre o caso
  // "acabei de assumir essa conversa".
  skip_if_human_replied_within_minutes: 60,
  skip_if_lead_requested_human: true,
  notify_rep_via_sparkbot: true,
  notify_on_opp_stage_closed: true,
  custom_keywords_handoff: [
    "humano", "atendente", "pessoa", "falar com alguem", "falar com alguém",
    "real person", "agent please", "falar com a marcia", "falar com a márcia",
    "falar com a roberta",
  ],
};

async function main() {
  const supabase = createAdminClient();

  const { data: antes } = await supabase
    .from("agent_configs")
    .select("handoff_policy, deactivation_rules, lead_history_config")
    .eq("agent_id", AGENT_ID)
    .maybeSingle();
  if (!antes) throw new Error("config não encontrada");

  console.log(`antes: handoff.enabled=${(antes.handoff_policy as Record<string, unknown>)?.enabled} | deactivation_rules=${JSON.stringify(antes.deactivation_rules)}`);

  // O gate precisa do histórico do lead carregado pra saber quem falou por último.
  const leadHist = {
    ...((antes.lead_history_config as Record<string, unknown>) || {}),
    enabled: true,
    messages_count: 20,
    include_notes: true,
    include_opportunities: true,
    include_tags: true,
  };

  // Preserva regras que já existirem; só acrescenta as de tag de cliente.
  const existentes = Array.isArray(antes.deactivation_rules) ? (antes.deactivation_rules as Record<string, unknown>[]) : [];
  const jaTem = new Set(existentes.map((r) => String(r.tag || "").toLowerCase()));
  const novas = TAGS_CLIENTE.filter((t) => !jaTem.has(t.toLowerCase())).map((t) => ({
    id: `cliente-${t.replace(/[^a-z]+/gi, "-").toLowerCase()}`,
    type: "tag_added" as const,
    tag: t,
  }));
  const deactivation = [...existentes, ...novas];

  const { error } = await supabase
    .from("agent_configs")
    .update({
      handoff_policy: HANDOFF,
      deactivation_rules: deactivation,
      lead_history_config: leadHist,
    })
    .eq("agent_id", AGENT_ID);
  if (error) throw new Error(`UPDATE: ${error.message}`);

  console.log(`\n✅ Caso F aplicado — ${AGENT_ID}`);
  console.log(`   1) handoff_policy LIGADO: humano respondeu nos últimos 60min → a IA cala e avisa`);
  console.log(`   2) deactivation_rules: ${novas.length} tag(s) de cliente adicionada(s) (${novas.map((n) => n.tag).join(", ") || "nenhuma nova"})`);
  console.log(`      total de regras: ${deactivation.length}`);
  console.log(`   3) lead_history_config garantido ON (o gate depende dele pra saber quem falou por último)`);
  console.log(`\n⚠️  MONITORAR 48h: se a IA começar a ficar MUDA em conversa de lead novo, é o gate`);
  console.log(`   misfirando — procure 'should_respond_skip' no execution_log e me chame.`);
  process.exit(0);
}
main().catch((e) => {
  console.error("❌", e instanceof Error ? e.message : e);
  process.exit(1);
});
