/**
 * Testes da normalização E.164 BR-aware (fix caso Marina/Bianca 2026-07-01,
 * trazido do working tree em 2026-08-05).
 *
 * O que se protege aqui: o telefone que a IA coleta de um lead BRASILEIRO numa
 * sub-account configurada em fuso americano não pode virar um número inválido —
 * era isso que deixava o contato recém-qualificado sem entrega de WhatsApp/SMS.
 *
 * A premissa da heurística (11 dígitos com "9" no 3º = celular BR) é que NÃO
 * EXISTE area code americano com 9 no meio: os 80 códigos N9X estão reservados
 * pela NANP pra uma futura expansão do plano. Os casos "regressão US" abaixo
 * travam justamente o outro lado — número americano não pode virar brasileiro.
 *
 * Rodar: npx tsx scripts/test-phone-normalization.ts
 */
import { normalizePhone, inferCountryFromTimezone } from "../src/lib/account-assistant/identity";

let pass = 0,
  fail = 0;
function ok(nome: string, cond: boolean, detalhe?: string) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${nome}`);
  } else {
    fail++;
    console.error(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}
const eq = (nome: string, got: string, want: string) => ok(`${nome} → ${want}`, got === want, `veio "${got}"`);

// ── 1. O caso real: lead BR numa location americana ─────────────────────────
console.log("\n1. celular BR reconhecido pelo próprio número (location em fuso US)");
eq("caso Marina: 31999232306 (BH)", normalizePhone("31999232306", "US"), "+5531999232306");
eq("São Paulo DDD 11", normalizePhone("11987654321", "US"), "+5511987654321");
eq("Campinas DDD 19", normalizePhone("19987654321", "US"), "+5519987654321");
eq("Rio DDD 21", normalizePhone("21998765432", "US"), "+5521998765432");
eq("Salvador DDD 71", normalizePhone("71999887766", "US"), "+5571999887766");
eq("com máscara brasileira", normalizePhone("(31) 99923-2306", "US"), "+5531999232306");

// ── 2. Regressão US: número americano NÃO pode virar brasileiro ─────────────
console.log("\n2. regressão US — o outro lado da heurística");
eq("US 10 dígitos (Flórida)", normalizePhone("5615551234", "US"), "+15615551234");
eq("US 10 dígitos com máscara", normalizePhone("(786) 771-7077", "US"), "+17867717077");
eq("US 10 díg com 9 no 3º (área 919 Raleigh)", normalizePhone("9195551234", "US"), "+19195551234");
ok(
  "nenhum US de 10 dígitos vira +55, mesmo com 9 na 3ª casa",
  ["9195551234", "9295551234", "3195551234", "7195551234"].every(
    (n) => normalizePhone(n, "US") === `+1${n}`,
  ),
);
eq("já em E.164 US é preservado", normalizePhone("+15615551234", "US"), "+15615551234");
eq("já em E.164 BR é preservado", normalizePhone("+5531999232306", "US"), "+5531999232306");
eq("12+ dígitos assume country code", normalizePhone("5531999232306", "US"), "+5531999232306");

// ── 3. Fixo brasileiro (8 díg sem o 9) segue dependendo do país da location ──
console.log("\n3. fixo BR (10 dígitos, sem o 9º dígito) — sem sinal próprio, usa o default");
eq("fixo BH numa location BR", normalizePhone("3133334444", "BR"), "+553133334444");
eq("fixo BH numa location US cai no default (limitação conhecida)", normalizePhone("3133334444", "US"), "+13133334444");

// ── 4. País default vindo do fuso da location ───────────────────────────────
console.log("\n4. inferCountryFromTimezone");
ok("America/Sao_Paulo → BR", inferCountryFromTimezone("America/Sao_Paulo") === "BR");
ok("America/Fortaleza → BR", inferCountryFromTimezone("America/Fortaleza") === "BR");
ok("America/New_York → US", inferCountryFromTimezone("America/New_York") === "US");
ok("America/Chicago → US", inferCountryFromTimezone("America/Chicago") === "US");
ok("fuso nulo → US (default conservador)", inferCountryFromTimezone(null) === "US");

// ── 5. Entradas degeneradas não podem explodir ──────────────────────────────
console.log("\n5. entradas degeneradas");
eq("vazio volta vazio", normalizePhone("", "US"), "");
eq("sem dígito volta cru", normalizePhone("liga pra mim", "US"), "liga pra mim");
eq("curto demais não vira BR", normalizePhone("99999", "US"), "+99999");

console.log(`\n${fail === 0 ? "✅" : "❌"} ${pass}/${pass + fail} passaram`);
process.exit(fail === 0 ? 0 : 1);
