/**
 * H125: a etiqueta que chega DEPOIS da 1ª mensagem (que levou targeting_skip na corrida
 * com o debounce) registra a entrada e abre os follow-ups da entrada.
 * Rodar: npx tsx scripts/test-h125-entrada-etiqueta.ts
 */
import { etiquetaAbreEntrada, deveSilenciarEntrada, entradaJaPassouPeloGate } from "@/lib/queue/entry-by-automation";
let pass = 0, fail = 0;
const ok = (n: string, c: boolean) => { if (c) { pass++; console.log(`  ✅ ${n}`); } else { fail++; console.log(`  ❌ ${n}`); } };

// A corrida: 1ª mensagem pulada (sem conversation_state), etiqueta chega depois.
const naoPassou = entradaJaPassouPeloGate({ conversationActive: false, entrySuppressedAt: null });
ok("1ª mensagem pulada = entrada ainda não passou", naoPassou === false);
ok("etiqueta tardia abre a entrada (com follow-up na entrada)", etiquetaAbreEntrada({ passouPeloGate: naoPassou, startOnEntry: true }));
ok("sem o opt-in de follow-up na entrada, nada muda", !etiquetaAbreEntrada({ passouPeloGate: naoPassou, startOnEntry: false }));

// Entrada já registrada pela 1ª mensagem (o caminho de sempre): a etiqueta não faz nada.
const jaEntrou = entradaJaPassouPeloGate({ conversationActive: false, entrySuppressedAt: "2026-11-24T12:00:00Z" });
ok("entrada já registrada → a etiqueta não reabre", !etiquetaAbreEntrada({ passouPeloGate: jaEntrou, startOnEntry: true }));
// Conversa já ativa (a IA já falou): nada.
const ativa = entradaJaPassouPeloGate({ conversationActive: true, entrySuppressedAt: null });
ok("conversa ativa → a etiqueta não reabre", !etiquetaAbreEntrada({ passouPeloGate: ativa, startOnEntry: true }));

// Depois da entrada pela etiqueta, a resposta do lead NÃO é silenciada (a IA assume).
ok("resposta do lead depois da entrada pela etiqueta → a IA fala", !deveSilenciarEntrada({
  entryByAutomation: true, manuallyResumed: false, syntheticTrigger: false,
  conversationActive: false, entrySuppressedAt: "2026-11-24T12:00:00Z", inboundsAnteriores: 1,
}));
console.log(`\n${pass} ok · ${fail} falhas`);
process.exit(fail > 0 ? 1 : 0);
