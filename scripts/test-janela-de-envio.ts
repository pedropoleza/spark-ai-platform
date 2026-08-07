/**
 * Caso H — follow-up chegando de madrugada.
 *
 * Márcia, 05/08 06:32, sobre o (862) 371-8457:
 *   "precisava ver sobre o hr do follow up... a mensagem foi MEIA-NOITE"
 *
 * O `scheduleFollowUps` gravava `scheduled_at = agora + delay`, sem checagem
 * nenhuma de horário. Lead que para de responder às 23h recebia o toque de 1h
 * à meia-noite. Agora todo agendamento passa por `ajustarParaJanela`.
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-janela-de-envio.ts
 */
import { ajustarParaJanela, horaLocal, JANELA_PADRAO } from "@/lib/queue/janela-de-envio";

const ET = "America/New_York";
const CT = "America/Chicago";
const PT = "America/Los_Angeles";

let falhas = 0;
function checa(nome: string, cond: boolean, detalhe = "") {
  console.log(`  ${cond ? "✅" : "❌"} ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  if (!cond) falhas++;
}

/** Monta um instante a partir de uma hora local no fuso dado (busca por varredura). */
function instanteLocal(ano: number, mes: number, dia: number, hora: number, tz: string): Date {
  for (let off = 0; off < 30; off++) {
    const d = new Date(Date.UTC(ano, mes - 1, dia, hora + off, 0, 0));
    if (horaLocal(d, tz) === hora) return d;
  }
  throw new Error("não achei o instante");
}

function cenario(rotulo: string, quando: Date, tz: string, esperado: { dentro: boolean; horaMin?: number }) {
  const antes = horaLocal(quando, tz);
  const depois = ajustarParaJanela(quando, tz);
  const horaDepois = horaLocal(depois, tz);
  const mudou = depois.getTime() !== quando.getTime();
  console.log(`\n${rotulo}`);
  console.log(`  agendado pra ${String(antes).padStart(2, "0")}h local → sai ${String(horaDepois).padStart(2, "0")}h local${mudou ? " (adiado)" : " (sem mudança)"}`);
  checa(
    "cai dentro da janela 08h-21h",
    horaDepois >= JANELA_PADRAO.inicioHora && horaDepois < JANELA_PADRAO.fimHora,
    `${horaDepois}h`,
  );
  checa("nunca antecipa", depois.getTime() >= quando.getTime());
  if (esperado.dentro) checa("não mexeu no que já estava ok", !mudou);
  if (esperado.horaMin !== undefined) checa(`abre em ${esperado.horaMin}h`, horaDepois === esperado.horaMin, `${horaDepois}h`);
}

console.log("CASO Márcia: lead some às 23h, follow-up de 1h cairia à meia-noite.\n");

// O caso real: 00:00 ET
cenario("1) Meia-noite ET (o caso reportado)", instanteLocal(2026, 8, 5, 0, ET), ET, { dentro: false, horaMin: 8 });

// Madrugada funda
cenario("2) 03h da manhã ET", instanteLocal(2026, 8, 5, 3, ET), ET, { dentro: false, horaMin: 8 });

// Noite, depois do fechamento → manhã seguinte
cenario("3) 22h ET (depois do fechamento)", instanteLocal(2026, 8, 5, 22, ET), ET, { dentro: false, horaMin: 8 });

// Dentro da janela → intocado
cenario("4) 14h ET (horário comercial)", instanteLocal(2026, 8, 5, 14, ET), ET, { dentro: true });

// Bordas
cenario("5) 08h ET (abertura, inclusive)", instanteLocal(2026, 8, 5, 8, ET), ET, { dentro: true });
cenario("6) 21h ET (fechamento, exclusive)", instanteLocal(2026, 8, 5, 21, ET), ET, { dentro: false, horaMin: 8 });

// Outros fusos da frota
cenario("7) 02h CT (conta no Texas)", instanteLocal(2026, 8, 5, 2, CT), CT, { dentro: false, horaMin: 8 });
cenario("8) 23h PT (conta na Califórnia)", instanteLocal(2026, 8, 5, 23, PT), PT, { dentro: false, horaMin: 8 });

// Virada de ano — o adiamento não pode quebrar a data
{
  const reveillon = instanteLocal(2026, 12, 31, 23, ET);
  const saida = ajustarParaJanela(reveillon, ET);
  console.log(`\n9) 31/12 23h ET (virada de ano)`);
  console.log(`  sai em ${saida.toISOString()} (${horaLocal(saida, ET)}h local)`);
  checa("vira o ano corretamente", saida > reveillon && horaLocal(saida, ET) === 8);
}

// DST: madrugada da virada de horário nos EUA (novembro)
{
  const dst = instanteLocal(2026, 11, 1, 1, ET);
  const saida = ajustarParaJanela(dst, ET);
  console.log(`\n10) 01/11 01h ET (fim do horário de verão)`);
  console.log(`  sai às ${horaLocal(saida, ET)}h local`);
  checa("respeita a janela mesmo na virada de DST", horaLocal(saida, ET) === 8);
}

console.log(`\n${falhas === 0 ? "✅ Follow-up nunca mais sai de madrugada." : `❌ ${falhas} falha(s)`}`);
process.exit(falhas === 0 ? 0 : 1);
