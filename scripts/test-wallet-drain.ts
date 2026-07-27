/**
 * Testes do núcleo do auto-drain da wallet (Pedro 2026-07-27) — drainAndRetry.
 *
 * Modela uma carteira que dispara o auto-recharge do HL ao cruzar o limiar
 * (padrão: zerar), com min-charge opcional (o GHL pode ter piso de cobrança) e
 * um "recharge que nunca dispara" (premissa do Pedro furada) pra provar o
 * fail-safe. READ-ONLY (mocks; zero GHL).
 *
 * Rodar: npx tsx scripts/test-wallet-drain.ts
 */
import { drainAndRetry, type ChargeOutcome } from "../src/lib/billing/charge";

let pass = 0,
  fail = 0;
function check(name: string, cond: boolean, detail?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.error(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Carteira simulada. `rechargeAt` = limiar; quando o saldo chega a ≤ rechargeAt
 * (após um dreno), recarrega +rechargeAmount UMA vez. `minCharge` = piso do GHL
 * (cobranças abaixo disso são rejeitadas). O saldo NUNCA vai abaixo de 0 (o GHL
 * rejeita cobrança > saldo) — igual à prod.
 */
function makeWallet(
  startBalance: number,
  realAmount: number,
  opts: { rechargeAt?: number; rechargeAmount?: number; minCharge?: number } = {},
) {
  const rechargeAt = opts.rechargeAt ?? 0;
  const rechargeAmount = opts.rechargeAmount ?? 10;
  const minCharge = opts.minCharge ?? 0;
  let balance = startBalance;
  let recharged = false;
  let drainCalls = 0;
  let realCalls = 0;
  const EPS = 1e-9;

  const drainCharge = async (amount: number): Promise<ChargeOutcome> => {
    drainCalls++;
    if (amount < minCharge - EPS) return "insufficient"; // piso do GHL
    if (amount > balance + EPS) return "insufficient"; // saldo insuficiente
    balance = r2(balance - amount);
    if (!recharged && balance <= rechargeAt + EPS) {
      balance = r2(balance + rechargeAmount);
      recharged = true;
    }
    return "ok";
  };
  const retryReal = async (): Promise<ChargeOutcome> => {
    realCalls++;
    if (realAmount > balance + EPS) return "insufficient";
    balance = r2(balance - realAmount);
    return "ok";
  };
  return {
    drainCharge,
    retryReal,
    get balance() {
      return balance;
    },
    get recharged() {
      return recharged;
    },
    get drainCalls() {
      return drainCalls;
    },
    get realCalls() {
      return realCalls;
    },
  };
}

async function main() {
  console.log("\ndrainAndRetry — caminho feliz (zerar dispara recharge)");

  {
    // Residual $0,04, turno $0,20 → drena 0.02+0.02, zera, recarrega, real passa.
    const w = makeWallet(0.04, 0.2);
    const res = await drainAndRetry({ drainCharge: w.drainCharge, retryReal: w.retryReal });
    check("residual 0.04 resolve", res.resolved === true, res.reason);
    check("drenou exatamente 0.04", res.drainedUsd === 0.04, `drained=${res.drainedUsd}`);
    check("recarregou de fato", w.recharged === true);
  }

  {
    // Residual $0,03 (não-múltiplo de 0.02) → escada desce pra 0.01 e fecha.
    const w = makeWallet(0.03, 0.25);
    const res = await drainAndRetry({ drainCharge: w.drainCharge, retryReal: w.retryReal });
    check("residual 0.03 (não-múltiplo) resolve", res.resolved === true, res.reason);
    check("drenou 0.03", res.drainedUsd === 0.03, `drained=${res.drainedUsd}`);
  }

  {
    // Residual = uma denominação cheia (0.10) → 1 dreno zera e recarrega.
    const w = makeWallet(0.1, 0.3);
    const res = await drainAndRetry({ drainCharge: w.drainCharge, retryReal: w.retryReal });
    check("residual 0.10 resolve em 1 dreno", res.resolved === true && res.drainedUsd === 0.1, res.reason);
  }

  console.log("\ndrainAndRetry — fronteira 'cobrar == saldo' rejeitada pelo GHL");
  {
    // Alguns gateways tratam charge == balance como insuficiente. minCharge não,
    // mas simulamos exigindo estritamente <: aqui uso minCharge=0 e a lógica de
    // >balance já cobre. Testo o caso em que a denominação exata falha e a menor fecha.
    const w = makeWallet(0.04, 0.2, { minCharge: 0 });
    const res = await drainAndRetry({
      drainCharge: async (a) => (a > 0.04 + 1e-9 ? "insufficient" : w.drainCharge(a)),
      retryReal: w.retryReal,
      steps: [0.04, 0.02, 0.01],
    });
    // 0.04 vs 0.04 passa (== saldo permitido aqui) → zera. Se o teste acima cobre
    // o == permitido, este garante que a escada funciona com denominação custom.
    check("escada custom resolve", res.resolved === true, res.reason);
  }

  console.log("\ndrainAndRetry — FAIL-SAFE (premissa do Pedro furada / edge)");
  {
    // Recharge NUNCA dispara (rechargeAt muito negativo) → não dá pra zerar abaixo
    // de 0 → esgota sem resolver, mas drena só até o teto (vazamento limitado).
    const w = makeWallet(0.3, 0.35, { rechargeAt: -100 });
    const res = await drainAndRetry({ drainCharge: w.drainCharge, retryReal: w.retryReal, maxDrainUsd: 0.5 });
    check("recharge que não dispara → NÃO resolve", res.resolved === false);
    check("vazamento ≤ teto de dreno (0.50)", res.drainedUsd <= 0.5, `drained=${res.drainedUsd}`);
  }

  {
    // Saldo já zero e recharge não dispara → 0 drenado, não resolve (no-op seguro).
    const w = makeWallet(0, 0.2, { rechargeAt: -100 });
    const res = await drainAndRetry({ drainCharge: w.drainCharge, retryReal: w.retryReal });
    check("saldo 0 sem recharge → 0 drenado", res.drainedUsd === 0 && res.resolved === false);
  }

  {
    // Residual sub-cent com min-charge do GHL $0,01 → não dá pra drenar → no-op.
    const w = makeWallet(0.004, 0.2, { minCharge: 0.01 });
    const res = await drainAndRetry({ drainCharge: w.drainCharge, retryReal: w.retryReal });
    check("residual sub-cent (min-charge) → não resolve, 0 drenado", res.resolved === false && res.drainedUsd === 0);
  }

  {
    // Teto de dreno (maxDrainUsd) corta antes de estourar.
    const w = makeWallet(0.9, 0.95, { rechargeAt: -100 });
    const res = await drainAndRetry({ drainCharge: w.drainCharge, retryReal: w.retryReal, maxDrainUsd: 0.2 });
    check("teto maxDrainUsd corta", res.reason === "max_drain_cap", res.reason);
    check("não drenou além de ~0.20", res.drainedUsd <= 0.2, `drained=${res.drainedUsd}`);
  }

  console.log("\ndrainAndRetry — deadline de wall-clock (blinda os 60s da lambda)");
  {
    // Deadline já no passado → para na 1ª iteração, 0 drenado, razão "deadline".
    const w = makeWallet(0.3, 0.35, { rechargeAt: -100 });
    const res = await drainAndRetry({
      drainCharge: w.drainCharge,
      retryReal: w.retryReal,
      deadline: Date.now() - 1,
    });
    check("deadline no passado → para imediato", res.reason === "deadline" && res.resolved === false);
    check("deadline → 0 drenado, 0 cobrança", res.drainedUsd === 0 && w.drainCalls === 0);
  }

  console.log("\ndrainAndRetry — erros duros abortam (token/config)");
  {
    // drainCharge devolve "error" (não é saldo) → aborta sem drenar mais.
    const res = await drainAndRetry({
      drainCharge: async () => "error",
      retryReal: async () => "insufficient",
    });
    check("drain_error aborta", res.reason === "drain_error" && res.resolved === false);
  }
  {
    // real devolve "error" após um dreno ok → aborta.
    let first = true;
    const res = await drainAndRetry({
      drainCharge: async () => (first ? ((first = false), "ok") : "insufficient"),
      retryReal: async () => "error",
    });
    check("real_error aborta", res.reason === "real_error" && res.resolved === false);
  }

  console.log(`\n═══ RESULTADO: ${pass} passed · ${fail} failed ═══`);
  process.exit(fail > 0 ? 1 : 0);
}

main();
