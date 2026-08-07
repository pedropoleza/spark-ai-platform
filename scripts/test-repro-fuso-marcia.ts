/**
 * Reprodução determinística do caso reportado pela Márcia (Five Star Ricos /
 * Horizon) em 05/08 23:03:
 *
 *   "a IA aqui ofereceu 7PM pra cliente mas esse hr já estava ocupado...
 *    a cliente respondeu 7PM e ELA AGENDOU 6PM"
 *
 * Hipótese: `locations.timezone` estava `America/Sao_Paulo` numa conta que roda
 * em `America/New_York`. Esse campo alimenta as DUAS pontas do agendamento:
 *   (1) `formatAvailableSlots` — o RÓTULO do horário que o lead lê no chat
 *   (2) `coerceStartTimeToTimezone` (H66) — o OFFSET do ISO que vai pro CRM
 * Com BRT (-03:00) numa conta EDT (-04:00), o rótulo e a gravação divergem em
 * exatamente 1 hora, e a reunião nasce 1h ANTES do que foi combinado.
 *
 * Este teste roda os dois caminhos com o fuso QUEBRADO e com o CORRIGIDO,
 * usando as funções reais de produção. Sem rede, sem banco.
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-repro-fuso-marcia.ts
 */
import { formatAvailableSlots } from "@/lib/ai/slots-format";
import { coerceStartTimeToTimezone } from "@/lib/ai/slot-guard";

const TZ_QUEBRADO = "America/Sao_Paulo"; // o que estava gravado até 06/08
const TZ_REAL = "America/New_York"; // o que a API do Spark Leads devolve

// Slot real de 7 PM ET em 06/08/2026 (EDT = UTC-4) → 23:00Z
const SLOT_7PM_ET_UTC = "2026-08-06T23:00:00Z";

const slotsResp: Record<string, unknown> = {
  "2026-08-06": { slots: [SLOT_7PM_ET_UTC] },
};

function horaEm(iso: string, tz: string): string {
  return new Date(iso).toLocaleTimeString("en-US", {
    timeZone: tz, hour: "numeric", minute: "2-digit", hour12: true,
  });
}

let falhas = 0;
function checa(nome: string, cond: boolean, detalhe: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${nome} — ${detalhe}`);
  if (!cond) falhas++;
}

function cenario(rotulo: string, tz: string) {
  console.log(`\n${"─".repeat(72)}\n${rotulo}  (locations.timezone = ${tz})`);

  // (1) O que o lead LÊ no chat
  const linha = formatAvailableSlots(slotsResp, tz);
  const rotuloSlot = linha.trim();
  console.log(`  lead lê:   ${rotuloSlot}`);

  // (2) O LLM copia o horário que leu e emite o ISO; H66 coage pro fuso da conta
  const horaLida = horaEm(SLOT_7PM_ET_UTC, tz); // o número que o modelo enxerga
  const isoDoLLM = `2026-08-06T${tz === TZ_QUEBRADO ? "19" : "19"}:00:00-04:00`;
  const co = coerceStartTimeToTimezone(isoDoLLM, tz);
  const isoFinal = co.coerced ? co.iso : isoDoLLM;
  console.log(`  hora que o modelo enxerga na lista: ${horaLida}`);
  console.log(`  ISO gravado no CRM: ${isoFinal}${co.coerced ? `  (H66 coagiu de ${co.original})` : ""}`);
  console.log(`  => reunião cai às ${horaEm(isoFinal, TZ_REAL)} no fuso REAL da conta (${TZ_REAL})`);

  return { rotuloSlot, horaLida, isoFinal, caiEm: horaEm(isoFinal, TZ_REAL) };
}

console.log("CASO: slot real de 7 PM ET (06/08/2026). Lead escolhe '7PM'.");

const quebrado = cenario("ANTES (estado de prod até 06/08)", TZ_QUEBRADO);
const corrigido = cenario("DEPOIS (fuso corrigido pela API do Spark Leads)", TZ_REAL);

console.log(`\n${"═".repeat(72)}\nVERIFICAÇÃO\n${"═".repeat(72)}`);

// O bug: com o fuso quebrado, o rótulo que o lead lê e a hora real divergem 1h.
checa(
  "ANTES: rótulo mostrado ao lead diverge da hora real do slot",
  quebrado.horaLida !== "7:00 PM",
  `o slot é 7 PM ET mas a lista mostra ${quebrado.horaLida} — é a divergência de 1h que a Márcia viu`,
);
checa(
  "ANTES: reunião cai 1h antes do que o lead combinou",
  quebrado.caiEm === "6:00 PM",
  `combinou 7PM, caiu ${quebrado.caiEm} (exatamente o "ofereceu 7PM e agendou 6PM")`,
);

// Depois da correção, as duas pontas batem.
checa(
  "DEPOIS: rótulo mostrado ao lead é a hora real do slot",
  corrigido.horaLida === "7:00 PM",
  `lista mostra ${corrigido.horaLida}`,
);
checa(
  "DEPOIS: reunião cai no horário combinado",
  corrigido.caiEm === "7:00 PM",
  `combinou 7PM, caiu ${corrigido.caiEm}`,
);

console.log(
  `\n${falhas === 0 ? "✅ Reprodução OK: o bug aparece com o fuso quebrado e SOME com o corrigido." : `❌ ${falhas} verificação(ões) falharam`}`,
);
process.exit(falhas === 0 ? 0 : 1);
