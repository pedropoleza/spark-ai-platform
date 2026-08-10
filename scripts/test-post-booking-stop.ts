/**
 * Caso Liberty Financial (location oEEbKRN0rQHdee13Bn1u), 2026-08-07:
 *   "o bot está continuando mesmo depois de fazer o agendamento — sendo que na
 *    configuração do AI Hub o agente está configurado para não continuar"
 *
 * O cliente estava certo. `post_booking.behavior = "stop_and_handoff"` estava
 * salvo na config e NUNCA era enforced no runtime — existia só como texto no
 * prompt ("NAO continue a conversa"), que o modelo lê no MESMO turno do
 * agendamento e esquece no seguinte.
 *
 * Provado no contato lWZEh9p46XcuWgITgIWa (Marta, 02/08):
 *   02:45:44  book_appointment ✅
 *   02:45:47  "Agendado, Marta!" + a mensagem de handoff
 *   02:46:32  book_appointment DE NOVO
 *   02:47:19  "Tenho disponibilidade na segunda às 10h AM ou às 2 PM ET..."
 *   02:49:50  book_appointment DE NOVO
 *   02:50:51  book_appointment DE NOVO
 *   08-03     conversa inteira no dia seguinte, re-oferecendo horário
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-post-booking-stop.ts
 */
import { devePausarAposAgendamento } from "@/lib/queue/queue-processor";

let falhas = 0;
function checa(nome: string, real: boolean, esperado: boolean, porque: string) {
  const ok = real === esperado;
  console.log(`  ${ok ? "✅" : "❌"} ${nome} → ${real ? "PAUSA" : "segue"} — ${porque}`);
  if (!ok) falhas++;
}

console.log("Política de parada pós-agendamento\n");

checa(
  "agendou + config 'parar e passar pra humano'",
  devePausarAposAgendamento({ finalStatus: "booked", behavior: "stop_and_handoff", jaPausado: false }),
  true,
  "é exatamente o que o cliente configurou e não acontecia",
);

checa(
  "agendou + config 'continuar até a reunião'",
  devePausarAposAgendamento({ finalStatus: "booked", behavior: "continue_until_appointment", jaPausado: false }),
  false,
  "quem escolheu continuar continua (é o outro agente da mesma conta)",
);

checa(
  "ainda não agendou (conversa ativa)",
  devePausarAposAgendamento({ finalStatus: "active", behavior: "stop_and_handoff", jaPausado: false }),
  false,
  "pausar aqui mataria a qualificação no meio",
);

checa(
  "qualificado mas sem reunião",
  devePausarAposAgendamento({ finalStatus: "qualified", behavior: "stop_and_handoff", jaPausado: false }),
  false,
  "o gatilho é a REUNIÃO, não o objetivo cumprido",
);

checa(
  "já estava pausado antes",
  devePausarAposAgendamento({ finalStatus: "booked", behavior: "stop_and_handoff", jaPausado: true }),
  false,
  "não reescreve o carimbo (lição H52: pausa que se renova vira permanente)",
);

checa(
  "config ausente (agente antigo)",
  devePausarAposAgendamento({ finalStatus: "booked", behavior: undefined, jaPausado: false }),
  false,
  "sem config explícita, comportamento não muda",
);

checa(
  "lead desqualificado",
  devePausarAposAgendamento({ finalStatus: "disqualified", behavior: "stop_and_handoff", jaPausado: false }),
  false,
  "desqualificado tem caminho próprio (follow-up/automação)",
);

console.log(`
Fora desta função, o chamador ainda exige um agendamento REAL no execution_log
antes de pausar: se o modelo alegou "booked" e o guard H58 barrou a alegação
falsa, a conversa continua — pausar aí deixaria o lead sem resposta E sem reunião.`);

console.log(`\n${falhas === 0 ? "✅ Política correta em 7 cenários" : `❌ ${falhas} falha(s)`}`);
process.exit(falhas === 0 ? 0 : 1);
