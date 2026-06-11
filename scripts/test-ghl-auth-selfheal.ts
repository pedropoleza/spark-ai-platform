/**
 * Test suite — Self-heal do company token (SPOF de auth, Pedro 2026-06-10).
 *
 * Roda: npx tsx -r tsconfig-paths/register scripts/test-ghl-auth-selfheal.ts
 *
 * Cobre a orquestração de `generateLocationToken` com deps FAKE (sem rede/DB):
 *   - company token expirado → refresh inline → sucesso
 *   - refresh falhou → erro limpo
 *   - corrida de rotação cross-lambda (refresh lança mas DB já tem par novo) → recupera
 *   - refresh PROATIVO perto de expirar (+ fail-soft)
 *   - coalesce do mutex de company refresh (N→1, limpa no finally)
 *   - isCompanyTokenNearExpiry (pura)
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import {
  generateLocationToken,
  isCompanyTokenNearExpiry,
  coalesceCompanyRefresh,
  type LocationTokenDeps,
  type LocationTokenFetchResult,
} from "../src/lib/ghl/auth";

let passed = 0;
let failed = 0;

async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

function eq<T>(actual: T, expected: T, label?: string) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `${label || "values"} differ:\n  actual: ${JSON.stringify(actual)}\n  expected: ${JSON.stringify(expected)}`,
    );
  }
}

async function expectThrows(
  fn: () => Promise<unknown>,
  pattern: RegExp,
  label: string,
) {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    const msg = e instanceof Error ? e.message : String(e);
    if (!pattern.test(msg)) {
      throw new Error(`${label}: erro com mensagem inesperada: "${msg}" (esperava ${pattern})`);
    }
  }
  if (!threw) throw new Error(`${label}: esperava throw, não lançou`);
}

const TWO_HOURS_MS = 2 * 60 * 60 * 1000;
const T0 = Date.parse("2026-06-10T12:00:00.000Z"); // "agora" fixo nos testes
const DAY_SECONDS = 86_400;

const tick = () => new Promise((r) => setTimeout(r, 5));

// Resultado de fetchLocationToken válido só pra um company token específico —
// modela "company token X é o bom; qualquer outro (expirado) volta 401".
const validOnlyFor =
  (validToken: string) =>
  (companyAccessToken: string): LocationTokenFetchResult =>
    companyAccessToken === validToken
      ? { status: 200, ok: true, access_token: "loc-token-OK" }
      : { status: 401, ok: false, bodyText: "company token expired" };

interface Spy {
  refresh: number;
  getMeta: number;
  fetch: number;
  engaged: number;
  failed: number;
}

function makeDeps(opts: {
  initialToken?: string;
  expiresIn?: number | null;
  updatedAt?: string | null;
  proactiveEnabled?: boolean;
  proactiveMarginMs?: number;
  now?: number;
  locToken: (companyAccessToken: string) => LocationTokenFetchResult;
  /** Muta `box.token` (e/ou lança) — simula o refresh do company token. */
  refresh?: (box: { token: string }) => Promise<void>;
}): { deps: LocationTokenDeps; spy: Spy; box: { token: string } } {
  const box = { token: opts.initialToken ?? "company-OLD" };
  const spy: Spy = { refresh: 0, getMeta: 0, fetch: 0, engaged: 0, failed: 0 };

  const deps: LocationTokenDeps = {
    getCompanyMeta: async () => {
      spy.getMeta++;
      return {
        access_token: box.token,
        expires_in: opts.expiresIn,
        updated_at: opts.updatedAt,
      };
    },
    refreshCompany: async () => {
      spy.refresh++;
      if (opts.refresh) await opts.refresh(box);
      else box.token = "company-FRESH"; // default: refresh deixa o token válido
    },
    fetchLocationToken: async (companyAccessToken) => {
      spy.fetch++;
      return opts.locToken(companyAccessToken);
    },
    now: () => opts.now ?? T0,
    proactiveEnabled: opts.proactiveEnabled ?? false,
    proactiveMarginMs: opts.proactiveMarginMs ?? TWO_HOURS_MS,
    onSelfHealEngaged: () => {
      spy.engaged++;
    },
    onSelfHealFailed: () => {
      spy.failed++;
    },
  };

  return { deps, spy, box };
}

async function main() {
  console.log("\n=== Self-heal company token — Test Suite ===\n");

  console.log("generateLocationToken — reativo (401 → refresh inline):");

  await test("happy path: 200 de primeira → sem self-heal", async () => {
    const { deps, spy } = makeDeps({
      initialToken: "company-FRESH",
      locToken: validOnlyFor("company-FRESH"),
    });
    const token = await generateLocationToken("co1", "loc1", deps);
    eq(token, "loc-token-OK", "token");
    eq(spy.refresh, 0, "refresh chamadas");
    eq(spy.engaged, 0, "engaged");
    eq(spy.fetch, 1, "fetch chamadas");
  });

  await test("company token expirado → refresh inline → sucesso", async () => {
    // 1º fetch usa "company-OLD" → 401 → refresh seta "company-FRESH" → 2º fetch OK.
    const { deps, spy } = makeDeps({
      initialToken: "company-OLD",
      locToken: validOnlyFor("company-FRESH"),
    });
    const token = await generateLocationToken("co1", "loc1", deps);
    eq(token, "loc-token-OK", "token");
    eq(spy.refresh, 1, "refresh chamadas (coalesce 1)");
    eq(spy.engaged, 1, "onSelfHealEngaged disparou 1×");
    eq(spy.failed, 0, "onSelfHealFailed NÃO disparou");
    eq(spy.fetch, 2, "fetch: 1 falho + 1 retry");
  });

  await test("refresh falhou + token segue inválido → erro limpo + onSelfHealFailed", async () => {
    const { deps, spy } = makeDeps({
      initialToken: "company-OLD",
      locToken: validOnlyFor("company-FRESH"), // OLD nunca vira válido
      refresh: async () => {
        throw new Error("refresh failed: 401 — invalid_grant");
      },
    });
    await expectThrows(
      () => generateLocationToken("co1", "loc1", deps),
      /Falha ao gerar location token: 401/,
      "erro terminal",
    );
    eq(spy.engaged, 1, "engaged disparou");
    eq(spy.failed, 1, "onSelfHealFailed disparou (auth quebrado)");
  });

  await test("corrida de rotação cross-lambda: refresh lança mas DB já tem par novo → recupera", async () => {
    // Outra lambda rotacionou+gravou o token novo; o refresh DESTA lança (RT já
    // usado), mas o re-read do DB pega o "company-FRESH" gravado pela outra.
    const { deps, spy } = makeDeps({
      initialToken: "company-OLD",
      locToken: validOnlyFor("company-FRESH"),
      refresh: async (box) => {
        box.token = "company-FRESH"; // simula o par que a outra lambda gravou
        throw new Error("refresh failed: 401 — refresh_token já usado");
      },
    });
    const token = await generateLocationToken("co1", "loc1", deps);
    eq(token, "loc-token-OK", "token recuperado via re-read");
    eq(spy.engaged, 1, "engaged disparou");
    eq(spy.failed, 0, "onSelfHealFailed NÃO disparou (recuperou)");
  });

  console.log("\ngenerateLocationToken — proativo (expires_in/updated_at):");

  await test("perto de expirar (1h restante, margem 2h) → refresh ANTES do fetch", async () => {
    const { deps, spy } = makeDeps({
      initialToken: "company-OLD",
      // emitido há 23h, dura 24h → expira em T0+1h (dentro da margem de 2h)
      updatedAt: new Date(T0 - 23 * 3600 * 1000).toISOString(),
      expiresIn: DAY_SECONDS,
      proactiveEnabled: true,
      now: T0,
      locToken: validOnlyFor("company-FRESH"),
    });
    const token = await generateLocationToken("co1", "loc1", deps);
    eq(token, "loc-token-OK", "token");
    eq(spy.refresh, 1, "refresh proativo 1×");
    eq(spy.engaged, 0, "sem 401 reativo (proativo já resolveu)");
    eq(spy.fetch, 1, "1 fetch só (já com token fresco)");
  });

  await test("longe de expirar (23h restante) → NÃO faz refresh proativo", async () => {
    const { deps, spy } = makeDeps({
      initialToken: "company-OLD",
      updatedAt: new Date(T0 - 1 * 3600 * 1000).toISOString(), // emitido há 1h
      expiresIn: DAY_SECONDS,
      proactiveEnabled: true,
      now: T0,
      locToken: validOnlyFor("company-OLD"), // token atual ainda serve
    });
    const token = await generateLocationToken("co1", "loc1", deps);
    eq(token, "loc-token-OK", "token");
    eq(spy.refresh, 0, "sem refresh proativo");
  });

  await test("proativo DESLIGADO + perto de expirar → não renova proativamente", async () => {
    const { deps, spy } = makeDeps({
      initialToken: "company-OLD",
      updatedAt: new Date(T0 - 23 * 3600 * 1000).toISOString(),
      expiresIn: DAY_SECONDS,
      proactiveEnabled: false,
      now: T0,
      locToken: validOnlyFor("company-OLD"),
    });
    const token = await generateLocationToken("co1", "loc1", deps);
    eq(token, "loc-token-OK", "token");
    eq(spy.refresh, 0, "proativo off → 0 refresh");
  });

  await test("proativo fail-soft: refresh lança mas token atual ainda vale → segue sem erro", async () => {
    const { deps, spy } = makeDeps({
      initialToken: "company-OLD",
      updatedAt: new Date(T0 - 23 * 3600 * 1000).toISOString(),
      expiresIn: DAY_SECONDS,
      proactiveEnabled: true,
      now: T0,
      locToken: validOnlyFor("company-OLD"), // OLD ainda funciona dentro da margem
      refresh: async () => {
        throw new Error("refresh failed: 429 rate limit");
      },
    });
    const token = await generateLocationToken("co1", "loc1", deps);
    eq(token, "loc-token-OK", "token (token atual ainda válido)");
    eq(spy.refresh, 1, "tentou 1 refresh proativo");
    eq(spy.engaged, 0, "não houve 401 reativo");
  });

  console.log("\ncoalesceCompanyRefresh — mutex por companyId:");

  await test("5 chamadas concorrentes pra mesma company → 1 refresh real", async () => {
    let calls = 0;
    const refresh = async () => {
      calls++;
      await tick();
    };
    await Promise.all(
      Array.from({ length: 5 }, () => coalesceCompanyRefresh("co-burst", refresh)),
    );
    eq(calls, 1, "coalesce N→1");
  });

  await test("mutex limpa no finally: chamada posterior dispara novo refresh", async () => {
    let calls = 0;
    const refresh = async () => {
      calls++;
      await tick();
    };
    await coalesceCompanyRefresh("co-seq", refresh);
    await coalesceCompanyRefresh("co-seq", refresh);
    eq(calls, 2, "duas janelas separadas → 2 refreshes");
  });

  await test("companyIds diferentes NÃO coalescem", async () => {
    let calls = 0;
    const refresh = async () => {
      calls++;
      await tick();
    };
    await Promise.all([
      coalesceCompanyRefresh("co-a", refresh),
      coalesceCompanyRefresh("co-b", refresh),
    ]);
    eq(calls, 2, "2 companies → 2 refreshes");
  });

  await test("refresh que lança ainda limpa o mutex (próxima tenta de novo)", async () => {
    let calls = 0;
    const throwing = async () => {
      calls++;
      await tick();
      throw new Error("boom");
    };
    await coalesceCompanyRefresh("co-throw", throwing).catch(() => {});
    await coalesceCompanyRefresh("co-throw", throwing).catch(() => {});
    eq(calls, 2, "mutex limpou após throw");
  });

  console.log("\nisCompanyTokenNearExpiry — pura:");

  await test("sem expires_in → false (fail-safe, confia no cron/reativo)", () => {
    eq(isCompanyTokenNearExpiry({ updated_at: new Date(T0).toISOString() }, T0, TWO_HOURS_MS), false);
  });

  await test("sem updated_at → false", () => {
    eq(isCompanyTokenNearExpiry({ expires_in: DAY_SECONDS }, T0, TWO_HOURS_MS), false);
  });

  await test("updated_at malformado → false", () => {
    eq(
      isCompanyTokenNearExpiry({ expires_in: DAY_SECONDS, updated_at: "não-é-data" }, T0, TWO_HOURS_MS),
      false,
    );
  });

  await test("emitido agora, dura 24h, margem 2h → NÃO está perto (false)", () => {
    eq(
      isCompanyTokenNearExpiry(
        { expires_in: DAY_SECONDS, updated_at: new Date(T0).toISOString() },
        T0,
        TWO_HOURS_MS,
      ),
      false,
    );
  });

  await test("expira em 1h, margem 2h → está perto (true)", () => {
    eq(
      isCompanyTokenNearExpiry(
        { expires_in: DAY_SECONDS, updated_at: new Date(T0 - 23 * 3600 * 1000).toISOString() },
        T0,
        TWO_HOURS_MS,
      ),
      true,
    );
  });

  await test("já expirado → está perto (true)", () => {
    eq(
      isCompanyTokenNearExpiry(
        { expires_in: DAY_SECONDS, updated_at: new Date(T0 - 30 * 3600 * 1000).toISOString() },
        T0,
        TWO_HOURS_MS,
      ),
      true,
    );
  });

  console.log(`\n=== Result: ${passed} passed, ${failed} failed ===\n`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e instanceof Error ? e.message : e);
  process.exit(1);
});
