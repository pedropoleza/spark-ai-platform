/**
 * Simula o "Salvar" do painel do agente pra CADA agente real, sem gravar nada.
 *
 *   npx tsx scripts/test-salvar-config-agentes.ts
 *
 * Caminho idêntico ao da UI: config do banco (select *) → makeSeed →
 * buildConfigPayload → updateAgentConfigSchema (o zod do PUT). Mede duas coisas:
 *
 *  1. SAVE BLOQUEADO: o zod recusa (foi o caso reportado em 13/10: instrução >
 *     8000 chars e regra de desligamento sem id → "Não consegui salvar").
 *  2. APAGADO NO SAVE: caminho que existe no banco e some do que a rota grava.
 *     A rota persiste o objeto VALIDADO inteiro por coluna, então chave que o
 *     painel não carrega (makeSeed) ou que o zod não conhece some do banco no
 *     primeiro save. Foi assim com require_contact_before_booking (H72) e quase
 *     com alerta_whatsapp (H83).
 *
 * Sai com código 1 se qualquer agente tiver (1) ou (2).
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { makeSeed, buildConfigPayload } from "../src/app/hub/agents/[agentId]/config-payload";
import { updateAgentConfigSchema } from "../src/lib/utils/validation";

type Json = unknown;
const ehObj = (v: Json): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const vazio = (v: Json) => v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

/** Caminhos com valor no `antes` que não existem no `depois`. Arrays: compara item a item. */
function sumiu(antes: Json, depois: Json, base: string, out: string[]) {
  if (vazio(antes)) return;
  if (ehObj(antes)) {
    if (!ehObj(depois)) { out.push(base); return; }
    for (const [k, v] of Object.entries(antes)) {
      if (vazio(v)) continue;
      if (!(k in depois) || depois[k] === undefined) out.push(`${base}.${k}`);
      else sumiu(v, depois[k], `${base}.${k}`, out);
    }
    return;
  }
  if (Array.isArray(antes) && Array.isArray(depois)) {
    antes.forEach((item, i) => {
      // O painel descarta de propósito item incompleto (regra sem tag, automação
      // sem ação); por isso só compara itens que continuam na mesma posição.
      if (i < depois.length) sumiu(item, depois[i], `${base}[${i}]`, out);
    });
  }
}

/** Mesma regra dos módulos ligados que a UI usa pros flags de on/off. */
function modulosLigados(cfg: Record<string, Json>): Set<string> {
  const on = new Set<string>();
  if ((cfg.working_hours as { enabled?: boolean } | null)?.enabled) on.add("active_hours");
  if ((cfg.follow_up_config as { enabled?: boolean } | null)?.enabled) on.add("followup");
  if ((cfg.outreach_config as { enabled?: boolean } | null)?.enabled) on.add("outreach");
  return on;
}

(async () => {
  const sb = createAdminClient();
  const { data: agentes, error } = await sb.from("agents").select("id,name,type,status,location_id");
  if (error) throw new Error(error.message);
  const { data: cfgs, error: e2 } = await sb.from("agent_configs").select("*");
  if (e2) throw new Error(e2.message);
  const porAgente = new Map((cfgs || []).map((c) => [String(c.agent_id), c as Record<string, Json>]));

  let bloqueados = 0, comPerda = 0, ok = 0;
  const motivos = new Map<string, number>();
  for (const a of agentes || []) {
    const cfg = porAgente.get(a.id);
    if (!cfg) continue;
    const payload = buildConfigPayload(makeSeed(cfg), modulosLigados(cfg)) as Record<string, Json>;
    const r = updateAgentConfigSchema.safeParse(payload);
    const rotulo = `${String(a.status).padEnd(8)} ${String(a.type).padEnd(17)} ${a.name} (${a.id.slice(0, 8)})`;
    if (!r.success) {
      bloqueados++;
      const msgs = r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`);
      for (const i of r.error.issues) {
        const chave = `${i.path.filter((p) => typeof p === "string").join(".")}: ${i.message}`;
        motivos.set(chave, (motivos.get(chave) || 0) + 1);
      }
      console.log(`❌ SAVE BLOQUEADO  ${rotulo}\n     ${msgs.slice(0, 4).join("\n     ")}`);
      continue;
    }
    // O que a rota grava = colunas do objeto validado (null/undefined são filtrados).
    const gravado = Object.fromEntries(Object.entries(r.data as Record<string, Json>).filter(([, v]) => v != null));
    const perdas: string[] = [];
    for (const col of Object.keys(gravado)) sumiu(cfg[col], gravado[col], col, perdas);
    if (perdas.length) {
      comPerda++;
      for (const p of perdas) { const k = `apaga ${p.replace(/\[\d+\]/g, "[]")}`; motivos.set(k, (motivos.get(k) || 0) + 1); }
      console.log(`⚠️  APAGA NO SAVE   ${rotulo}\n     ${perdas.slice(0, 6).join(", ")}${perdas.length > 6 ? ` (+${perdas.length - 6})` : ""}`);
      continue;
    }
    ok++;
  }

  // Casos de 13/10, fixos: protegem mesmo quando os dados do banco mudarem.
  console.log("\ncasos fixos (13/10):");
  let falhaCaso = 0;
  const caso = (nome: string, cond: boolean) => { console.log(`  ${cond ? "✅" : "❌"} ${nome}`); if (!cond) falhaCaso++; };
  const base = (extra: Record<string, Json>) => buildConfigPayload(makeSeed({ ...extra }), new Set()) as Record<string, Json>;
  const p1 = updateAgentConfigSchema.safeParse(base({ custom_instructions: "x".repeat(16000) }));
  caso("instrução com 16000 chars salva", p1.success);
  caso("instrução com 16001 chars é recusada", !updateAgentConfigSchema.safeParse(base({ custom_instructions: "x".repeat(16001) })).success);
  const p2 = updateAgentConfigSchema.safeParse(base({ deactivation_rules: [{ type: "custom_field_equals", field_key: "AI", field_value: "Off" }] }));
  const idGerado = p2.success ? (p2.data.deactivation_rules?.[0] as { id?: string } | undefined)?.id : undefined;
  caso("regra de desligamento sem id salva e ganha id", p2.success && typeof idGerado === "string" && idGerado.length > 0);
  // Sem passar pelo painel (script/rota direta): o zod também gera o id.
  const p3 = updateAgentConfigSchema.safeParse({ deactivation_rules: [{ type: "tag_added", tag: "x" }] });
  caso("zod gera id mesmo sem o painel", p3.success && !!(p3.data.deactivation_rules?.[0] as { id?: string } | undefined)?.id);
  const p4 = updateAgentConfigSchema.safeParse(base({ automations: [{ id: "a1", trigger: { kind: "agent_activated" }, actions: [{ type: "create_opportunity", pipeline_id: "p", stage_id: "s", opportunity_name: "Lead Carreira" }] }] }));
  const acao = p4.success ? ((p4.data.automations?.[0] as { actions: Array<{ opportunity_name?: string }> } | undefined)?.actions[0]) : undefined;
  caso("automação create_opportunity salva com o nome da oportunidade", p4.success && acao?.opportunity_name === "Lead Carreira");
  const p5 = updateAgentConfigSchema.safeParse(base({ handoff_policy: { enabled: true, notify_rep_on_llm_handoff: true } }));
  caso("aviso de handoff (H85) sobrevive ao save", p5.success && (p5.data.handoff_policy as { notify_rep_on_llm_handoff?: boolean } | null | undefined)?.notify_rep_on_llm_handoff === true);
  const p6 = updateAgentConfigSchema.safeParse(base({ handoff_policy: { enabled: true } }));
  caso("sem H85 no banco, o save não inventa o campo", p6.success && (p6.data.handoff_policy as Record<string, unknown> | null | undefined)?.notify_rep_on_llm_handoff === undefined);

  console.log(`\nRESUMO: ${ok} salvam limpo · ${bloqueados} com save bloqueado · ${comPerda} perderiam config no save · ${falhaCaso} caso(s) fixo(s) falhando`);
  if (motivos.size) {
    console.log("\nmotivos:");
    for (const [k, n] of [...motivos.entries()].sort((x, y) => y[1] - x[1])) console.log(`  ${String(n).padStart(3)}× ${k}`);
  }
  process.exit(bloqueados || comPerda || falhaCaso ? 1 : 0);
})();
