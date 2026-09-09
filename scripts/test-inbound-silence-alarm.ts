/**
 * Alarme "SparkBot inbound MUDO" — decisão de disparar (fix 2026-09-09).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-inbound-silence-alarm.ts
 *
 * O alarme acumulou 9.440 disparos inferindo "o canal caiu" de "ninguém escreveu
 * há X min". Virou ruído — e no apagão real de 31/08 (~20h fora do ar) ele estava
 * no meio de milhares de falsos e ninguém olhou. Agora exige a saúde da sessão,
 * perguntada ao engine pela porta /api/ingest/wa/session-status do Spark OS.
 *
 * A matriz abaixo é o contrato. Cobre o que a versão anterior errava (madrugada
 * calma virando CRITICAL) sem perder o caso que ela existe pra pegar.
 */
type Saude = "entregando" | "caiu" | null;

/** Espelha a decisão de checkInboundSilence (route.ts) — mantida em sincronia. */
function decide(inboundMin: number, threshold: number, saude: Saude): "silencio" | "alarme" {
  if (inboundMin <= threshold) return "silencio";
  if (saude === "entregando") return "silencio";
  return "alarme"; // 'caiu' e null (indeterminado) alarmam — enviesado a não calar
}

const DIA = 75, NOITE = 240;
let pass = 0, fail = 0;
function check(nome: string, got: string, esperado: string) {
  const ok = got === esperado;
  console.log(`${ok ? "✅" : "❌"} ${nome} → ${got}${ok ? "" : ` (esperado ${esperado})`}`);
  ok ? pass++ : fail++;
}

console.log("=== o que gerava os 9.440 falsos ===");
check("madrugada calma, canal de pé (260min, noite)", decide(260, NOITE, "entregando"), "silencio");
check("fim de semana, canal de pé (900min, dia)", decide(900, DIA, "entregando"), "silencio");
check("reps em reunião a tarde toda (200min, dia)", decide(200, DIA, "entregando"), "silencio");

console.log("\n=== o caso que o alarme existe pra pegar ===");
check("PROD 31/08: 20h sem inbound + sessão caída", decide(1190, DIA, "caiu"), "alarme");
check("caiu de dia, pouco depois do threshold", decide(80, DIA, "caiu"), "alarme");
check("caiu de madrugada (só após 240min)", decide(250, NOITE, "caiu"), "alarme");

console.log("\n=== indeterminado não cala (enviesado a avisar) ===");
check("OS fora do ar + silêncio longo", decide(600, DIA, null), "alarme");
check("mas dentro do threshold segue quieto", decide(30, DIA, null), "silencio");

console.log("\n=== threshold ainda manda ===");
check("74min de dia, sessão caída → ainda não alarma", decide(74, DIA, "caiu"), "silencio");
check("76min de dia, sessão caída → alarma", decide(76, DIA, "caiu"), "alarme");
check("239min de noite, caída → não alarma", decide(239, NOITE, "caiu"), "silencio");
check("241min de noite, caída → alarma", decide(241, NOITE, "caiu"), "alarme");

console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
