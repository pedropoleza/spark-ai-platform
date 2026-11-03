/**
 * H90 — entrada pela automação: a IA cala na 1ª mensagem do lead, assume na 2ª.
 * H111: a mesma regra só pra quem tem a etiqueta configurada; {contact.id} nas instruções.
 * Rodar: npx tsx scripts/test-entry-by-automation.ts
 */
import {
  deveSilenciarEntrada,
  entradaVaiPelaAutomacao,
  etiquetaDaEntrada,
  type EntradaInput,
} from "@/lib/queue/entry-by-automation";
import { buildSystemPrompt } from "@/lib/ai/sales-prompt-builder";

let pass = 0, fail = 0;
const ok = (nome: string, cond: boolean) => { if (cond) { pass++; console.log(`  ✅ ${nome}`); } else { fail++; console.log(`  ❌ ${nome}`); } };
const base: EntradaInput = { entryByAutomation: true, manuallyResumed: false, syntheticTrigger: false, conversationActive: false, entrySuppressedAt: null, inboundsAnteriores: 0 };

console.log("\n1) O fluxo da Márcia");
ok("1ª mensagem do lead (clique no anúncio) → cala", deveSilenciarEntrada(base));
ok("2ª mensagem (resposta à automação) → fala", !deveSilenciarEntrada({ ...base, inboundsAnteriores: 1 }));
ok("já silenciou antes → fala (nunca duas vezes)", !deveSilenciarEntrada({ ...base, entrySuppressedAt: "2026-09-03T21:00:00Z" }));
ok("conversa já ativa → fala", !deveSilenciarEntrada({ ...base, conversationActive: true }));

console.log("\n2) Quando a IA tem ordem explícita de falar");
ok("'Ativar IA' no painel (ai_resumed_at) → fala", !deveSilenciarEntrada({ ...base, manuallyResumed: true }));
ok("turno proativo nosso (syntheticTrigger) → fala", !deveSilenciarEntrada({ ...base, syntheticTrigger: true }));

console.log("\n3) Flag desligada = frota intacta");
ok("entry_by_automation=false → nunca cala", !deveSilenciarEntrada({ ...base, entryByAutomation: false }));

console.log("\n4) H111: entrada pela automação por etiqueta (Bruno, Alves Cury)");
const ETQ = "lp carreira - saudacao";
ok("sem etiqueta configurada → vale pra todos (H90)", entradaVaiPelaAutomacao(null, []) && entradaVaiPelaAutomacao("", null));
ok("contato do formulário (tem a etiqueta) → a automação abre", entradaVaiPelaAutomacao(ETQ, ["ads_recruit", "lp carreira - saudacao"]));
ok("anúncio direto, Instagram ou ligado à mão (sem a etiqueta) → a IA atende", !entradaVaiPelaAutomacao(ETQ, ["ads_recruit"]));
ok("não leu as etiquetas → a IA atende (lead mudo é pior)", !entradaVaiPelaAutomacao(ETQ, null));
ok("caixa e espaço não decidem", entradaVaiPelaAutomacao("  LP Carreira - Saudacao ", ["lp carreira - saudacao"]));
ok("etiqueta parecida não vale", !entradaVaiPelaAutomacao(ETQ, ["lp carreira - saudacao enviada", "lp carreira"]));
ok("config: só espaços = sem etiqueta", etiquetaDaEntrada({ entry_by_automation_tag: "   " }) === null && etiquetaDaEntrada(null) === null);
ok("config: normaliza", etiquetaDaEntrada({ entry_by_automation_tag: " LP Carreira - Saudacao" }) === "lp carreira - saudacao");

console.log("\n5) H111: {contact.id} nas instruções do admin (link da landing)");
const ctxBase = {
  config: {
    custom_instructions: "Link do vídeo: https://career.alvescuryfinancial.com/?cid={contact.id}#video",
    personality: { name: "Bruno" },
    data_fields: [],
    objective: "schedule_meeting",
    tone_creativity: 5,
    tone_formality: 5,
    tone_naturalness: 5,
    tone_aggressiveness: 5,
    enabled_channels: ["WhatsApp"],
    follow_up_config: { enabled: false, mode: "manual", intensity: 3, max_attempts: 0, min_delay_minutes: 60, max_delay_minutes: 60, manual_steps: [] },
  },
  agentType: "recruitment_agent",
  contactName: "Juan",
  collectedData: {},
  locationName: "Alves Cury Financial",
  currentDate: "terça, 03/11/2026, 18:00",
  timezone: "America/New_York",
  availableSlots: "",
} as unknown as Parameters<typeof buildSystemPrompt>[0];
const comId = buildSystemPrompt({ ...ctxBase, contactId: "kwK96WGnSUE7egCOSKWd" });
ok("com id: o link sai com o cid do contato", comId.includes("?cid=kwK96WGnSUE7egCOSKWd#video"));
ok("com id: nenhum {contact.id} literal", !comId.includes("{contact.id}"));
const semId = buildSystemPrompt(ctxBase);
ok("sem id: vira vazio (a landing abre sem medir), nunca o literal", semId.includes("?cid=#video") && !semId.includes("{contact.id}"));

console.log(`\n${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
