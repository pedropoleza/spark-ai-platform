/**
 * H37 (Pedro 2026-06-10) — reclaim de recipients órfãos presos em 'sending'.
 *
 * Cobre o bug: se o lambda morre entre o claim (pending→sending) e o UPDATE
 * final (→sent/failed), a row fica presa em 'sending' e o job nunca completa
 * (refreshJobCounters exige sending===0). O fix reverte 'sending' velho (>3min)
 * pra pending no começo de cada tick.
 *
 * Hermético — fake do supabase-js em memória (sem DB/rede). Cobre:
 *   1. isOrphanedSending: idade via claimed_at, fallback scheduled_at, live row.
 *   2. reclaimOrphanedSending: órfã velha → pending; live recente preservada.
 *   3. Fluxo ponta-a-ponta: órfã → reclaim → (re)send → job 'completed' + notify.
 *
 * Rodar: `npx tsx scripts/test-bulk-reclaim-orphans.ts`
 */
import {
  isOrphanedSending,
  reclaimOrphanedSending,
  refreshJobCounters,
} from "../src/lib/account-assistant/proactive/bulk-message-runner";
import { createAdminClient } from "../src/lib/supabase/admin";

let passed = 0;
let failed = 0;
function test(name: string, fn: () => void | Promise<void>): Promise<void> {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  ✗ ${name}\n    ${e instanceof Error ? e.message : e}`);
      failed++;
    });
}
function assert(cond: boolean, msg?: string): void {
  if (!cond) throw new Error(msg || "assertion failed");
}

// ── Fake supabase-js em memória ──────────────────────────────────────────────
// Suporta SÓ as cadeias que reclaimOrphanedSending + refreshJobCounters usam:
//   .from(t).select(cols).eq(col,val)                      → read
//   .from(t).update(patch).in(col,vals).eq(col,val).select(cols) → update+return
//   .from(t).update(patch).eq(col,val).eq(col,val).select(cols)  → update+return
// Builder é "thenable": await dispara a execução contra o store em memória.
type Row = Record<string, unknown>;
type Filter =
  | { k: "eq"; col: string; val: unknown }
  | { k: "in"; col: string; vals: unknown[] };

class FakeBuilder {
  private op: "select" | "update" = "select";
  private patch: Row = {};
  private filters: Filter[] = [];
  private selected = false;
  constructor(private rows: Row[]) {}

  select(_cols?: string): this {
    this.selected = true;
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  eq(col: string, val: unknown): this {
    this.filters.push({ k: "eq", col, val });
    return this;
  }
  in(col: string, vals: unknown[]): this {
    this.filters.push({ k: "in", col, vals });
    return this;
  }

  private match = (r: Row): boolean =>
    this.filters.every((f) =>
      f.k === "eq" ? r[f.col] === f.val : f.vals.includes(r[f.col]),
    );

  private exec(): { data: Row[] | null; error: null } {
    if (this.op === "update") {
      // Matched ANTES do assign (semântica PostgREST: filtra estado atual).
      const affected = this.rows.filter(this.match);
      for (const r of affected) Object.assign(r, this.patch);
      return { data: this.selected ? affected.map((r) => ({ ...r })) : null, error: null };
    }
    return { data: this.rows.filter(this.match).map((r) => ({ ...r })), error: null };
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  then(onF?: (v: { data: Row[] | null; error: null }) => any, onR?: (e: unknown) => any) {
    try {
      return Promise.resolve(this.exec()).then(onF, onR);
    } catch (e) {
      return Promise.reject(e).then(onF, onR);
    }
  }
}

function fakeClient(store: { recipients: Row[]; jobs: Row[] }) {
  const fake = {
    from(table: string) {
      if (table === "bulk_message_recipients") return new FakeBuilder(store.recipients);
      if (table === "bulk_message_jobs") return new FakeBuilder(store.jobs);
      throw new Error(`fake: tabela inesperada ${table}`);
    },
  };
  // O runner tipa deps.supabase como ReturnType<createAdminClient>; o fake só
  // implementa o subconjunto usado. Cast estreito só pro teste.
  return fake as unknown as ReturnType<typeof createAdminClient>;
}

async function main() {
  console.log("\n=== bulk reclaim de órfãos em 'sending' (H37) ===\n");

  // Âncora temporal fixa pro teste (determinístico).
  const now = Date.now();
  const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
  const MIN = 60 * 1000;

  // ── 1. isOrphanedSending (pura) ────────────────────────────────────────────
  const cutoff = now - 3 * MIN; // = RECLAIM_STUCK_AFTER_MS

  await test("claimed_at velho (4min) → órfã", () => {
    assert(isOrphanedSending({ claimed_at: iso(4 * MIN), scheduled_at: iso(5 * MIN) }, cutoff));
  });
  await test("claimed_at recente (1min) → NÃO órfã (não atropela lambda vivo)", () => {
    assert(!isOrphanedSending({ claimed_at: iso(1 * MIN), scheduled_at: iso(5 * MIN) }, cutoff));
  });
  await test("claimed_at recente vence scheduled_at velho → NÃO órfã", () => {
    // Re-claim recente: mesmo com scheduled_at antigo, claimed_at manda.
    assert(!isOrphanedSending({ claimed_at: iso(30 * 1000), scheduled_at: iso(20 * MIN) }, cutoff));
  });
  await test("claimed_at NULL + scheduled_at velho → órfã (fallback pré-00102/deploy)", () => {
    assert(isOrphanedSending({ claimed_at: null, scheduled_at: iso(5 * MIN) }, cutoff));
  });
  await test("claimed_at NULL + scheduled_at recente → NÃO órfã", () => {
    assert(!isOrphanedSending({ claimed_at: null, scheduled_at: iso(1 * MIN) }, cutoff));
  });

  // ── 2. reclaimOrphanedSending: só reverte a órfã, preserva a live ──────────
  await test("reclaim reverte órfã velha e preserva 'sending' recente", async () => {
    const store = {
      jobs: [],
      recipients: [
        { id: "a", status: "sending", claim_token: "tok-a", claimed_at: iso(4 * MIN), scheduled_at: iso(5 * MIN) },
        { id: "b", status: "sending", claim_token: "tok-b", claimed_at: iso(1 * MIN), scheduled_at: iso(30 * 1000) },
      ] as Row[],
    };
    const n = await reclaimOrphanedSending({ supabase: fakeClient(store), nowMs: now });
    assert(n === 1, `esperava 1 revertido, foi ${n}`);
    const a = store.recipients.find((r) => r.id === "a")!;
    const b = store.recipients.find((r) => r.id === "b")!;
    assert(a.status === "pending", `'a' devia virar pending, está ${a.status}`);
    assert(a.claim_token === null && a.claimed_at === null, "'a' devia limpar claim_token/claimed_at");
    assert(b.status === "sending", `'b' (recente) NÃO devia ser tocada, está ${b.status}`);
  });

  await test("reclaim no-op quando não há 'sending' velho", async () => {
    const store = {
      jobs: [],
      recipients: [
        { id: "x", status: "sent", claimed_at: iso(10 * MIN), scheduled_at: iso(11 * MIN) },
        { id: "y", status: "sending", claimed_at: iso(1 * MIN), scheduled_at: iso(30 * 1000) },
      ] as Row[],
    };
    const n = await reclaimOrphanedSending({ supabase: fakeClient(store), nowMs: now });
    assert(n === 0, `esperava 0, foi ${n}`);
  });

  // ── 3. Fluxo ponta-a-ponta: órfã trava o job → reclaim → re-send → completed ─
  await test("job preso em 'running' por órfã → reclaim → re-send → 'completed' + notify", async () => {
    const store = {
      jobs: [
        {
          id: "job-1",
          status: "running",
          sent_count: 0,
          failed_count: 0,
          skipped_count: 0,
          total_contacts: 3,
          updated_at: iso(40 * MIN),
        },
      ] as Row[],
      recipients: [
        { id: "r1", job_id: "job-1", status: "sent", claimed_at: iso(10 * MIN), scheduled_at: iso(11 * MIN) },
        { id: "r2", job_id: "job-1", status: "sent", claimed_at: iso(9 * MIN), scheduled_at: iso(10 * MIN) },
        // Órfã: claim ficou preso, lambda morreu antes do UPDATE final.
        { id: "r3", job_id: "job-1", status: "sending", claim_token: "tok", claimed_at: iso(4 * MIN), scheduled_at: iso(5 * MIN) },
      ] as Row[],
    };
    const supabase = fakeClient(store);
    const notified: string[] = [];
    const notify = async (id: string) => {
      notified.push(id);
    };

    // (a) Estado bugado: enquanto a órfã existe, o job NÃO completa.
    const before = await refreshJobCounters("job-1", { supabase, notify });
    assert(before === false, "com 'sending' órfã o job NÃO devia completar");
    assert(store.jobs[0].status === "running", "job devia continuar 'running' (bug reproduzido)");
    assert(notified.length === 0, "notify NÃO devia disparar com job ainda running");

    // (b) Reclaim: a órfã volta pra pending pra ser re-claimada.
    const n = await reclaimOrphanedSending({ supabase, nowMs: now });
    assert(n === 1, `reclaim devia reverter 1, foi ${n}`);
    assert(store.recipients[2].status === "pending", "r3 devia estar 'pending' pós-reclaim");

    // (c) Próximo tick re-claima e envia com sucesso (simulado sem GHL).
    store.recipients[2].status = "sent";

    // (d) Agora o job fecha e o rep é notificado.
    const after = await refreshJobCounters("job-1", { supabase, notify });
    assert(after === true, "job devia completar após a órfã virar 'sent'");
    assert(store.jobs[0].status === "completed", `job devia estar 'completed', está ${store.jobs[0].status}`);
    assert(store.jobs[0].sent_count === 3, `sent_count devia ser 3, é ${store.jobs[0].sent_count}`);
    assert(notified.length === 1 && notified[0] === "job-1", "rep devia ser notificado 1x da conclusão");
  });

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[test-bulk-reclaim-orphans] crashed:", err);
  process.exit(1);
});
