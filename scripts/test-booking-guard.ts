/**
 * Testes dos guardas de agendamento (H58) — reproduzem os casos REAIS da conta
 * Jussara Ferreira (location pGl5pqLLG0QDixANpFnP), lidos de wa_outbox e
 * execution_log entre 22 e 28/07/2026.
 *
 * A validação "o horário existe na agenda?" é do slot-guard.ts (caso Alves
 * Cury) e tem teste próprio — aqui cobrimos o que é exclusivo deste guarda.
 *
 * Rodar: npx tsx scripts/test-booking-guard.ts
 */
import {
  claimsBooking,
  dentroDoExpediente,
  horaLocal,
  decidirConfirmacao,
  aplicarGuardaDeConfirmacao,
  EXPEDIENTE_PADRAO,
} from "../src/lib/ai/booking-guard";
import { filterSlotsToBusinessHours } from "../src/lib/ai/slots-format";
import { extractSlotIsoList } from "../src/lib/ai/slot-guard";

let pass = 0,
  fail = 0;
function check(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

const ET = "America/New_York";

// ---------------------------------------------------------------------------
console.log("\n1. Detecção de afirmação de agendamento (frases REAIS do log)");
// ---------------------------------------------------------------------------
check("'Ótimo, segunda às 4 PM ET tá marcado 🎉'", claimsBooking("Ótimo, segunda às 4 PM ET tá marcado pra vc 🎉"));
check("'Prontinho, terça às 9 AM ET tá marcado 🎉'", claimsBooking("Prontinho, terça às 9 AM ET tá marcado 🎉"));
check("'Sua reunião foi agendada com sucesso!'", claimsBooking("Olá, Valeria !\n\nSua reunião foi agendada com sucesso!"));
check("'agendei pra você'", claimsBooking("agendei pra você, dia 30"));
check("'está confirmado'", claimsBooking("Show, está confirmado pra quinta"));

// O que NÃO pode ser tratado como afirmação — senão o guarda trava a conversa.
check("proposta NÃO é afirmação", !claimsBooking("Tenho terça às 9 AM ou quinta às 11 AM ET, qual fica melhor?"));
check("pergunta NÃO é afirmação", !claimsBooking("Vamos marcar um horário de 10-15 min?"));
check("'quer marcar?' NÃO é afirmação", !claimsBooking("Quer marcar pra amanhã?"));
check("texto neutro NÃO é afirmação", !claimsBooking("Já tenho tudo que preciso pra simulação 😊"));
check("vazio NÃO é afirmação", !claimsBooking(""));

// ---------------------------------------------------------------------------
console.log("\n2. Expediente 9h-21h ET (casos Valeria e Lena)");
// ---------------------------------------------------------------------------
check("hora local lida corretamente (DST de julho)", horaLocal("2026-07-28T08:00:00-04:00", ET) === 8);
check(
  "CASO LENA: 28/07 08:00 ET está FORA",
  !dentroDoExpediente("2026-07-28T08:00:00-04:00", ET),
);
check(
  "CASO VALERIA: 27/07 08:00 ET está FORA",
  !dentroDoExpediente("2026-07-27T08:00:00-04:00", ET),
);
check("09:00 está DENTRO (borda inicial)", dentroDoExpediente("2026-07-28T09:00:00-04:00", ET));
check("21:00 está DENTRO (borda final)", dentroDoExpediente("2026-07-28T21:00:00-04:00", ET));
check("22:00 está FORA", !dentroDoExpediente("2026-07-28T22:00:00-04:00", ET));
check("16:00 (o '4 PM' da Marilia) está DENTRO", dentroDoExpediente("2026-07-27T16:00:00-04:00", ET));
check("ISO inválido → fail-open (não bloqueia)", dentroDoExpediente("nao-e-data", ET));
check(
  "mesmo instante em UTC dá a mesma hora local",
  horaLocal("2026-07-28T12:00:00Z", ET) === 8,
);

// ---------------------------------------------------------------------------
console.log("\n3. A decisão do guarda");
// ---------------------------------------------------------------------------
check(
  "afirma + agendou OK → libera",
  decidirConfirmacao({ afirmaAgendamento: true, tentouAgendar: true, agendouComSucesso: true }).liberado,
);
check(
  "CASO MARILIA 14:01: afirma + booking FALHOU → bloqueia",
  decidirConfirmacao({ afirmaAgendamento: true, tentouAgendar: true, agendouComSucesso: false }).motivo ===
    "booking_falhou",
);
check(
  "afirma SEM nenhuma action → bloqueia",
  decidirConfirmacao({ afirmaAgendamento: true, tentouAgendar: false, agendouComSucesso: false }).motivo ===
    "sem_booking_no_turno",
);
check(
  "não afirma → libera (não mexe em conversa normal)",
  decidirConfirmacao({ afirmaAgendamento: false, tentouAgendar: false, agendouComSucesso: false }).liberado,
);

// ---------------------------------------------------------------------------
console.log("\n4. Turno completo da Marilia (14:01:53 → 14:01:58)");
// ---------------------------------------------------------------------------
const turnoMarilia = [
  "Ótimo, segunda às 4 PM ET tá marcado pra vc 🎉",
  "Pode ser por Zoom ou por ligação, como preferir?",
  "O link da nossa call é esse: https://us06web.zoom.us/j/3212768361, salva aí 🙏",
];
const r = aplicarGuardaDeConfirmacao(turnoMarilia, {
  afirmaAgendamento: turnoMarilia.some(claimsBooking),
  tentouAgendar: true,
  agendouComSucesso: false, // foi o que aconteceu: erro "horario indisponivel"
});
check("bloqueou o turno", r.bloqueou && r.motivo === "booking_falhou");
check("a confirmação falsa sumiu", !r.mensagens.some(claimsBooking), r.mensagens[0]);
check("mensagem honesta entrou", /indisponível/i.test(r.mensagens[0]), r.mensagens[0]);
check("as outras bolhas foram preservadas", r.mensagens.length === 3 && r.mensagens[2].includes("zoom.us"));

const turnoOk = aplicarGuardaDeConfirmacao(["Prontinho, terça às 9 AM ET tá marcado 🎉"], {
  afirmaAgendamento: true,
  tentouAgendar: true,
  agendouComSucesso: true, // 14:03:49 — este booking deu certo de verdade
});
check("CASO MARILIA 14:03 (booking OK): passa intacto", !turnoOk.bloqueou);

// ---------------------------------------------------------------------------
console.log("\n5. Filtro de expediente na origem (o que o modelo vê)");
// ---------------------------------------------------------------------------
const respostaFreeSlots = {
  "2026-07-28": {
    slots: [
      "2026-07-28T08:00:00-04:00", // fora — foi o que pegou a Lena
      "2026-07-28T09:00:00-04:00",
      "2026-07-28T16:00:00-04:00",
      "2026-07-28T22:00:00-04:00", // fora
    ],
  },
  "2026-07-29": { slots: ["2026-07-29T07:00:00-04:00"] }, // dia inteiro fora
  traceId: "abc",
};
const filtrado = filterSlotsToBusinessHours(respostaFreeSlots, ET);
const isos = extractSlotIsoList(filtrado);
check("8h da manhã foi removido", !isos.some((s) => horaLocal(s, ET) === 8));
check("22h foi removido", !isos.some((s) => horaLocal(s, ET) === 22));
check("9h e 16h sobraram", isos.length === 2);
check("dia inteiro fora do expediente sumiu", !("2026-07-29" in filtrado));
check("traceId preservado", filtrado.traceId === "abc");
check("extração (slot-guard) pega os ISOs crus", extractSlotIsoList(respostaFreeSlots).length === 5);

console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : ""}\n`);
process.exit(fail ? 1 : 0);
