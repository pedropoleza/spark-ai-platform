/**
 * H90 — entrada pela automação: a IA cala na 1ª mensagem do lead, assume na 2ª.
 * Rodar: npx tsx scripts/test-entry-by-automation.ts
 */
import { deveSilenciarEntrada, type EntradaInput } from "@/lib/queue/entry-by-automation";

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

console.log(`\n${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
