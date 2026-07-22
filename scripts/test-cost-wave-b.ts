/**
 * Testes da Onda B deploy 1 (dieta do prefixo, 2026-07-21):
 *  B3 — prefixo global: system byte-IDÊNTICO entre reps diferentes do mesmo config;
 *       bloco por-rep (buildRepContextBlock) carrega TUDO que saiu do system.
 *  B0 — call_usage: shape + presença nos returns (estático).
 *  B2 — dieta de descriptions: nenhuma tool perdida, required do confirmed_by_rep
 *       intacto, FEL_DOCS 1x só no catálogo vivo, bloco de tools encolheu.
 *
 * Rodar: npx tsx -r tsconfig-paths/register scripts/test-cost-wave-b.ts
 */
import { readFileSync } from "fs";
import { resolve } from "path";
import {
  buildSparkbotSystemPrompt,
  buildSparkbotRuntimeContext,
  buildRepContextBlock,
  type BuildPromptArgs,
} from "@/lib/account-assistant/prompt-builder";
import { getAllToolDefinitions } from "@/lib/account-assistant/tools";
import type { RepIdentity } from "@/types/account-assistant";

let pass = 0, fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { pass++; console.log(`  ✅ ${name}`); }
  else { fail++; console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`); }
}

function makeRep(over: Record<string, unknown>): RepIdentity {
  return {
    id: "rep-1", phone: "+15555550100", display_name: "Rep Um",
    ghl_users: [{ location_id: "loc1", ghl_user_id: "U1" }],
    active_location_id: "loc1",
    profile: { preferences: { verbosity: "normal" }, aliases: {} },
    terms_accepted_at: "2026-01-01T00:00:00Z",
    unanswered_count: 0, unanswered_pause_until: null,
    timezone: "America/New_York", timezone_confirmed_at: "2026-01-01T00:00:00Z",
    is_internal: false,
    ...over,
  } as unknown as RepIdentity;
}

function args(rep: RepIdentity, over: Partial<BuildPromptArgs> = {}): BuildPromptArgs {
  return {
    rep, locationName: "Brazillionaires", locationTimezone: "America/New_York",
    locale: "pt-BR", confirmationMode: "high_only", carrierOverview: "",
    channel: "whatsapp", customInstructions: null, kbInstructions: null,
    kbItems: [], tones: {}, conversationalLayer: {}, ...over,
  };
}

// ─── B3: system byte-idêntico entre reps ─────────────────────────────────────
console.log("\nB3 — prefixo global (system rep-invariante)");
const repA = makeRep({});
const repB = makeRep({
  id: "rep-2", phone: "+15555559999", display_name: "Manuela Diferente",
  timezone: "America/Sao_Paulo",
  ghl_users: [{ location_id: "loc1", ghl_user_id: "U2" }, { location_id: "loc2", ghl_user_id: "U2b" }],
  profile: {
    preferences: { verbosity: "brief", preferred_name: "Manu", tone: "casual" },
    aliases: { M3: "Inscrito M3", premium: "opp > 50k" },
    notes: ["gosta de áudio"],
    manual_context: ["Sempre usar a tag X no fim"],
  },
});
const sysA = buildSparkbotSystemPrompt(args(repA));
const sysB = buildSparkbotSystemPrompt(args(repB));
check("system de 2 reps MUITO diferentes é byte-IDÊNTICO", sysA === sysB,
  `lenA=${sysA.length} lenB=${sysB.length}`);
// "Manuela" solta existe ESTÁTICA no prompt (case-note H42) — checa o display_name completo.
check("system não contém mais nome do rep", !sysA.includes("Rep Um") && !sysB.includes("Manuela Diferente"));
check("system não contém mais phone do rep", !sysA.includes("+15555550100"));
// A linha "EXCEÇÃO DE CONFIANÇA" (review Onda B) CITA os nomes das seções no system
// (estática, rep-invariante) — o que não pode existir é a SEÇÃO com dados do rep.
check("system não contém mais a SEÇÃO CONTEXTO DO REP (Nome:/Phone:)", !sysA.includes("\nNome: ") && !sysA.includes("\nPhone: "));
check("system não contém mais a SEÇÃO MEMÓRIA (Sem observações)", !sysA.includes("Sem observações ainda"));
check("system não contém mais a SEÇÃO FORMATO DE HORA (Use formato)", !sysA.includes("Use formato 24h") && !sysA.includes("Use formato AM/PM"));
check("system menciona a exceção de confiança dos blocos injetados", sysA.includes("EXCEÇÃO DE CONFIANÇA"));
// locale/timezone saíram junto — system também é timezone-invariante
const sysC = buildSparkbotSystemPrompt(args(makeRep({ timezone: "America/Sao_Paulo" }), { locationTimezone: "America/Sao_Paulo" }));
check("system é timezone-invariante (NY vs SP idênticos)", sysA === sysC);

// ─── B3: bloco por-rep carrega tudo que saiu ─────────────────────────────────
console.log("\nB3 — buildRepContextBlock (conteúdo verbatim)");
const blockB = buildRepContextBlock({ rep: repB, locationName: "Brazillionaires", locationTimezone: "America/Sao_Paulo", locale: "pt-BR" });
check("bloco tem # FORMATO DE HORA com o fuso", blockB.includes("# FORMATO DE HORA") && blockB.includes("America/Sao_Paulo"));
check("bloco tem # CONTEXTO DO REP com preferred_name", blockB.includes("# CONTEXTO DO REP") && blockB.includes("Nome: Manu"));
check("bloco tem phone e location", blockB.includes("+15555559999") && blockB.includes("Location ativa: Brazillionaires"));
check("bloco tem aviso multi-location (rep com 2)", blockB.includes("trabalha em 2 locations") && blockB.includes("switch_active_location"));
check("bloco tem # MEMÓRIA com manual_context e aliases", blockB.includes("INSTRUÇÕES MANUAIS") && blockB.includes('"premium"'));
check("bloco tem regra do set_rep_preferred_name (H42)", blockB.includes("set_rep_preferred_name"));
const blockA = buildRepContextBlock({ rep: repA, locationName: "Brazillionaires", locationTimezone: "America/New_York", locale: "pt-BR" });
check("rep single-location NÃO ganha aviso multi-location", !blockA.includes("trabalha em"));
check("rep sem memória ganha '# MEMÓRIA\\nSem observações'", blockA.includes("Sem observações ainda"));

// ─── B3: runtime context inclui o bloco ──────────────────────────────────────
const rc = buildSparkbotRuntimeContext({
  locationTimezone: "America/New_York", locale: "pt-BR", channel: "whatsapp",
  repContextBlock: blockA,
});
check("runtime context inclui o repContextBlock", rc.includes("# CONTEXTO DO REP") && rc.includes("[Agora:"));
const rcSem = buildSparkbotRuntimeContext({ locationTimezone: "America/New_York", locale: "pt-BR" });
check("runtime context sem bloco não quebra", !rcSem.includes("# CONTEXTO DO REP") && rcSem.includes("[Agora:"));

// ─── B2: catálogo íntegro + dieta efetiva ────────────────────────────────────
console.log("\nB2 — dieta de descriptions (catálogo íntegro)");
const defs = getAllToolDefinitions("high_only");
const byName = new Map(defs.map((d) => [d.name, d]));
check(`catálogo mantém as tools (${defs.length} defs, nenhuma sumiu)`, defs.length >= 90, `got ${defs.length}`);
const createAppt = byName.get("create_appointment");
const apptProps = (createAppt?.parameters as { properties?: Record<string, unknown>; required?: string[] }) || {};
check("create_appointment: confirmed_by_rep AINDA no schema (required intacto)",
  !!apptProps.properties?.confirmed_by_rep && (apptProps.required || []).includes("confirmed_by_rep"));
check("create_appointment: description curta mas com confirm-first + pointer",
  (createAppt?.description || "").length < 500 && (createAppt?.description || "").includes("# AGENDAR REUNIÃO"));
const serialized = JSON.stringify(defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters })));
check(`bloco de tools encolheu (${serialized.length} chars < 94000; era ~103K = ~11K de dieta)`, serialized.length < 94_000, `got ${serialized.length}`);
const felCount = (serialized.match(/FILTER \(FEL\) — formato JSON/g) || []).length;
check(`FEL_DOCS aparece no máx 1x no catálogo vivo (got ${felCount})`, felCount <= 1);
check("get_contacts_filtered aponta pra seção do system",
  (byName.get("get_contacts_filtered")?.description || "").includes("# FILTER ENGINE"));
// 6 tools triviais (get_note, add_tag...) sempre tiveram description curta (mín 28) — pré-existente.
check("toda tool segue com description não-vazia",
  defs.every((d) => (d.description || "").trim().length >= 20));
const boiler = String((apptProps.properties?.confirmed_by_rep as { description?: string })?.description || "");
check(`boilerplate confirmed_by_rep enxuto (${boiler.length} chars < 220)`, boiler.length > 60 && boiler.length < 220);

// ─── B0: estático ────────────────────────────────────────────────────────────
console.log("\nB0 — telemetria call_usage (estático)");
const llm = readFileSync(resolve(__dirname, "..", "src/lib/account-assistant/llm-client.ts"), "utf8");
check("llm-client acumula call_usage por iteração", llm.includes("call_usage.push({"));
check("todos os returns do runWithClaude levam call_usage", (llm.match(/^\s{4}call_usage,$/gm) || []).length >= 5);
const wh = readFileSync(resolve(__dirname, "..", "src/lib/account-assistant/webhook-handler.ts"), "utf8");
check("webhook-handler persiste metadata.call_usage", wh.includes("call_usage: result.call_usage"));

// ─── Medição (informativo) ───────────────────────────────────────────────────
console.log("\n📏 MEDIÇÃO do prefixo (chars):");
console.log(`  system (rep-invariante): ${sysA.length} chars`);
console.log(`  tools serializadas: ${serialized.length} chars`);
console.log(`  bloco por-rep (agora na user msg): A=${blockA.length} / B=${blockB.length} chars`);

console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
process.exit(fail > 0 ? 1 : 0);
