/**
 * Reprodução do caso Anne (+1 508 665-7240), reportado pela Márcia em 05/08 13:28:
 *   "Não sei se foi porque ela cancelou, mas o sistema agendou ela para hoje E amanhã"
 *
 * Mecânica provada na forense: o `reschedule_appointment` fazia delete-then-create
 * com o DELETE dentro de um `catch {}` vazio. Delete falhando => criava assim
 * mesmo => contato ficava com DOIS appointments. O de 05/08 continuou vivo depois
 * do reschedule das 08:42 (só foi cancelado à mão às 09:21).
 *
 * Exercita `moveAppointment` (a função real de produção) com um cliente falso.
 * Sem rede, sem banco.
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-reschedule-sem-duplicata.ts
 */
import { moveAppointment } from "@/lib/ai/action-executor";
import type { AppointmentMoverClient } from "@/lib/ai/action-executor";

const APPT_ID = "aaaaaaaaaaaaaaaaaaaa";
const NOVO_SLOT = "2026-08-06T10:30:00-04:00";

type Chamada = { verbo: string; path: string };

function fakeClient(opts: { putFalha?: boolean; deleteFalha?: boolean }) {
  const chamadas: Chamada[] = [];
  const client: AppointmentMoverClient = {
    async get(path: string) {
      chamadas.push({ verbo: "GET", path });
      return {};
    },
    async put(path: string) {
      chamadas.push({ verbo: "PUT", path });
      if (opts.putFalha) throw new Error("simulado: PUT recusado pelo Spark Leads");
      return {};
    },
    async delete(path: string) {
      chamadas.push({ verbo: "DELETE", path });
      if (opts.deleteFalha) throw new Error("simulado: DELETE recusado pelo Spark Leads");
      return {};
    },
    async post(path: string) {
      chamadas.push({ verbo: "POST", path });
      return {};
    },
  };
  return { client, chamadas };
}

const criados = (c: Chamada[]) => c.filter((x) => x.verbo === "POST" && x.path.includes("appointments")).length;
const deletados = (c: Chamada[]) => c.filter((x) => x.verbo === "DELETE").length;
const atualizados = (c: Chamada[]) => c.filter((x) => x.verbo === "PUT" && x.path.includes("appointments")).length;

let falhas = 0;
function checa(nome: string, cond: boolean, detalhe: string) {
  console.log(`  ${cond ? "✅" : "❌"} ${nome} — ${detalhe}`);
  if (!cond) falhas++;
}

async function roda(rotulo: string, opts: { putFalha?: boolean; deleteFalha?: boolean }) {
  console.log(`\n${"─".repeat(70)}\n${rotulo}`);
  const { client, chamadas } = fakeClient(opts);
  let erro: string | null = null;
  let modo: string | null = null;
  try {
    modo = await moveAppointment(client, {
      appointmentId: APPT_ID,
      calendarId: "14aj8DKXZnaj8GRMdmDy",
      locationId: "jA6uzx6tONyTeocxw4Cj",
      contactId: "contato1",
      startTime: NOVO_SLOT,
      title: "Primeiro Encontro",
    });
  } catch (e) {
    erro = e instanceof Error ? e.message : String(e);
  }
  console.log(`  chamadas: ${chamadas.map((c) => c.verbo).join(" → ") || "(nenhuma)"}${modo ? ` | modo=${modo}` : ""}`);
  if (erro) console.log(`  erro: ${erro.slice(0, 130)}`);
  return { chamadas, erro, modo };
}

async function main() {
  console.log("CASO Anne: reunião em 05/08 10:30, a IA reagenda pra 06/08 10:30.\n");

  {
    const { chamadas, modo } = await roda("1) Spark Leads aceita o UPDATE (caminho normal)", {});
    checa("move o appointment existente", atualizados(chamadas) === 1, `${atualizados(chamadas)} PUT`);
    checa("NÃO cria uma segunda reunião", criados(chamadas) === 0, `${criados(chamadas)} POST de appointment`);
    checa("não deleta nada", deletados(chamadas) === 0, `${deletados(chamadas)} DELETE`);
    checa("modo auditável", modo === "reschedule_update", String(modo));
  }

  {
    const { chamadas, erro, modo } = await roda("2) UPDATE recusado, remoção funciona (fallback legado)", { putFalha: true });
    checa("cai pro delete+create", deletados(chamadas) === 1 && criados(chamadas) === 1, `${deletados(chamadas)} DELETE + ${criados(chamadas)} POST`);
    checa("sem erro pro lead", erro === null, erro ? erro.slice(0, 80) : "ok");
    checa("modo auditável", modo === "reschedule_recreate", String(modo));
  }

  {
    const { chamadas, erro } = await roda("3) UPDATE e remoção recusados — O CASO ANNE", { putFalha: true, deleteFalha: true });
    checa(
      "NÃO cria a reunião duplicada",
      criados(chamadas) === 0,
      `${criados(chamadas)} POST — antes deste fix era 1, e o contato ficava com "hoje E amanhã"`,
    );
    checa("aborta com erro honesto", erro !== null && /nao duplicar/.test(erro), erro ? erro.slice(0, 90) : "sem erro");
  }

  console.log(`\n${"═".repeat(70)}`);
  console.log(falhas === 0 ? "✅ 3 cenários OK — reagendar nunca mais duplica reunião." : `❌ ${falhas} verificação(ões) falharam`);
  process.exit(falhas === 0 ? 0 : 1);
}
main().catch((e) => {
  console.error("ERRO:", e instanceof Error ? e.message : e);
  process.exit(1);
});
