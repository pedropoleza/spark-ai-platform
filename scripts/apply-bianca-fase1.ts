/**
 * Bianca / Five Rings — FASE 1: marcação de ORIGEM (plano §5.1).
 *
 * Por quê: o Pedro quer medir depois "quais campanhas estão funcionando" e
 * separar agendamento de ANÚNCIO × agendamento de SEGUIDOR. Sem carimbo no
 * contato, os dois viram a mesma linha no funil e a medição fica impossível.
 *
 * O que faz, no agente A (tráfego pago):
 *  1. Adiciona `add_tag: origem-anuncio-ia` na regra `agent_activated` que JÁ
 *     existe (i2wnvggc, que move o contato pra "1- Prospects / Contato").
 *     Dispara 1× por (agente, contato) — dedup em triggered_automations.
 *  2. Cria regra NOVA no evento `booked` → `add_tag: agendado-anuncio-ia`.
 *     O ramo 11b do queue-processor casa `trigger.event === finalStatus`.
 *
 * As tags nascem no 1º uso (o Spark Leads cria tag inexistente no POST).
 * O agente B (novos seguidores) vai receber o par `origem-seguidor-ia` /
 * `agendado-seguidor-ia` na Fase 3 — mesmo desenho.
 *
 *   npx tsx scripts/apply-bianca-fase1.ts [--revert] [--dry]
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "@/lib/supabase/admin";
import type { AutomationRule } from "@/types/agent";

const AGENT_ID = "17860a86-ace9-4299-9328-2452151348a0";
const TAG_ORIGEM = "origem-anuncio-ia";
const TAG_AGENDADO = "agendado-anuncio-ia";
const REGRA_BOOKED_ID = "bia-booked-anuncio";

const REVERT = process.argv.includes("--revert");
const DRY = process.argv.includes("--dry");

/* BACKUP VERBATIM (lido do banco 26/08, pré-Fase 1) */
const AUTOMATIONS_ANTIGAS: AutomationRule[] = [
  {
    id: "i2wnvggc",
    actions: [
      {
        tag: "",
        type: "move_pipeline",
        stage_id: "0488943b-730a-4143-ad16-2cb215889dbf",
        pipeline_id: "hU4StRMnVekmux8LAZWJ",
      },
    ],
    trigger: { kind: "agent_activated" },
  },
];

async function main() {
  const sb = createAdminClient();
  const { data: cfg } = await sb
    .from("agent_configs")
    .select("automations")
    .eq("agent_id", AGENT_ID)
    .single();
  if (!cfg) { console.error("❌ config não encontrada"); process.exit(1); }

  if (REVERT) {
    if (DRY) { console.log("dry-run do revert"); process.exit(0); }
    await sb.from("agent_configs")
      .update({ automations: AUTOMATIONS_ANTIGAS, updated_at: new Date().toISOString() })
      .eq("agent_id", AGENT_ID);
    console.log("↩️  REVERTIDO: automations restauradas verbatim (só o move_pipeline).");
    process.exit(0);
  }

  const atuais = (cfg.automations || []) as AutomationRule[];

  // 1) add_tag de origem na regra de ativação (idempotente)
  const novas: AutomationRule[] = atuais.map((r) => {
    if (r.trigger?.kind !== "agent_activated") return r;
    const jaTem = r.actions.some((a) => a.type === "add_tag" && a.tag === TAG_ORIGEM);
    if (jaTem) return r;
    return { ...r, actions: [...r.actions, { type: "add_tag" as const, tag: TAG_ORIGEM }] };
  });

  // 2) regra de booked (idempotente)
  if (!novas.some((r) => r.id === REGRA_BOOKED_ID)) {
    novas.push({
      id: REGRA_BOOKED_ID,
      trigger: { kind: "event", event: "booked" },
      actions: [{ type: "add_tag", tag: TAG_AGENDADO }],
    });
  }

  console.log("=== FASE 1 — marcação de origem (agente A) ===");
  for (const r of novas) {
    const t = r.trigger?.kind === "event" ? `event:${r.trigger.event}` : r.trigger?.kind || "(legado)";
    console.log(`  regra ${r.id} [${t}] → ${r.actions.map((a) => `${a.type}${a.tag ? `(${a.tag})` : ""}`).join(" · ")}`);
  }

  if (DRY) { console.log("\n(dry-run — nada gravado)"); process.exit(0); }

  const { error } = await sb
    .from("agent_configs")
    .update({ automations: novas, updated_at: new Date().toISOString() })
    .eq("agent_id", AGENT_ID);
  if (error) { console.error("❌", error.message); process.exit(1); }

  const { data: check } = await sb
    .from("agent_configs").select("automations").eq("agent_id", AGENT_ID).single();
  const rr = (check?.automations || []) as AutomationRule[];
  const temOrigem = rr.some((r) => r.trigger?.kind === "agent_activated" && r.actions.some((a) => a.type === "add_tag" && a.tag === TAG_ORIGEM));
  const temBooked = rr.some((r) => r.id === REGRA_BOOKED_ID && r.actions.some((a) => a.tag === TAG_AGENDADO));
  const movePreservado = rr.some((r) => r.actions.some((a) => a.type === "move_pipeline"));

  console.log("\n=== VERIFICAÇÃO (relido do banco) ===");
  console.log(`  origem-anuncio-ia na ativação: ${temOrigem ? "✅" : "❌"}`);
  console.log(`  agendado-anuncio-ia no booked: ${temBooked ? "✅" : "❌"}`);
  console.log(`  move_pipeline preservado:      ${movePreservado ? "✅" : "❌"}`);
  const ok = temOrigem && temBooked && movePreservado;
  console.log(ok ? "\n✅ Fase 1 aplicada." : "\n❌ divergente");
  console.log("Rollback: npx tsx scripts/apply-bianca-fase1.ts --revert");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error("ERR:", e?.message || e); process.exit(1); });
