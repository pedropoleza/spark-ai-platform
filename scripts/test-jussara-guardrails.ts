/**
 * Teste dos guardrails da religação da Jussara (item 4f do council).
 *
 * NÃO escreve nada: nem na config, nem em agent_test_sessions, nem no Spark
 * Leads. Lê a config real, aplica o patch proposto EM MEMÓRIA e roda contra ele.
 *
 * Duas partes, de propósito:
 *  A) gates determinísticos — é onde o guardrail realmente mora. Roda as funções
 *     de produção (`deveSilenciarEntrada`, `pickTriggeredDataFieldRules`).
 *  B) conversa com o LLM real, com o prompt de produção montado sobre a config
 *     proposta. Prova o que o modelo FALA, não o que o motor GARANTE.
 *
 *   npx tsx scripts/test-jussara-guardrails.ts          # só a parte A (grátis)
 *   npx tsx scripts/test-jussara-guardrails.ts --llm    # A + B (gasta tokens)
 */
import { config as env } from "dotenv";
import { resolve } from "path";
env({ path: resolve(__dirname, "..", ".env.local") });
import { createAdminClient } from "../src/lib/supabase/admin";
import { deveSilenciarEntrada } from "../src/lib/queue/entry-by-automation";
import { pickTriggeredDataFieldRules } from "../src/lib/ai/reaction-engine";
import { buildSystemPrompt, buildRuntimeContext, buildResponseJsonSchema } from "../src/lib/ai/sales-prompt-builder";
import { processWithAI, type ConversationTurn } from "../src/lib/ai/openai-client";
import { ALVO } from "./jussara-guardrails";
import type { AgentConfig, AutomationRule } from "../src/types/agent";

const AGENT = "a297dadc-873a-4803-885d-472c65414168";
const COM_LLM = process.argv.includes("--llm");
let ok = 0, fail = 0;
function t(nome: string, cond: boolean, detalhe = "") {
  if (cond) { ok++; console.log(`  ✅ ${nome}`); }
  else { fail++; console.log(`  ❌ ${nome}${detalhe ? `  → ${detalhe}` : ""}`); }
}
const h = (s: string) => console.log(`\n${"=".repeat(70)}\n${s}\n${"=".repeat(70)}`);

/** Espelha isWithinWorkingHours do webhook (função local lá, não exportada). */
function dentroDaJanela(wh: typeof ALVO.working_hours, quando: Date): boolean {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: wh.timezone, weekday: "long", hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(quando);
  const dia = p.find((x) => x.type === "weekday")?.value?.toLowerCase() || "";
  const min = parseInt(p.find((x) => x.type === "hour")?.value || "0") * 60
            + parseInt(p.find((x) => x.type === "minute")?.value || "0");
  const d = (wh.schedule as Record<string, { enabled: boolean; start: string; end: string }>)[dia];
  if (!d?.enabled) return false;
  const [sh, sm] = d.start.split(":").map(Number);
  const [eh, em] = d.end.split(":").map(Number);
  return min >= sh * 60 + sm && min <= eh * 60 + em;
}

async function main() {
  const sb = createAdminClient();
  const { data } = await sb.from("agent_configs").select("*").eq("agent_id", AGENT).single();
  const base = data as unknown as AgentConfig;
  const proposta = {
    ...base,
    ...ALVO,
    data_fields: (base.data_fields || []).map((f) =>
      f.key === "has_disease" || f.key === "takes_medication" ? { ...f, required: true } : f),
  } as unknown as AgentConfig;

  h("A. GATES DETERMINÍSTICOS (config proposta, funções de produção)");

  console.log("\nA1. Entrada pela automação (4d) — quem fala no 1º turno");
  t("1ª mensagem do lead: IA CALA (o workflow já responde)",
    deveSilenciarEntrada({ entryByAutomation: true, manuallyResumed: false, syntheticTrigger: false,
      conversationActive: false, entrySuppressedAt: null, inboundsAnteriores: 0 }) === true);
  t('resposta do menu ("2"): IA ASSUME',
    deveSilenciarEntrada({ entryByAutomation: true, manuallyResumed: false, syntheticTrigger: false,
      conversationActive: false, entrySuppressedAt: null, inboundsAnteriores: 1 }) === false);
  t("não silencia duas vezes (entry_suppressed_at já gravado)",
    deveSilenciarEntrada({ entryByAutomation: true, manuallyResumed: false, syntheticTrigger: false,
      conversationActive: false, entrySuppressedAt: "2026-09-24T00:00:00Z", inboundsAnteriores: 0 }) === false);
  t('"Ativar IA" no painel manda falar mesmo no 1º turno',
    deveSilenciarEntrada({ entryByAutomation: true, manuallyResumed: true, syntheticTrigger: false,
      conversationActive: false, entrySuppressedAt: null, inboundsAnteriores: 0 }) === false);

  console.log("\nA2. Handoff por saúde (4a) — o gate que impede o agendamento");
  const regras = ALVO.automations as unknown as AutomationRule[];
  const disp = (prev: Record<string,string>, next: Record<string,string>) =>
    pickTriggeredDataFieldRules(regras, prev, next, new Set()).map(r => r.id);
  t('has_disease "sim" → dispara', disp({}, { has_disease: "sim" }).includes("saude-doenca"));
  t('has_disease "Sim" (maiúscula) → dispara', disp({}, { has_disease: "Sim" }).includes("saude-doenca"));
  t('has_disease "sim, tenho diabetes" → dispara', disp({}, { has_disease: "sim, tenho diabetes" }).includes("saude-doenca"));
  t('has_disease "não" → NÃO dispara', disp({}, { has_disease: "não" }).length === 0);
  t('"assim que puder" → NÃO dispara (âncora ^)', disp({}, { has_disease: "assim que puder" }).length === 0);
  t('takes_medication "sim" → dispara', disp({}, { takes_medication: "sim" }).includes("saude-remedio"));
  t("campo inalterado não redispara", disp({ has_disease: "sim" }, { has_disease: "sim" }).length === 0);
  const acoes = regras[0].actions.map(a => a.type);
  t("ações na ordem certa: avisa o lead → etiqueta → pausa",
    JSON.stringify(acoes) === JSON.stringify(["send_text_fixed","add_tag","pause_ai"]), JSON.stringify(acoes));

  console.log("\nA3. Janela de atividade (4b)");
  const wh = ALVO.working_hours;
  const dias = Object.values(wh.schedule as Record<string, {enabled:boolean}>);
  t("schedule NÃO está vazio (senão cai no fail-open do H52 e calaria a conta)",
    dias.length === 7 && dias.every(d => d.enabled));
  const em = (iso: string) => new Date(iso);
  t("02:00 ET → FORA da janela (vira fila pra 08:00)", dentroDaJanela(wh, em("2026-09-25T06:00:00Z")) === false);
  t("09:00 ET → dentro", dentroDaJanela(wh, em("2026-09-25T13:00:00Z")) === true);
  t("20:59 ET → dentro", dentroDaJanela(wh, em("2026-09-25T00:59:00Z")) === true);
  t("21:30 ET → fora", dentroDaJanela(wh, em("2026-09-25T01:30:00Z")) === false);
  t("sábado 10:00 ET → dentro (ela atende todo dia)", dentroDaJanela(wh, em("2026-09-26T14:00:00Z")) === true);

  console.log("\nA4. O que NÃO pode ter mudado");
  t("targeting_rules intacto (8 folhas do gate-ponte)",
    ((proposta.targeting_rules as {groups?:Array<{rules?:unknown[]}>})?.groups?.[0]?.rules?.length) === 8);
  t('regra "não sou robô" intacta nas custom_instructions',
    /N[ÃA]O é IA, bot, assistente/i.test(String(proposta.custom_instructions || "")));
  t("post_booking segue stop_and_handoff",
    (proposta.post_booking as {behavior?:string})?.behavior === "stop_and_handoff");

  if (!COM_LLM) {
    h(`RESULTADO PARCIAL: ${ok} ok, ${fail} falhas  (parte B: rode com --llm)`);
    process.exit(fail ? 1 : 0);
  }

  h("B. CONVERSA COM O LLM REAL (prompt de produção sobre a config proposta)");
  const ctxBase = {
    config: proposta, agentType: "sales_agent" as const, contactName: "Camila",
    locationName: "Jussara Ferreira's Account", timezone: "America/New_York",
    currentDate: new Date().toLocaleString("pt-BR", { timeZone: "America/New_York" }),
    availableSlots: "quinta 25/09: 10:00, 14:00, 16:00\nsexta 26/09: 09:00, 11:00",
  };
  // O lead chega DEPOIS do workflow: essas 3 linhas já existem na conversa.
  const historicoWorkflow: ConversationTurn[] = [
    { role: "user", content: "Tenho interesse e queria mais informações" },
    { role: "assistant", content: "Oiê 😊 Aqui é a Jussara Lima, Agente Financeira Licenciada pelo Governo americano dos Estados Unidos." },
    { role: "assistant", content: "Qual destes assuntos despertou seu interesse? 1️⃣ Seguro de Vida com Benefício em Vida 2️⃣ Aposentadoria 3️⃣ Planejamento" },
  ];

  async function conversa(nome: string, falas: string[]) {
    console.log(`\n### ${nome}`);
    const turns: ConversationTurn[] = [...historicoWorkflow];
    let coletado: Record<string, string> = {};
    for (const fala of falas) {
      const ctx = { ...ctxBase, collectedData: coletado, priorTurnCount: turns.length };
      const sys = buildSystemPrompt(ctx);
      const rt = buildRuntimeContext(ctx);
      const r = await processWithAI({
        systemPrompt: sys, runtimeContext: rt, conversationMessages: turns,
        conversationHistory: "", newMessages: fala, model: String(proposta.ai_model || "claude-sonnet-4-6"),
        responseSchema: buildResponseJsonSchema(ctx), priorTurnCount: turns.length,
      });
      const resp = r.response;
      const msg = Array.isArray(resp?.message) ? resp.message.join(" | ") : String(resp?.message ?? "");
      coletado = { ...coletado, ...(resp?.collected_data || {}) };
      console.log(`\n  👤 ${fala}`);
      console.log(`  🤖 ${msg.slice(0, 300)}`);
      console.log(`     status=${resp?.conversation_status} actions=${JSON.stringify((resp?.actions||[]).map((a:{type:string})=>a.type))}`);
      console.log(`     coletado=${JSON.stringify(coletado)}`);
      turns.push({ role: "user", content: fala }, { role: "assistant", content: msg });
    }
    return coletado;
  }

  const c1 = await conversa("B1 — lead saudável até o agendamento", [
    "2", "Moro na Flórida", "Não, nenhuma doença", "Não tomo remédio nenhum", "Pode ser quinta às 10",
  ]);
  t("B1 coletou o estado", !!c1.state);
  t("B1 registrou saúde negativa", /n[ãa]o/i.test(c1.has_disease || ""));

  const c2 = await conversa("B2 — lead com doença (deve virar handoff)", [
    "2", "Moro na Geórgia", "Tenho sim, faço tratamento de câncer",
  ]);
  t("B2 gravou has_disease com 'sim' (é o que dispara a automação)",
    /^\s*sim\b/i.test(c2.has_disease || ""), `has_disease=${JSON.stringify(c2.has_disease)}`);
  t("B2 o gate dispararia de fato",
    pickTriggeredDataFieldRules(regras, {}, c2 as Record<string,string>, new Set()).length > 0);

  h(`RESULTADO: ${ok} ok, ${fail} falhas`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error("FATAL:", e); process.exit(1); });
