/**
 * Testes da carência de débito da wallet (H60, caso Wesley 2026-08-01).
 *
 * O caso real: wallet com $0.31, turno de $0.397083 → GHL 400 "insufficient
 * funds" → bloqueio na PRIMEIRA falha + aviso, com saldo visível no painel.
 * Aqui provamos: (1) o parse do teto WALLET_GRACE_USD; (2) a decisão
 * bloquear×carência sobre o débito somado do DB (fake); (3) o cooldown de 4h
 * do aviso ao rep (dedup pelo histórico persistido); (4) o marcador da copy
 * que o cooldown usa continua presente nas DUAS mensagens novas.
 *
 * READ-ONLY (supabase fake via Proxy; zero rede). Rodar:
 *   npx tsx scripts/test-wallet-grace.ts
 */

let pass = 0,
  fail = 0;
function check(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

// ---------------------------------------------------------------------------
// Fake do supabase admin: intercepta ANTES do import do módulo sob teste.
// Query-builder Proxy: qualquer método encadeia; await resolve com o payload
// configurado por tabela. Mesmo padrão do test-pending-subject.ts.
// ---------------------------------------------------------------------------
type Payload = { data: unknown; error: unknown };
const tableResults = new Map<string, Payload>();
let lastFilters: Record<string, unknown[]> = {};

function fakeQuery(table: string) {
  const calls: Record<string, unknown[]> = {};
  const target = () => {};
  const self: unknown = new Proxy(target, {
    get(_t, prop: string) {
      if (prop === "then") {
        lastFilters = calls;
        const payload = tableResults.get(table) || { data: [], error: null };
        return (resolve: (v: Payload) => void) => resolve(payload);
      }
      return (...args: unknown[]) => {
        calls[prop] = args;
        return self;
      };
    },
  });
  return self;
}

const fakeAdmin = {
  from: (table: string) => fakeQuery(table),
};

// Injeta o fake no module registry do require (tsx/cjs interop).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const Module = require("module") as { prototype: { require: (id: string) => unknown } };
const realRequire = Module.prototype.require;
Module.prototype.require = function patched(id: string) {
  if (id === "@/lib/supabase/admin" || id.endsWith("/supabase/admin")) {
    return { createAdminClient: () => fakeAdmin };
  }
  // eslint-disable-next-line prefer-rest-params
  return realRequire.apply(this, arguments as unknown as [string]);
};

// Import DEPOIS do patch.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const wb = require("../src/lib/billing/wallet-block") as typeof import("../src/lib/billing/wallet-block");

async function main() {
  // -------------------------------------------------------------------------
  console.log("\n1. walletGraceUsd — parse do teto");
  // -------------------------------------------------------------------------
  delete process.env.WALLET_GRACE_USD;
  check("default $2 (sem env)", wb.walletGraceUsd() === 2);
  process.env.WALLET_GRACE_USD = "5";
  check("env=5 → 5", wb.walletGraceUsd() === 5);
  process.env.WALLET_GRACE_USD = "0";
  check("env=0 → 0 (carência OFF)", wb.walletGraceUsd() === 0);
  process.env.WALLET_GRACE_USD = "abc";
  check("env inválida → default 2", wb.walletGraceUsd() === 2);
  process.env.WALLET_GRACE_USD = "-1";
  check("negativa → default 2", wb.walletGraceUsd() === 2);
  process.env.WALLET_GRACE_USD = "  ";
  check("vazia/espaço → default 2", wb.walletGraceUsd() === 2);

  // -------------------------------------------------------------------------
  console.log("\n2. shouldBlockAfterInsufficient — a decisão");
  // -------------------------------------------------------------------------
  delete process.env.WALLET_GRACE_USD;

  // CASO WESLEY: 1ª falha, débito = só o turno de $0.397083 → CARÊNCIA (não bloqueia).
  tableResults.set("usage_records", { data: [{ total_charge_usd: "0.397083" }], error: null });
  let d = await wb.shouldBlockAfterInsufficient("l02PcA5r4TL2umdwpWgn");
  check("CASO WESLEY: $0.40 de débito → NÃO bloqueia", d.block === false);
  check("débito somado certo", Math.abs(d.debtUsd - 0.397083) < 1e-6, String(d.debtUsd));

  // Débito acumulado cruza o teto → bloqueia.
  tableResults.set("usage_records", {
    data: Array.from({ length: 8 }, () => ({ total_charge_usd: 0.3 })), // $2.40
    error: null,
  });
  d = await wb.shouldBlockAfterInsufficient("loc-x");
  check("débito $2.40 ≥ teto $2 → bloqueia", d.block === true);

  // Na borda exata do teto → bloqueia (>=).
  tableResults.set("usage_records", { data: [{ total_charge_usd: 2 }], error: null });
  d = await wb.shouldBlockAfterInsufficient("loc-x");
  check("débito == teto → bloqueia", d.block === true);

  // Carência desligada (0) → bloqueio na 1ª falha SEM consultar débito (H52 puro).
  process.env.WALLET_GRACE_USD = "0";
  tableResults.set("usage_records", { data: [{ total_charge_usd: 0.01 }], error: null });
  d = await wb.shouldBlockAfterInsufficient("loc-x");
  check("carência OFF → bloqueia direto", d.block === true && d.debtUsd === -1);
  delete process.env.WALLET_GRACE_USD;

  // Erro lendo débito → fail-OPEN (não bloqueia; o bug era calar cliente à toa).
  tableResults.set("usage_records", { data: null, error: { message: "boom" } });
  d = await wb.shouldBlockAfterInsufficient("loc-x");
  check("erro de leitura → NÃO bloqueia (fail-open)", d.block === false);

  // Filtros do débito: só o que FALHOU cobrança e segue vivo (30d).
  tableResults.set("usage_records", { data: [], error: null });
  await wb.getUnpaidDebtUsd("loc-f");
  check("filtra charged_to_wallet=false", JSON.stringify(lastFilters.eq || []).length > 0);
  check("exige charge_fail_reason não-nulo", "not" in lastFilters);
  check("janela 30d aplicada", "gte" in lastFilters);

  // -------------------------------------------------------------------------
  console.log("\n3. Cooldown do aviso ao rep (4h)");
  // -------------------------------------------------------------------------
  // Sem aviso recente → manda.
  tableResults.set("sparkbot_messages", { data: [], error: null });
  check("sem aviso nas últimas 4h → manda", (await wb.shouldSendWalletBlockedRepMessage("rep-1")) === true);

  // Aviso há pouco → silêncio (caso Jussara: 6 avisos seguidos).
  tableResults.set("sparkbot_messages", { data: [{ id: "m1" }], error: null });
  check("CASO JUSSARA: aviso recente → NÃO repete", (await wb.shouldSendWalletBlockedRepMessage("rep-1")) === false);

  check("rep vazio → manda (fail-open)", (await wb.shouldSendWalletBlockedRepMessage("")) === true);

  // -------------------------------------------------------------------------
  console.log("\n4. O marcador da copy (contrato do cooldown)");
  // -------------------------------------------------------------------------
  const MARCADOR = "créditos de IA desta conta acabaram";
  check("mensagem do REP carrega o marcador", wb.WALLET_BLOCKED_REP_MESSAGE.includes(MARCADOR));
  check("mensagem ensina o caminho da recarga", /Carteira e Recarga/i.test(wb.WALLET_BLOCKED_REP_MESSAGE));
  check("mensagem ensina recarga automática", /recarga automática/i.test(wb.WALLET_BLOCKED_REP_MESSAGE));
  check("mensagem da DONA ensina o caminho também", /Carteira e Recarga/i.test(wb.WALLET_BLOCKED_OWNER_MESSAGE));
  check(
    "nenhuma menção a GHL/GoHighLevel (naming user-facing)",
    !/GHL|GoHighLevel/i.test(wb.WALLET_BLOCKED_REP_MESSAGE + wb.WALLET_BLOCKED_OWNER_MESSAGE),
  );

  console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : ""}\n`);
  process.exit(fail ? 1 : 0);
}

main();
