/**
 * Teste do lock de turno (review de uso 2026-08-25, caso Daniely 24/08).
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-turn-lock.ts
 *
 * Bate no banco de VERDADE — concorrência não se testa com mock. Usa rep_ids
 * sintéticos (uuid) que não existem em rep_identities: a tabela de lock não tem
 * FK, então nada de produção é tocado, e o finally limpa tudo.
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import { acquireTurnLock, releaseTurnLock } from "@/lib/account-assistant/core/turn-lock";
import { createAdminClient } from "@/lib/supabase/admin";
import { randomUUID } from "crypto";

let pass = 0;
let fail = 0;
function check(nome: string, ok: boolean, detalhe = "") {
  console.log(`${ok ? "✅" : "❌"} ${nome}${ok || !detalhe ? "" : ` — ${detalhe}`}`);
  ok ? pass++ : fail++;
}

const sujos: string[] = [];
function repFake(): string {
  const id = randomUUID();
  sujos.push(id);
  return id;
}

async function main() {
  const sb = createAdminClient();

  // ── 1. Exclusão mútua básica ──────────────────────────────────────────
  console.log("1. Exclusão mútua");
  {
    const rep = repFake();
    const a = await acquireTurnLock(rep, "msg-A", 0);
    check("1º pega o lock", a.status === "acquired", a.status);
    const b = await acquireTurnLock(rep, "msg-B", 0);
    check("2º NÃO pega enquanto o 1º segura", b.status === "timeout", b.status);
    await releaseTurnLock(rep, "msg-A");
    const c = await acquireTurnLock(rep, "msg-C", 0);
    check("depois do release, o 3º pega", c.status === "acquired", c.status);
    await releaseTurnLock(rep, "msg-C");
  }

  // ── 2. Reps diferentes não se bloqueiam ───────────────────────────────
  console.log("\n2. Isolamento entre reps");
  {
    const r1 = repFake();
    const r2 = repFake();
    const a = await acquireTurnLock(r1, "m1", 0);
    const b = await acquireTurnLock(r2, "m2", 0);
    check("rep A e rep B pegam ao mesmo tempo", a.status === "acquired" && b.status === "acquired");
    await releaseTurnLock(r1, "m1");
    await releaseTurnLock(r2, "m2");
  }

  // ── 3. A RAJADA DA DANIELY: 4 turnos concorrentes ─────────────────────
  // O que tem que valer: em nenhum instante dois turnos estão "dentro" ao mesmo
  // tempo. É exatamente isso que faltava quando o bot agendou "Thaty Gomes" 4s
  // antes de a rep responder qual Thaty era.
  console.log("\n3. Rajada de 4 mensagens (caso Daniely 24/08 23:51)");
  {
    const rep = repFake();
    let dentro = 0;
    let maxSimultaneos = 0;
    const ordem: string[] = [];

    const turno = async (nome: string, atrasoMs: number, duracaoMs: number) => {
      await new Promise((r) => setTimeout(r, atrasoMs));
      const lock = await acquireTurnLock(rep, nome, 25_000);
      try {
        dentro++;
        maxSimultaneos = Math.max(maxSimultaneos, dentro);
        ordem.push(nome);
        await new Promise((r) => setTimeout(r, duracaoMs)); // "roda o LLM + tools"
      } finally {
        dentro--;
        if (lock.status === "acquired") await releaseTurnLock(rep, nome);
      }
      return lock;
    };

    // Mesmos intervalos do caso real: 4 msgs em ~27s, cada turno ~8s.
    const res = await Promise.all([
      turno("Marca Thaty 5 pm", 0, 900),
      turno("Amanha alinhamento", 120, 900),
      turno("5 pm Fl time", 170, 900),
      turno("Comigo", 270, 900),
    ]);

    check("nunca teve 2 turnos rodando juntos", maxSimultaneos === 1, `máx=${maxSimultaneos}`);
    check("todos os 4 rodaram (nenhuma msg engolida)", ordem.length === 4, ordem.join(" → "));
    check("os 4 pegaram o lock de fato", res.every((r) => r.status === "acquired"));
    check(
      "quem chegou depois esperou de verdade",
      res.slice(1).some((r) => r.waitedMs > 300),
      res.map((r) => `${r.waitedMs}ms`).join(", "),
    );
  }

  // ── 4. Lock vencido é roubado (lambda morta não trava o rep) ──────────
  console.log("\n4. TTL: lambda morta não deixa o rep travado");
  {
    const rep = repFake();
    await sb.from("sparkbot_turn_locks").insert({
      rep_id: rep,
      message_id: "zumbi",
      claimed_at: new Date(Date.now() - 120_000).toISOString(),
      expires_at: new Date(Date.now() - 45_000).toISOString(), // venceu há 45s
    });
    const a = await acquireTurnLock(rep, "novo", 0);
    check("lock vencido é roubado na hora", a.status === "acquired", a.status);
    const { data } = await sb
      .from("sparkbot_turn_locks")
      .select("message_id")
      .eq("rep_id", rep)
      .maybeSingle();
    check("o dono passou a ser quem roubou", data?.message_id === "novo", String(data?.message_id));
    await releaseTurnLock(rep, "novo");
  }

  // ── 5. Release não derruba lock de outro dono ────────────────────────
  console.log("\n5. Release só apaga o PRÓPRIO lock");
  {
    const rep = repFake();
    await acquireTurnLock(rep, "dono-atual", 0);
    // Turno lento que já perdeu o lock por TTL tenta soltar o que não é dele.
    await releaseTurnLock(rep, "turno-lento-antigo");
    const { data } = await sb
      .from("sparkbot_turn_locks")
      .select("message_id")
      .eq("rep_id", rep)
      .maybeSingle();
    check("lock do dono atual continua de pé", data?.message_id === "dono-atual", String(data?.message_id));
    await releaseTurnLock(rep, "dono-atual");
    const { data: depois } = await sb
      .from("sparkbot_turn_locks")
      .select("message_id")
      .eq("rep_id", rep)
      .maybeSingle();
    check("o dono conseguiu soltar o dele", !depois);
  }

  // ── 6. Corrida real: 8 claims simultâneos, só 1 pode vencer ──────────
  console.log("\n6. 8 claims no MESMO instante");
  {
    const rep = repFake();
    const res = await Promise.all(
      Array.from({ length: 8 }, (_, i) => acquireTurnLock(rep, `c${i}`, 0)),
    );
    const venceram = res.filter((r) => r.status === "acquired").length;
    check("exatamente 1 venceu", venceram === 1, `${venceram} venceram`);
    const { count } = await sb
      .from("sparkbot_turn_locks")
      .select("*", { count: "exact", head: true })
      .eq("rep_id", rep);
    check("só existe 1 linha de lock pro rep", count === 1, `${count} linhas`);
    for (let i = 0; i < 8; i++) await releaseTurnLock(rep, `c${i}`);
  }

  // ── 7. Espera dentro do teto é atendida ──────────────────────────────
  console.log("\n7. Quem espera dentro do teto é atendido");
  {
    const rep = repFake();
    await acquireTurnLock(rep, "segurando", 0);
    setTimeout(() => void releaseTurnLock(rep, "segurando"), 1500);
    const t0 = Date.now();
    const b = await acquireTurnLock(rep, "esperando", 8000);
    const dt = Date.now() - t0;
    check("pegou depois que o outro soltou", b.status === "acquired", b.status);
    check("esperou ~1,5s (não retornou na hora)", dt >= 1200 && dt < 5000, `${dt}ms`);
    await releaseTurnLock(rep, "esperando");
  }

  // limpeza
  for (const id of sujos) await sb.from("sparkbot_turn_locks").delete().eq("rep_id", id);
  const { count: resto } = await sb
    .from("sparkbot_turn_locks")
    .select("*", { count: "exact", head: true })
    .in("rep_id", sujos);
  check("\nlimpeza: nenhum lock de teste ficou no banco", (resto ?? 0) === 0, `${resto} restaram`);

  console.log(`\n${pass}/${pass + fail} OK (${Math.round((pass / (pass + fail)) * 100)}%)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("ERRO:", e?.message || e);
  process.exit(1);
});
