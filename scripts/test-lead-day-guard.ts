// Teste do lead-day-guard (caso Alves Cury 2026-08-31). Replay das strings
// REAIS de produção (regra H85: detector só está pronto depois de rodar contra
// o corpus real). Rodar: npx tsx scripts/test-lead-day-guard.ts
import {
  aplicarGuardaDeDataLead,
  corrigirDiaRelativo,
  aplicarGuardaDeRecapAgendado,
  rotuloDoSlot,
} from "@/lib/queue/lead-day-guard";

const TZ = "America/New_York";
// 27/08/2026 = quinta-feira; 28/08 = sexta. 12:00 ET pra ficar longe de virada.
const QUINTA_27 = new Date("2026-08-27T16:00:00Z");
const SEXTA_28 = new Date("2026-08-28T16:00:00Z");
const SEGUNDA_17 = new Date("2026-08-17T16:00:00Z");

let pass = 0;
let fail = 0;
function caso(nome: string, got: string, want: string) {
  if (got === want) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.log(`  ❌ ${nome}\n     got:  "${got}"\n     want: "${want}"`);
  }
}

console.log("— envio real Cleidmar 27/08 (quinta): hoje absolutiza, amanhã correto fica —");
{
  const r = aplicarGuardaDeDataLead(
    ["Deixa eu ver a agenda aqui. Tem hoje às 7 da noite ou amanhã, sexta 28/08, às 2 da tarde, horário do leste. Qual funciona melhor para você?"],
    TZ,
    QUINTA_27,
  );
  caso(
    "cleidmar-27",
    r.messages[0],
    "Deixa eu ver a agenda aqui. Tem quinta-feira, 27/08, às 7 da noite ou amanhã, sexta 28/08, às 2 da tarde, horário do leste. Qual funciona melhor para você?",
  );
}

console.log("— mesmo texto dito NA sexta 28/08: amanhã vira mentira e cai —");
{
  const r = aplicarGuardaDeDataLead(
    ["Tem hoje às 7 da noite ou amanhã, sexta 28/08, às 2 da tarde."],
    TZ,
    SEXTA_28,
  );
  caso(
    "cleidmar-28",
    r.messages[0],
    "Tem sexta-feira, 28/08, às 7 da noite ou sexta 28/08, às 2 da tarde.",
  );
}

console.log("— residual da bateria v3 (17/08 segunda): 'hoje, terça 18/08' —");
{
  const r = corrigirDiaRelativo("Tem hoje, terça 18/08, às 3 da tarde. Funciona?", TZ, SEGUNDA_17);
  caso("bateria-hoje-terca", r.texto, "Tem terça 18/08, às 3 da tarde. Funciona?");
}

console.log("— follow-up 18:52 re-oferecendo slot: os dois absolutizam —");
{
  const r = aplicarGuardaDeDataLead(
    ["Cleidmar, qual dos dois horários funciona melhor para você: hoje às 7 da noite ou amanhã às 2 da tarde?"],
    TZ,
    QUINTA_27,
  );
  caso(
    "followup-recycle",
    r.messages[0],
    "Cleidmar, qual dos dois horários funciona melhor para você: quinta-feira, 27/08, às 7 da noite ou sexta-feira, 28/08, às 2 da tarde?",
  );
}

console.log("— par dia↔data errado (H85 reuso) + relativo correto —");
{
  const r = aplicarGuardaDeDataLead(["Tem amanhã, quinta 28/08, às 2 da tarde."], TZ, QUINTA_27);
  caso("par-errado-corrigido", r.messages[0], "Tem amanhã, sexta-feira 28/08, às 2 da tarde.");
}

console.log("— usos que NÃO podem mudar —");
{
  const r1 = corrigirDiaRelativo("Hoje em dia as famílias daqui se preocupam com isso.", TZ, QUINTA_27);
  caso("idiom-hoje-em-dia", r1.texto, "Hoje em dia as famílias daqui se preocupam com isso.");
  const r2 = corrigirDiaRelativo("A gente pode se falar amanhã?", TZ, QUINTA_27);
  caso("conversacional-sem-hora", r2.texto, "A gente pode se falar amanhã?");
  const r3 = corrigirDiaRelativo("Fechado, terça às 3 da tarde ET. Qualquer coisa me chama.", TZ, QUINTA_27);
  caso("sem-rotulo-relativo", r3.texto, "Fechado, terça às 3 da tarde ET. Qualquer coisa me chama.");
  const r4 = corrigirDiaRelativo("Como está seu dia hoje?", TZ, QUINTA_27);
  caso("hoje-sem-agenda", r4.texto, "Como está seu dia hoje?");
}

console.log("— depois de amanhã / dia nomeado sem data —");
{
  const r1 = corrigirDiaRelativo("Consigo depois de amanhã às 10h, funciona?", TZ, QUINTA_27);
  caso("depois-de-amanha", r1.texto, "Consigo sábado, 29/08, às 10h, funciona?");
  const r2 = corrigirDiaRelativo("Tem amanhã, sexta, às 2 da tarde.", TZ, QUINTA_27);
  caso("amanha-sexta-correto", r2.texto, "Tem amanhã, sexta, às 2 da tarde.");
  const r3 = corrigirDiaRelativo("Tem amanhã, sexta, às 2 da tarde.", TZ, SEXTA_28);
  caso("amanha-sexta-errado", r3.texto, "Tem sexta, às 2 da tarde.");
}

console.log("— recap de agendamento (C7 — incidente rodada 2: 10 AM × 6 PM) —");
{
  const BOOKED = "2026-08-28T18:00:00-04:00"; // sexta 28/08, 6 PM ET

  caso("rótulo do slot", rotuloDoSlot(BOOKED, TZ) || "", "sexta-feira, 28/08, às 6 da noite");

  const r1 = aplicarGuardaDeRecapAgendado(["Perfeito, deixei reservado às 10 da manhã, certo?"], BOOKED, TZ);
  caso(
    "recap 10AM×6PM substituído",
    r1.messages[0],
    "Fechado: sexta-feira, 28/08, às 6 da noite. A confirmação chega por aqui.",
  );

  const certo = "Fechado então: sexta-feira, 28/08, às 6 da noite, horário do leste. A confirmação chega por aqui.";
  const r2 = aplicarGuardaDeRecapAgendado([certo], BOOKED, TZ);
  caso("recap correto intacto", r2.messages[0], certo);

  const r3 = aplicarGuardaDeRecapAgendado(["Perfeito, combinado!"], BOOKED, TZ);
  caso("sem horário → rótulo anexado", r3.messages.length === 2 && r3.messages[1].includes("sexta-feira, 28/08"), true);

  const r4 = aplicarGuardaDeRecapAgendado(["Confirmado para sexta, 29/08, às 6 da noite."], BOOKED, TZ);
  caso("data errada substituída", r4.messages[0].startsWith("Fechado: sexta-feira, 28/08"), true);

  const r5 = aplicarGuardaDeRecapAgendado(["Fechado, sexta 28/08 às 18h. Chega confirmação por aqui."], BOOKED, TZ);
  caso("18h correto intacto", r5.messages[0], "Fechado, sexta 28/08 às 18h. Chega confirmação por aqui.");

  const r6 = aplicarGuardaDeRecapAgendado(
    ["Em uns 30 minutos de Zoom você sai com o número exato, combinado?"],
    BOOKED,
    TZ,
  );
  caso("'30 minutos' não é horário", r6.messages[0], "Em uns 30 minutos de Zoom você sai com o número exato, combinado?");
}

console.log(`\n${pass} ✅ / ${fail} ❌`);
process.exit(fail > 0 ? 1 : 0);
