/**
 * Bianca — prova de que os DOIS agentes não brigam pelo mesmo lead.
 *
 * Lê o targeting REAL dos dois agentes do banco e reproduz a decisão do
 * roteador de inbound (`api/webhooks/inbound-message/route.ts`):
 *   1. quem já tem conversation_state ganha (não testado aqui — é estado, não regra);
 *   2. senão, itera os agentes ATIVOS por created_at ASC e pega o 1º que casa;
 *   3. agente SEM regra vira catch-all.
 *
 * É o teste que pega o erro que quase passou em 26/08: com `ia-ligada` nos dois
 * agentes, o mais ANTIGO (tráfego pago, 18/06) ganhava sempre e a alavanca da
 * SDR nunca chegava no agente de seguidores.
 *
 *   npx tsx scripts/test-bianca-roteamento.ts
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });

const LOC = "cRavIlyC52vFYgJATgi7";
const A = "Bianca — Tráfego Pago (IG)";
const B = "Bianca — Novos Seguidores (IG)";

const PAGO = { sessionSource: "Paid Social", medium: "instagram", campaign: "[AF] [Perp] [Captura] Msg_Direct engaj v4", adId: "120250544685660600" };
const ORGANICO = { sessionSource: "Social media", medium: "instagram", mediumId: "2423577894718953" };
const SEM_ATRIB = {};

type Caso = { nome: string; tags: string[]; attr: Record<string, unknown>; msg: string; esperado: string | null };

const CASOS: Caso[] = [
  // ── tráfego pago → agente A ──────────────────────────────────────────
  { nome: "lead de anúncio, msg genérica", tags: [], attr: PAGO, msg: "oi tudo bem?", esperado: A },
  { nome: "lead de anúncio com a frase do criativo", tags: [], attr: PAGO, msg: "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,", esperado: A },
  { nome: "frase do criativo SEM atribuição paga (criativo novo)", tags: [], attr: SEM_ATRIB, msg: "oi, Quero me tornar um Agente Financeiro", esperado: A },
  { nome: "veio de anúncio e DEPOIS mandou DM orgânica (1º toque manda)", tags: [], attr: PAGO, msg: "oi de novo", esperado: A },

  // ── novos seguidores → agente B ──────────────────────────────────────
  { nome: "seguidor orgânico COM tag novo seguidor", tags: ["novo seguidor"], attr: ORGANICO, msg: "oi! vi seus stories", esperado: B },
  { nome: "SDR ligou à mão pelo celular (ia-ligada)", tags: ["ia-ligada"], attr: ORGANICO, msg: "oi", esperado: B },
  { nome: "seguidor sem atribuição nenhuma + tag da SDR", tags: ["ia-ligada"], attr: SEM_ATRIB, msg: "oi", esperado: B },

  // ── ninguém atende ───────────────────────────────────────────────────
  { nome: "seguidor orgânico SEM tag → ninguém (SDR ainda não ligou)", tags: [], attr: ORGANICO, msg: "oi", esperado: null },
  { nome: "cliente (tag client) → ninguém, mesmo vindo de anúncio", tags: ["client"], attr: PAGO, msg: "oi bianca", esperado: null },
  { nome: "contato pessoal → ninguém", tags: ["contato pessoal"], attr: ORGANICO, msg: "oi", esperado: null },
  { nome: "membro da agência → ninguém", tags: ["membro da agencia"], attr: PAGO, msg: "oi", esperado: null },
  { nome: "ia-desligada barra o agente de anúncio", tags: ["ia-desligada"], attr: PAGO, msg: "oi", esperado: null },
  { nome: "ia-desligada barra o agente de seguidores (ganha da ia-ligada)", tags: ["novo seguidor", "ia-desligada"], attr: ORGANICO, msg: "oi", esperado: null },

  // ── conflitos de fronteira ───────────────────────────────────────────
  { nome: "lead PAGO com tag novo seguidor → A (não deixa B roubar)", tags: ["novo seguidor"], attr: PAGO, msg: "oi", esperado: A },
  { nome: "lead PAGO com ia-ligada → A (a tag não desvia lead de anúncio)", tags: ["ia-ligada"], attr: PAGO, msg: "oi", esperado: A },
  { nome: "seguidor com tag qualificada (tag neutra) segue em B", tags: ["novo seguidor", "qualificada"], attr: ORGANICO, msg: "oi", esperado: B },
];

async function main() {
  const { createAdminClient } = await import("@/lib/supabase/admin");
  const { evaluateTargetingSet, normalizeTargeting } = await import("@/lib/queue/targeting");
  const sb = createAdminClient();

  // Mesma query do roteador: ativos da location, created_at ASC.
  const { data: agentes } = await sb
    .from("agents")
    .select("id, name, status, created_at, agent_configs(targeting_rules)")
    .eq("location_id", LOC)
    .in("type", ["sales_agent", "recruitment_agent", "custom_agent"])
    .order("created_at", { ascending: true });

  // Pra testar o estado FINAL, avaliamos os dois como se ambos estivessem ativos
  // (o B nasce inativo de propósito — o teste prova a config, não o status).
  const candidatos = (agentes || []).filter((a) => a.name === A || a.name === B);
  console.log("=== agentes na ordem do roteador (created_at ASC) ===");
  for (const a of candidatos) console.log(`  ${a.created_at?.slice(0, 10)}  ${a.name}  [${a.status}]`);
  if (candidatos.length !== 2) { console.error("❌ esperava 2 agentes"); process.exit(1); }

  const rotear = (c: Caso): string | null => {
    for (const ag of candidatos) {
      const cfg = Array.isArray(ag.agent_configs) ? ag.agent_configs[0] : ag.agent_configs;
      const rules = (cfg as { targeting_rules?: unknown })?.targeting_rules;
      const set = normalizeTargeting(rules as never);
      if (!set) return ag.name; // sem regra = catch-all (não deve acontecer aqui)
      const contato = { tags: c.tags, attributionSource: c.attr, lastAttributionSource: {} };
      if (evaluateTargetingSet(set, contato as never, [], { messageText: c.msg })) return ag.name;
    }
    return null;
  };

  console.log("\n=== ROTEAMENTO ===");
  let fail = 0;
  for (const c of CASOS) {
    const got = rotear(c);
    const ok = got === c.esperado;
    if (!ok) fail++;
    const fmt = (v: string | null) => (v === A ? "A/anúncio" : v === B ? "B/seguidor" : "ninguém");
    console.log(`${ok ? "✅" : "❌"} ${c.nome}\n      → ${fmt(got)}${ok ? "" : `  (esperado ${fmt(c.esperado)})`}`);
  }

  // Invariante dura: nenhum agente pode estar sem regra (viraria catch-all e
  // engoliria o outro — é o modo de falha do roteador).
  console.log("\n=== INVARIANTE: nenhum agente sem regra ===");
  for (const ag of candidatos) {
    const cfg = Array.isArray(ag.agent_configs) ? ag.agent_configs[0] : ag.agent_configs;
    const set = normalizeTargeting((cfg as { targeting_rules?: unknown })?.targeting_rules as never);
    const ok = !!set;
    if (!ok) fail++;
    console.log(`${ok ? "✅" : "❌"} ${ag.name}: ${ok ? `${set!.groups.length} grupo(s)` : "SEM REGRA = catch-all!"}`);
  }

  const total = CASOS.length + candidatos.length;
  console.log(fail === 0 ? `\n✅ ${total}/${total}` : `\n❌ ${fail} falha(s) de ${total}`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
