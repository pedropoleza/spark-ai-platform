/**
 * NB-11 (review 2026-06-10) — priority queue do bulk-runner fura fila NO DB,
 * mesmo sob backlog.
 *
 * Cobre o bug: o claim antigo fazia SELECT ORDER BY scheduled_at LIMIT 20
 * (buffer) + sort client-side por priority. Sob backlog (>=20 recipients de
 * baixa prioridade já vencidos com timestamps antigos), o buffer de 20 era todo
 * consumido por eles e um job de ALTA prioridade com scheduled_at mais novo
 * nunca entrava na janela → o "fura fila" falhava justo quando importa. Fix:
 * ordenação por priority NO DB (RPC claim_bulk_recipients, migration 00105),
 * com fallback legado (buffer maior + sort) pro gap de deploy.
 *
 * Hermético — fake do supabase-js em memória (sem DB/rede). Cobre:
 *   1. selectClaimBatch (pura): backlog de 22 baixos + 5 altos → top-5 = altos;
 *      tiebreak por scheduled_at; filtros (status/job/scheduled futuro).
 *   2. claimBulkRecipients via RPC (caminho primário): chama com p_limit/token
 *      e devolve as rows da RPC.
 *   3. claimBulkRecipients fallback (RPC ausente, PGRST202): claim end-to-end
 *      pelo caminho legado real → high-priority reivindicados primeiro.
 *   4. Erro REAL da RPC (não "função ausente") propaga.
 *
 * Rodar: `npx tsx scripts/test-bulk-priority-claim.ts`
 */
import {
  selectClaimBatch,
  claimBulkRecipients,
  type ClaimCandidate,
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
// Suporta as cadeias que claimBulkRecipients (fallback) usa:
//   .from(t).select(cols).eq().lte().order().limit()                  → read (+ join M2O !inner)
//   .from(t).update(patch).in().eq().select()                         → update+return
// + .rpc(name, params) (caminho primário), injetável por teste.
type Row = Record<string, unknown>;
type Filter =
  | { k: "eq"; col: string; val: unknown }
  | { k: "in"; col: string; vals: unknown[] }
  | { k: "lte"; col: string; val: unknown };

class FakeBuilder {
  private op: "select" | "update" = "select";
  private patch: Row = {};
  private filters: Filter[] = [];
  private selected = false;
  private selectCols = "";
  private orderCol: string | null = null;
  private orderAsc = true;
  private limitN: number | null = null;
  constructor(
    private rows: Row[],
    private store: { recipients: Row[]; jobs: Row[] },
  ) {}

  select(cols?: string): this {
    this.selected = true;
    this.selectCols = cols ?? "";
    return this;
  }
  update(patch: Row): this {
    this.op = "update";
    this.patch = patch;
    return this;
  }
  eq(col: string, val: unknown): this { this.filters.push({ k: "eq", col, val }); return this; }
  in(col: string, vals: unknown[]): this { this.filters.push({ k: "in", col, vals }); return this; }
  lte(col: string, val: unknown): this { this.filters.push({ k: "lte", col, val }); return this; }
  order(col: string, opts?: { ascending?: boolean }): this {
    this.orderCol = col;
    this.orderAsc = opts?.ascending !== false;
    return this;
  }
  limit(n: number): this { this.limitN = n; return this; }

  private match = (r: Row): boolean =>
    this.filters.every((f) => {
      if (f.k === "eq") return r[f.col] === f.val;
      if (f.k === "in") return f.vals.includes(r[f.col]);
      // lte sobre ISO strings (todas geradas com toISOString → compara cronológico).
      return String(r[f.col]) <= String(f.val);
    });

  // Join M2O: quando o select pede `bulk_message_jobs!inner(...)`, anexa o job
  // casado por job_id (inner = dropa recipient sem job correspondente).
  private attachEmbedded(rows: Row[]): Row[] {
    if (!this.selectCols.includes("bulk_message_jobs")) return rows.map((r) => ({ ...r }));
    const inner = this.selectCols.includes("bulk_message_jobs!inner");
    const out: Row[] = [];
    for (const r of rows) {
      const job = this.store.jobs.find((j) => j.id === r.job_id);
      if (!job && inner) continue;
      out.push({ ...r, bulk_message_jobs: job ? { ...job } : null });
    }
    return out;
  }

  private exec(): { data: Row[] | null; error: null } {
    if (this.op === "update") {
      // Matched ANTES do assign (semântica PostgREST: filtra estado atual).
      const affected = this.rows.filter(this.match);
      for (const r of affected) Object.assign(r, this.patch);
      return { data: this.selected ? affected.map((r) => ({ ...r })) : null, error: null };
    }
    let result = this.attachEmbedded(this.rows.filter(this.match));
    if (this.orderCol) {
      const col = this.orderCol;
      const asc = this.orderAsc;
      result.sort((a, b) => {
        const av = String(a[col]);
        const bv = String(b[col]);
        if (av === bv) return 0;
        return asc ? (av < bv ? -1 : 1) : av > bv ? -1 : 1;
      });
    }
    if (this.limitN != null) result = result.slice(0, this.limitN);
    return { data: result, error: null };
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

type RpcResult = { data: Row[] | null; error: { code?: string; message?: string } | null };
function fakeClient(
  store: { recipients: Row[]; jobs: Row[] },
  rpc: (name: string, params: Row) => RpcResult,
) {
  const fake = {
    from(table: string) {
      if (table === "bulk_message_recipients") return new FakeBuilder(store.recipients, store);
      if (table === "bulk_message_jobs") return new FakeBuilder(store.jobs, store);
      throw new Error(`fake: tabela inesperada ${table}`);
    },
    rpc(name: string, params: Row) {
      return Promise.resolve(rpc(name, params));
    },
  };
  // O runner tipa supabase como ReturnType<createAdminClient>; o fake só
  // implementa o subconjunto usado. Cast estreito só pro teste.
  return fake as unknown as ReturnType<typeof createAdminClient>;
}

// ── Helpers de fixture ───────────────────────────────────────────────────────
const now = Date.now();
const iso = (msAgo: number) => new Date(now - msAgo).toISOString();
const MIN = 60 * 1000;

/**
 * Cenário do bug: backlog de 22 recipients de prioridade BAIXA (job running),
 * todos vencidos há 60-81min (mais ANTIGOS) + 5 de prioridade ALTA vencidos há
 * 1-5min (mais NOVOS). Sob o buffer-20-por-scheduled_at antigo, os 22 antigos
 * dominariam e os 5 altos nunca seriam vistos.
 */
function backlogScenario(): {
  recipients: Row[];
  jobs: Row[];
  highIds: string[];
  lowIds: string[];
} {
  const jobs: Row[] = [
    { id: "job-low", status: "running", priority: 50 },
    { id: "job-high", status: "running", priority: 80 },
  ];
  const lowIds: string[] = [];
  const recipients: Row[] = [];
  for (let i = 0; i < 22; i++) {
    const id = `low-${i}`;
    lowIds.push(id);
    recipients.push({
      id,
      job_id: "job-low",
      contact_id: `c-low-${i}`,
      status: "pending",
      scheduled_at: iso((81 - i) * MIN), // 81..60min atrás (antigos)
      claim_token: null,
      claimed_at: null,
    });
  }
  const highIds: string[] = [];
  for (let i = 0; i < 5; i++) {
    const id = `high-${i}`;
    highIds.push(id);
    recipients.push({
      id,
      job_id: "job-high",
      contact_id: `c-high-${i}`,
      status: "pending",
      scheduled_at: iso((5 - i) * MIN), // 5..1min atrás (novos)
      claim_token: null,
      claimed_at: null,
    });
  }
  return { recipients, jobs, highIds, lowIds };
}

function toCandidates(recipients: Row[], jobs: Row[]): ClaimCandidate[] {
  return recipients.map((r) => {
    const j = jobs.find((x) => x.id === r.job_id);
    return {
      id: r.id as string,
      scheduled_at: r.scheduled_at as string,
      job_priority: (j?.priority as number) ?? 50,
      job_status: (j?.status as string) ?? "",
      recipient_status: r.status as string,
    };
  });
}

async function main() {
  console.log("\n=== bulk priority claim — fura fila no DB sob backlog (NB-11) ===\n");

  // ── 1. selectClaimBatch (política pura) ────────────────────────────────────
  await test("backlog 22 baixos (antigos) + 5 altos (novos) → top-5 são os ALTOS", () => {
    const { recipients, jobs, highIds } = backlogScenario();
    const picked = selectClaimBatch(toCandidates(recipients, jobs), now, 5);
    assert(picked.length === 5, `esperava 5, foi ${picked.length}`);
    assert(
      picked.every((c) => highIds.includes(c.id)),
      `top-5 deviam ser todos high-priority, vieram: ${picked.map((c) => c.id).join(",")}`,
    );
    assert(
      picked.every((c) => c.job_priority === 80),
      "todos os escolhidos deviam ter priority 80",
    );
  });

  await test("mesma priority → desempata por scheduled_at ASC (mais antigo primeiro)", () => {
    const cands: ClaimCandidate[] = [
      { id: "novo", scheduled_at: iso(1 * MIN), job_priority: 50, job_status: "running", recipient_status: "pending" },
      { id: "antigo", scheduled_at: iso(9 * MIN), job_priority: 50, job_status: "running", recipient_status: "pending" },
      { id: "medio", scheduled_at: iso(5 * MIN), job_priority: 50, job_status: "running", recipient_status: "pending" },
    ];
    const picked = selectClaimBatch(cands, now, 3).map((c) => c.id);
    assert(JSON.stringify(picked) === JSON.stringify(["antigo", "medio", "novo"]), `ordem inesperada: ${picked.join(",")}`);
  });

  await test("alta priority vence mesmo sendo mais NOVA que a baixa", () => {
    const cands: ClaimCandidate[] = [
      { id: "baixa-antiga", scheduled_at: iso(60 * MIN), job_priority: 30, job_status: "running", recipient_status: "pending" },
      { id: "alta-nova", scheduled_at: iso(1 * MIN), job_priority: 90, job_status: "running", recipient_status: "pending" },
    ];
    const picked = selectClaimBatch(cands, now, 1).map((c) => c.id);
    assert(picked[0] === "alta-nova", `esperava 'alta-nova' primeiro, foi ${picked[0]}`);
  });

  await test("filtra job não-running, recipient não-pending e scheduled_at futuro", () => {
    const cands: ClaimCandidate[] = [
      { id: "ok", scheduled_at: iso(1 * MIN), job_priority: 50, job_status: "running", recipient_status: "pending" },
      { id: "job-pausado", scheduled_at: iso(1 * MIN), job_priority: 99, job_status: "paused", recipient_status: "pending" },
      { id: "ja-sending", scheduled_at: iso(1 * MIN), job_priority: 99, job_status: "running", recipient_status: "sending" },
      { id: "futuro", scheduled_at: new Date(now + 10 * MIN).toISOString(), job_priority: 99, job_status: "running", recipient_status: "pending" },
    ];
    const picked = selectClaimBatch(cands, now, 10).map((c) => c.id);
    assert(JSON.stringify(picked) === JSON.stringify(["ok"]), `só 'ok' devia passar, veio: ${picked.join(",")}`);
  });

  // ── 2. claimBulkRecipients via RPC (caminho primário) ──────────────────────
  await test("usa a RPC claim_bulk_recipients com p_limit + token, devolve as rows", async () => {
    const captured: { name?: string; params?: Row } = {};
    const rpcRows: Row[] = [
      { id: "high-0", job_id: "job-high", status: "sending", scheduled_at: iso(1 * MIN) },
      { id: "high-1", job_id: "job-high", status: "sending", scheduled_at: iso(2 * MIN) },
    ];
    const supabase = fakeClient(
      { recipients: [], jobs: [] },
      (name, params) => {
        captured.name = name;
        captured.params = params;
        return { data: rpcRows, error: null };
      },
    );
    const claimed = await claimBulkRecipients(supabase, 5, iso(0));
    assert(captured.name === "claim_bulk_recipients", `RPC errada: ${captured.name}`);
    assert(captured.params?.p_limit === 5, `p_limit devia ser 5, foi ${captured.params?.p_limit}`);
    assert(
      typeof captured.params?.p_claim_token === "string" && (captured.params.p_claim_token as string).length > 10,
      "p_claim_token devia ser um uuid string",
    );
    assert(claimed.length === 2 && claimed.every((r) => r.status === "sending"), "devia devolver as 2 rows da RPC");
  });

  // ── 3. Fallback (RPC ausente, PGRST202): claim end-to-end pelo legado ───────
  await test("RPC ausente (PGRST202) → fallback legado reivindica os ALTOS primeiro", async () => {
    const { recipients, jobs, highIds, lowIds } = backlogScenario();
    const store = { recipients, jobs };
    const supabase = fakeClient(store, () => ({
      data: null,
      error: { code: "PGRST202", message: "Could not find the function public.claim_bulk_recipients" },
    }));

    const claimed = await claimBulkRecipients(supabase, 5, iso(0));
    assert(claimed.length === 5, `fallback devia reivindicar 5, foi ${claimed.length}`);
    assert(
      claimed.every((r) => highIds.includes(r.id as unknown as string)),
      `fallback devia reivindicar os high-priority, veio: ${claimed.map((r) => r.id).join(",")}`,
    );
    // Efeito no store: os 5 altos viraram 'sending' com claim_token; os baixos seguem pending.
    for (const id of highIds) {
      const r = store.recipients.find((x) => x.id === id)!;
      assert(r.status === "sending", `${id} devia estar 'sending', está ${r.status}`);
      assert(!!r.claim_token, `${id} devia ter claim_token carimbado`);
      assert(!!r.claimed_at, `${id} devia ter claimed_at carimbado`);
    }
    const lowsStillPending = lowIds.every((id) => store.recipients.find((x) => x.id === id)!.status === "pending");
    assert(lowsStillPending, "os 22 baixos deviam continuar 'pending'");
  });

  // ── 4. Erro REAL da RPC propaga (não confunde com "função ausente") ─────────
  await test("erro real da RPC (não missing-function) propaga pro caller", async () => {
    const supabase = fakeClient({ recipients: [], jobs: [] }, () => ({
      data: null,
      error: { code: "XX000", message: "deadlock detected" },
    }));
    let threw = false;
    try {
      await claimBulkRecipients(supabase, 5, iso(0));
    } catch {
      threw = true;
    }
    assert(threw, "claimBulkRecipients devia propagar erro real da RPC");
  });

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("[test-bulk-priority-claim] crashed:", err);
  process.exit(1);
});
