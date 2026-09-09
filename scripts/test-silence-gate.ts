/**
 * Golden test do silence-gate (review 2026-09-08, caso Milton De Abreu).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-silence-gate.ts
 *
 * O caso: o Milton agendou 2 reuniões e registrou um recrutamento nos dias 02 e
 * 03/09 (uso pesado). Depois não respondeu ao briefing de sexta, ao de segunda e
 * a um "como foi a reunião?" — 3 proativos → pausa automática no dia 08. No dia
 * seguinte ele reclamou que o SparkBot tinha parado de funcionar.
 *
 * Duas coisas estavam erradas e as duas viraram teste aqui:
 *   1. briefing conta como silêncio (ninguém responde "ok" pro bom-dia)
 *   2. rep que escreveu esta semana pode ser pausado por silêncio
 */
import { checkSilenceGate, type SilenceState } from "@/lib/account-assistant/proactive/silence-gate";

const AGORA = new Date("2026-09-08T12:00:00Z").getTime();
const DIA = 24 * 60 * 60 * 1000;
const haDias = (n: number) => new Date(AGORA - n * DIA).toISOString();

let pass = 0, fail = 0;
function check(nome: string, ok: boolean, detalhe = "") {
  console.log(`${ok ? "✅" : "❌"} ${nome}${ok || !detalhe ? "" : ` — ${detalhe}`}`);
  ok ? pass++ : fail++;
}

const base = (over: Partial<SilenceState> = {}): SilenceState => ({
  consecutive_proactive_without_reply: 0,
  proactive_paused_at: null,
  proactive_warned_at: null,
  proactive_pause_source: null,
  last_inbound_at: null,
  ...over,
});

// ═══ 1. BRIEFING NÃO CONTA (broadcast) ═══
console.log("1. Briefing (broadcast) não conta como silêncio");
{
  for (const cur of [0, 1, 2, 3, 9]) {
    const d = checkSilenceGate(base({ consecutive_proactive_without_reply: cur }), "broadcast", AGORA);
    check(
      `counter=${cur} → envia e NÃO incrementa`,
      d.canSend === true && d.nextCounter === cur && d.warningNote === null,
      JSON.stringify(d),
    );
  }
  // e não ameaça nunca
  const d2 = checkSilenceGate(base({ consecutive_proactive_without_reply: 2 }), "broadcast", AGORA);
  check("broadcast nunca gruda aviso de silêncio", d2.canSend === true && d2.warningNote === null);
}

// ═══ 2. BROADCAST RESPEITA A PAUSA (anti-ban) ═══
console.log("\n2. Broadcast respeita pausa de quem sumiu de verdade");
{
  const d = checkSilenceGate(base({ proactive_paused_at: haDias(1) }), "broadcast", AGORA);
  check("rep pausado NÃO recebe briefing diário", d.canSend === false, JSON.stringify(d));
  // requested continua furando a pausa (H-anterior, regressão)
  const r = checkSilenceGate(base({ proactive_paused_at: haDias(1) }), "requested", AGORA);
  check("lembrete PEDIDO continua furando a pausa", r.canSend === true);
  // loop_guard barra tudo, inclusive requested
  const lg = checkSilenceGate(
    base({ proactive_paused_at: haDias(1), proactive_pause_source: "loop_guard" }),
    "requested",
    AGORA,
  );
  check("pausa de loop_guard barra até o pedido", lg.canSend === false);
}

// ═══ 3. REP QUE ESCREVEU NA SEMANA NÃO É PAUSADO ═══
console.log("\n3. Rep vivo não é pausado (janela de 7 dias)");
{
  // O Milton: escreveu 03/09, pausado 08/09 = 5 dias
  const milton = base({ consecutive_proactive_without_reply: 3, last_inbound_at: haDias(5) });
  const d = checkSilenceGate(milton, "nudge", AGORA);
  check("PROD Milton (escreveu há 5 dias, counter=3) → NÃO pausa", d.canSend === true, JSON.stringify(d));
  check("e segura o contador no teto em vez de subir", d.canSend === true && d.nextCounter === 3);

  const sumido = base({ consecutive_proactive_without_reply: 3, last_inbound_at: haDias(30) });
  const d2 = checkSilenceGate(sumido, "nudge", AGORA);
  check("quem sumiu há 30 dias → PAUSA (anti-ban preservado)", d2.canSend === false && d2.reason === "should_pause");

  const nunca = base({ consecutive_proactive_without_reply: 3, last_inbound_at: null });
  const d3 = checkSilenceGate(nunca, "nudge", AGORA);
  check("rep que nunca escreveu → PAUSA", d3.canSend === false);

  // borda exata da janela
  const borda = base({ consecutive_proactive_without_reply: 3, last_inbound_at: haDias(6.9) });
  check("6,9 dias ainda é 'vivo'", checkSilenceGate(borda, "nudge", AGORA).canSend === true);
  const fora = base({ consecutive_proactive_without_reply: 3, last_inbound_at: haDias(7.1) });
  check("7,1 dias já pausa", checkSilenceGate(fora, "nudge", AGORA).canSend === false);

  const lixo = base({ consecutive_proactive_without_reply: 3, last_inbound_at: "data-invalida" });
  check("last_inbound_at inválido → trata como sumido (pausa)", checkSilenceGate(lixo, "nudge", AGORA).canSend === false);
}

// ═══ 4. NUDGE SEGUE COMO ERA (regressão) ═══
console.log("\n4. Nudge não regrediu");
{
  const d0 = checkSilenceGate(base({ consecutive_proactive_without_reply: 0 }), "nudge", AGORA);
  check("counter=0 → envia limpo, vai pra 1", d0.canSend === true && d0.nextCounter === 1 && d0.warningNote === null);
  const d1 = checkSilenceGate(base({ consecutive_proactive_without_reply: 1 }), "nudge", AGORA);
  check("counter=1 → aviso leve, vai pra 2", d1.canSend === true && !!d1.warningNote && d1.nextCounter === 2);
  const d1w = checkSilenceGate(base({ consecutive_proactive_without_reply: 1, proactive_warned_at: haDias(1) }), "nudge", AGORA);
  check("counter=1 já avisado → não repete o aviso", d1w.canSend === true && d1w.warningNote === null);
  const d2 = checkSilenceGate(base({ consecutive_proactive_without_reply: 2 }), "nudge", AGORA);
  check("counter=2 → aviso forte, vai pra 3", d2.canSend === true && !!d2.warningNote && d2.nextCounter === 3);
}

// ═══ 5. O CENÁRIO COMPLETO DO MILTON, PASSO A PASSO ═══
console.log("\n5. Replay do caso Milton com a política nova");
{
  let st = base({ last_inbound_at: haDias(5) }); // escreveu 03/09
  const passos: Array<[string, "broadcast" | "nudge"]> = [
    ["briefing sexta 04/09", "broadcast"],
    ["briefing segunda 07/09", "broadcast"],
    ["'como foi a revisão com a Sylvia?' 08/09", "nudge"],
  ];
  let pausou = false;
  for (const [nome, kind] of passos) {
    const d = checkSilenceGate(st, kind, AGORA);
    if (!d.canSend) { pausou = true; console.log(`   ⛔ pausou em: ${nome}`); break; }
    st = { ...st, consecutive_proactive_without_reply: d.nextCounter };
    console.log(`   ✔ ${nome} → enviado (counter ${d.nextCounter})`);
  }
  check("Milton NÃO seria pausado", !pausou);
  check("e o contador termina em 1 (só o nudge contou)", st.consecutive_proactive_without_reply === 1, `${st.consecutive_proactive_without_reply}`);
}

console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
if (fail > 0) process.exit(1);
