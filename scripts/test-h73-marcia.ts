/**
 * H73 (caso Márcia/Five Star 2026-08-07) — as três correções da onda:
 *
 * 1. O offset de destino do booking vem dos FREE-SLOTS do turno, não do fuso
 *    cadastrado na location (que estava errado e deslocava tudo em 1h).
 * 2. Re-emitir o mesmo booking não pode virar "não consegui agendar": o log
 *    local responde antes do CRM, que ainda não indexou a reunião nova.
 * 3. Rótulo cru de áudio no HISTÓRICO vira texto — nunca chega ao modelo como
 *    mídia ilegível (era o que fazia a IA dizer que não consegue ouvir áudio).
 *
 * Rodar: npx tsx scripts/test-h73-marcia.ts
 */
import {
  coerceStartTimeToTimezone,
  offsetMinutesFromSlots,
  validateBookingSlot,
  normalizeCrmStartTime,
  isSameSlotInstant,
} from "@/lib/ai/slot-guard";
import { achaBookingNoMesmoInstante } from "@/lib/ai/booking-recente";
import {
  limpaRotulosDeAudioNoHistorico,
  AUDIO_SEM_TEXTO_NO_HISTORICO,
} from "@/lib/queue/queue-processor";

let pass = 0;
let fail = 0;
function ok(nome: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.log(`  ❌ ${nome} ${extra}`);
  }
}

console.log("\n1) Offset lido dos slots reais do calendário");
{
  const slots = ["2026-08-07T16:00:00-04:00", "2026-08-07T16:30:00-04:00", "2026-08-08T09:00:00-04:00"];
  ok("slots do dia concordando → -240min", offsetMinutesFromSlots(slots, "2026-08-07") === -240);
  ok("sem data pedida → offset unânime da lista", offsetMinutesFromSlots(slots) === -240);
  ok("lista vazia → null", offsetMinutesFromSlots([]) === null);
  ok("undefined → null", offsetMinutesFromSlots(undefined) === null);
  ok(
    "dia com offsets divergentes → null (cai pro fuso da conta)",
    offsetMinutesFromSlots(["2026-08-07T16:00:00-04:00", "2026-08-07T17:00:00-03:00"], "2026-08-07") === null,
  );
  ok("aceita Z", offsetMinutesFromSlots(["2026-08-07T20:00:00Z"], "2026-08-07") === 0);
}

console.log("\n2) O BUG da Márcia: location com fuso errado (SP) e calendário em ET");
{
  // O LLM falou "7:00 PM (ET)" e emitiu -04:00 (certo). Antes do H73, a coerção
  // reescrevia pra -03:00 porque locations.timezone dizia America/Sao_Paulo →
  // a reunião caía às 18:00 ET e o guard barrava o horário que a IA ofereceu.
  const slots = ["2026-08-07T19:00:00-04:00", "2026-08-07T20:00:00-04:00"];
  const co = coerceStartTimeToTimezone("2026-08-07T19:00:00-04:00", "America/Sao_Paulo", slots);
  ok("não mexe no instante que já bate o slot real", co.iso === "2026-08-07T19:00:00-04:00", co.iso);
  ok("marca a fonte do offset", co.offsetSource === "slots");
  ok("e o guard H58 aceita", validateBookingSlot(co.iso, slots).ok);

  const semFix = coerceStartTimeToTimezone("2026-08-07T19:00:00-04:00", "America/Sao_Paulo");
  ok("(regressão) sem slots ainda usaria o fuso errado", semFix.iso === "2026-08-07T19:00:00-03:00", semFix.iso);
  ok("(regressão) e o guard barraria — foi o 'não consegui agendar'", !validateBookingSlot(semFix.iso, slots).ok);
}

console.log("\n3) H66 preservado: LLM emite offset de outro fuso, calendário manda");
{
  const slots = ["2026-08-04T13:00:00-04:00", "2026-08-04T14:00:00-04:00"];
  const co = coerceStartTimeToTimezone("2026-08-04T13:00:00-03:00", "America/New_York", slots);
  ok("wall-clock preservado, offset do calendário", co.iso === "2026-08-04T13:00:00-04:00", co.iso);
  ok("coerced=true", co.coerced);
  ok("guard aceita o corrigido", validateBookingSlot(co.iso, slots).ok);
}

console.log("\n4) Sem slots no turno = comportamento antigo (fuso da location)");
{
  const co = coerceStartTimeToTimezone("2026-08-04T13:00:00-03:00", "America/New_York");
  ok("cai pro fuso da conta", co.iso === "2026-08-04T13:00:00-04:00", co.iso);
  ok("fonte = location", co.offsetSource === "location");
  const vazio = coerceStartTimeToTimezone("2026-08-04T13:00:00-03:00", "America/New_York", []);
  ok("lista vazia também cai pro fuso da conta", vazio.iso === "2026-08-04T13:00:00-04:00", vazio.iso);
  ok("ISO não-parseável passa intocado", coerceStartTimeToTimezone("amanhã às 3", "America/New_York", []).iso === "amanhã às 3");
}

console.log("\n5) Flip-flop: re-emissão do mesmo booking é noop, não erro");
{
  const agora = new Date("2026-08-07T18:10:00Z");
  const log = [
    { start_time: "2026-08-07T19:00:00-04:00", created_at: "2026-08-07T18:09:00Z" },
    { start_time: "2026-08-09T11:00:00-04:00", created_at: "2026-08-07T17:00:00Z" },
  ];
  ok(
    "mesmo instante 1min atrás → reconhece",
    achaBookingNoMesmoInstante(log, "2026-08-07T19:00:00-04:00", agora) !== null,
  );
  ok(
    "mesmo instante em outra representação de offset",
    achaBookingNoMesmoInstante(log, "2026-08-07T23:00:00Z", agora) !== null,
  );
  ok(
    "horário diferente → não reconhece (é pedido novo)",
    achaBookingNoMesmoInstante(log, "2026-08-07T20:00:00-04:00", agora) === null,
  );
  ok(
    "fora da janela de 15min → não reconhece",
    achaBookingNoMesmoInstante(
      [{ start_time: "2026-08-07T19:00:00-04:00", created_at: "2026-08-07T17:40:00Z" }],
      "2026-08-07T19:00:00-04:00",
      agora,
    ) === null,
  );
  ok("start_time ausente → null", achaBookingNoMesmoInstante(log, undefined, agora) === null);
  ok("log vazio → null", achaBookingNoMesmoInstante([], "2026-08-07T19:00:00-04:00", agora) === null);
}

console.log("\n5b) Horário que o CRM devolve SEM offset (o que matava o escape em prod)");
{
  const slots = ["2026-08-12T18:00:00-04:00", "2026-08-12T19:00:00-04:00"];
  const doCrm = normalizeCrmStartTime("2026-08-12 18:00:00", "America/New_York", slots);
  ok("wall-clock sem offset vira ISO do calendário", doCrm === "2026-08-12T18:00:00-04:00", doCrm);
  ok(
    "e aí bate com o booking (era o caso Nery)",
    isSameSlotInstant(doCrm, "2026-08-12T18:00:00-04:00"),
  );
  ok(
    "(regressão) sem normalizar, em UTC daria 4h de diferença",
    !isSameSlotInstant(
      new Date(Date.parse("2026-08-12T18:00:00Z")).toISOString(),
      "2026-08-12T18:00:00-04:00",
    ),
  );
  ok(
    "valor que JÁ tem offset passa intocado",
    normalizeCrmStartTime("2026-08-12T18:00:00-04:00", "America/New_York", slots) === "2026-08-12T18:00:00-04:00",
  );
  ok("Z também passa intocado", normalizeCrmStartTime("2026-08-12T22:00:00Z", "America/New_York") === "2026-08-12T22:00:00Z");
  ok("vazio não quebra", normalizeCrmStartTime("", "America/New_York") === "");
  ok("lixo passa intocado", normalizeCrmStartTime("amanhã", "America/New_York") === "amanhã");
}

console.log("\n6) Áudio no histórico nunca vira 'não consigo ouvir'");
{
  const cru = "🎤 Mensagem de voz (0:17)";
  ok(
    "com transcrição guardada → o texto real",
    limpaRotulosDeAudioNoHistorico(cru, "[Áudio do contato, transcrito] Pode ser as 4 pm") ===
      "[Áudio do contato, transcrito] Pode ser as 4 pm",
  );
  ok("sem transcrição → aviso neutro", limpaRotulosDeAudioNoHistorico(cru) === AUDIO_SEM_TEXTO_NO_HISTORICO);
  ok(
    "o rótulo cru não sobrevive",
    !limpaRotulosDeAudioNoHistorico(cru).includes("Mensagem de voz"),
  );
  ok("texto normal passa intocado", limpaRotulosDeAudioNoHistorico("Pode ser as 4 pm") === "Pode ser as 4 pm");
  ok(
    "variante em inglês também",
    limpaRotulosDeAudioNoHistorico("Voice message") === AUDIO_SEM_TEXTO_NO_HISTORICO,
  );
  ok("string vazia não quebra", limpaRotulosDeAudioNoHistorico("") === "");
}

console.log(`\n${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
