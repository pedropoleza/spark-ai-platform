// Golden test: claim atômico de dispatch proativo serializa cooldown=0 (NB-10).
//
// Reproduz o cenário do NB-10 (review 2026-06-10): try_claim_dispatch_slot
// para regras com cooldown_minutes<=0 ("Deal fechado"/deal_won, "Novo lead
// atribuído"/contact_assigned_to_rep) PRECISA garantir que 2 chamadas paralelas
// pro MESMO (rep, rule, target) resultem em EXATAMENTE 1 claim (1 id não-nulo).
// Senão = msg proativa duplicada pro rep + double-charge de tokens LLM.
//
// Antes da migration 00106, a branch `IF p_cooldown_minutes <= 0` fazia upsert
// SEM WHERE e SEMPRE RETURNING id → as duas chamadas ganhavam o claim.
//
// Cenários:
//   1. cooldown=0, MESMO target, 2 chamadas paralelas  → exatamente 1 id (CORE)
//   2. cooldown=0, 3ª chamada sequencial dentro de 2s   → NULL (piso segura)
//   3. cooldown=0, targets DIFERENTES                   → ambos ganham (por-target)
//   4. cooldown=60 (regressão), MESMO target, paralelas → exatamente 1 id
//
// Fixtures hermético: cria location → agent → rule + rep, roda, derruba tudo.
// Requer Supabase com a migration 00106 aplicada (stack local `supabase start`
// ou branch de staging — NÃO rodar apontando pra prod).
//
// Run:
//   npx tsx -r tsconfig-paths/register scripts/test-dispatch-claim-race.ts

import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { randomUUID } from "crypto";
import { createAdminClient } from "@/lib/supabase/admin";

const supabase = createAdminClient();

let passed = 0;
let failed = 0;

function check(name: string, ok: boolean, detail: string): void {
  if (ok) {
    passed++;
    console.log(`  ✅ ${name} — ${detail}`);
  } else {
    failed++;
    console.error(`  ❌ ${name} — ${detail}`);
  }
}

/** Chama o claim RPC. Retorna o id do alert_state (string) ou null. */
async function claim(
  ruleId: string,
  repId: string,
  targetId: string | null,
  cooldown: number,
): Promise<string | null> {
  const { data, error } = await supabase.rpc("try_claim_dispatch_slot", {
    p_rep_id: repId,
    p_rule_id: ruleId,
    p_target_id: targetId,
    p_cooldown_minutes: cooldown,
  });
  if (error) {
    throw new Error(
      `RPC try_claim_dispatch_slot falhou: ${error.message}. ` +
        `Migration 00106 aplicada nesse banco?`,
    );
  }
  return (data as string | null) || null;
}

async function main(): Promise<void> {
  const suffix = `${Date.now()}-${randomUUID().slice(0, 8)}`;
  const locationId = `nb10-loc-${suffix}`;
  const companyId = `nb10-co-${suffix}`;
  const phone = `+1555${String(Date.now()).slice(-7)}`;

  let repId = "";

  console.log("→ Setup de fixtures hermético...");

  // location → agent → rule
  const { error: locErr } = await supabase
    .from("locations")
    .insert({ location_id: locationId, company_id: companyId, location_name: "NB-10 race test" });
  if (locErr) throw new Error(`insert location: ${locErr.message}`);

  const { data: agent, error: agErr } = await supabase
    .from("agents")
    .insert({ location_id: locationId, type: "account_assistant", name: "NB-10 race test" })
    .select("id")
    .single();
  if (agErr || !agent) throw new Error(`insert agent: ${agErr?.message}`);

  const { data: rule, error: ruleErr } = await supabase
    .from("assistant_proactive_rules")
    .insert({
      agent_id: agent.id,
      rule_type: "reactive",
      name: "NB-10 deal_won race",
      trigger_config: { event: "deal_won" },
      prompt_instruction: "test",
      cooldown_minutes: 0,
      source: "custom",
    })
    .select("id")
    .single();
  if (ruleErr || !rule) throw new Error(`insert rule: ${ruleErr?.message}`);

  const { data: rep, error: repErr } = await supabase
    .from("rep_identities")
    .insert({ phone, display_name: "NB-10 race test" })
    .select("id")
    .single();
  if (repErr || !rep) throw new Error(`insert rep: ${repErr?.message}`);
  repId = rep.id;

  const ruleId = rule.id;
  console.log(`  fixtures: rep=${repId} rule=${ruleId}\n`);

  try {
    // ── Cenário 1 (CORE): cooldown=0, mesmo target, 2 paralelas → 1 claim ──
    const t1 = `nb10-${randomUUID()}`;
    const [a, b] = await Promise.all([
      claim(ruleId, repId, t1, 0),
      claim(ruleId, repId, t1, 0),
    ]);
    const won1 = [a, b].filter(Boolean).length;
    check(
      "cenário 1: cooldown=0 paralelo (mesmo target)",
      won1 === 1,
      `${won1} de 2 ganharam o claim (a=${a ?? "null"}, b=${b ?? "null"}) — esperado 1`,
    );

    // ── Cenário 2: 3ª chamada sequencial dentro de 2s → NULL ──
    const c = await claim(ruleId, repId, t1, 0);
    check(
      "cenário 2: 3ª chamada dentro do piso de 2s",
      c === null,
      `retornou ${c ?? "null"} — esperado null (piso anti-race ainda ativo)`,
    );

    // ── Cenário 3: targets DIFERENTES → ambos ganham (piso é por-target) ──
    const t2 = `nb10-${randomUUID()}`;
    const t3 = `nb10-${randomUUID()}`;
    const [d, e] = await Promise.all([
      claim(ruleId, repId, t2, 0),
      claim(ruleId, repId, t3, 0),
    ]);
    check(
      "cenário 3: cooldown=0, targets distintos",
      Boolean(d) && Boolean(e),
      `d=${d ?? "null"}, e=${e ?? "null"} — esperado ambos não-nulos (cada deal comemorado)`,
    );

    // ── Cenário 4 (regressão): cooldown>0 segue serializando ──
    const t4 = `nb10-${randomUUID()}`;
    const [f, g] = await Promise.all([
      claim(ruleId, repId, t4, 60),
      claim(ruleId, repId, t4, 60),
    ]);
    const won4 = [f, g].filter(Boolean).length;
    check(
      "cenário 4: regressão cooldown=60 paralelo",
      won4 === 1,
      `${won4} de 2 ganharam o claim (f=${f ?? "null"}, g=${g ?? "null"}) — esperado 1`,
    );
  } finally {
    // Teardown: alert_state por rep, depois rep + location (cascata agent→rule).
    console.log("\n→ Teardown de fixtures...");
    await supabase.from("assistant_alert_state").delete().eq("rep_id", repId);
    await supabase.from("rep_identities").delete().eq("id", repId);
    await supabase.from("locations").delete().eq("location_id", locationId);
  }

  console.log(`\n${failed === 0 ? "✅ PASS" : "❌ FAIL"} — ${passed} ok, ${failed} falhas`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error("\n❌ erro fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
