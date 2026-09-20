/**
 * H93 (2026-09-20) — "não deu pra perguntar" ≠ "não existe".
 *
 * Reproduz o caso Gustavo (19/09): com a auth do Spark Leads fora, o resolver
 * devolvia lista vazia e o SparkBot afirmava "Não achei ninguém com esse número
 * no Spark Leads" — oferecendo CRIAR um contato que já existia.
 *
 * Roda sem rede: o GHLClient é um dublê.
 */
import { resolveContact } from "@/lib/account-assistant/contact-resolver/resolve";
import {
  lerCompanyTokenCache,
  gravarCompanyTokenCache,
  invalidateCompanyTokenCache,
} from "@/lib/ghl/company-token-cache";
import { isCompanyTokenNearExpiry } from "@/lib/ghl/auth";
import type { GHLClient } from "@/lib/ghl/client";

let ok = 0, fail = 0;
function check(nome: string, cond: boolean, extra = "") {
  if (cond) { ok++; console.log(`  ✓ ${nome}`); }
  else { fail++; console.log(`  ✗ ${nome}${extra ? ` — ${extra}` : ""}`); }
}

/** Dublê que SEMPRE estoura, como na queda de auth. */
const clienteQuebrado = {
  get: async () => { throw new Error('GHL API 401: {"statusCode":401,"message":"Invalid JWT"}'); },
} as unknown as GHLClient;

/** Dublê saudável que responde sem nenhum contato. */
const clienteVazio = { get: async () => ({ contacts: [] }) } as unknown as GHLClient;

/** Dublê saudável com o contato do caso real. */
const clienteComThais = {
  get: async () => ({
    contacts: [{ id: "abc123XYZ456contact0", firstName: "Thais", lastName: "Chamon", phone: "+13059874088" }],
  }),
} as unknown as GHLClient;

/** Dublê que falha SÓ em algumas variantes (parcial não é apagão). */
function clienteParcial() {
  let n = 0;
  return {
    get: async () => {
      n++;
      if (n === 1) throw new Error("timeout");
      return { contacts: [{ id: "abc123XYZ456contact0", firstName: "Thais", lastName: "Chamon", phone: "+13059874088" }] };
    },
  } as unknown as GHLClient;
}

async function main() {
  console.log("=== 1. Apagão da API não pode virar 'não achei' ===");
  for (const [rotulo, termo] of [["telefone", "+13059874088"], ["nome", "Thais Chamon"]] as const) {
    const r = await resolveContact(clienteQuebrado, "LOC", termo);
    check(`${rotulo}: marca indisponivel`, r.indisponivel === true);
    check(`${rotulo}: guarda o erro`, !!r.erro && r.erro.includes("Invalid JWT"), r.erro);
    check(`${rotulo}: best continua null`, r.best === null);
  }

  console.log("\n=== 2. API saudável e vazia CONTINUA sendo 'não achei' ===");
  for (const [rotulo, termo] of [["telefone", "+13059874088"], ["nome", "Thais Chamon"]] as const) {
    const r = await resolveContact(clienteVazio, "LOC", termo);
    check(`${rotulo}: NÃO marca indisponivel`, r.indisponivel === false);
    check(`${rotulo}: best null (de verdade)`, r.best === null);
  }

  console.log("\n=== 3. Achar contato segue funcionando ===");
  const achou = await resolveContact(clienteComThais, "LOC", "+13059874088");
  check("acha por telefone", achou.best?.name === "Thais Chamon", JSON.stringify(achou.best));
  check("não marca indisponivel", achou.indisponivel === false);
  check("score de E.164 completo = 1", achou.score === 1, String(achou.score));
  const achouNome = await resolveContact(clienteComThais, "LOC", "Thais Chamon");
  check("acha por nome", achouNome.best?.name === "Thais Chamon");

  console.log("\n=== 4. Falha PARCIAL não é apagão (uma variante basta) ===");
  const parcial = await resolveContact(clienteParcial(), "LOC", "Thais Chamon");
  check("não marca indisponivel", parcial.indisponivel === false);
  check("ainda acha o contato", parcial.best?.name === "Thais Chamon");

  console.log("\n=== 5. Cache do company token: só serve token longe de vencer ===");
  const agora = Date.now();
  const emitido = (hAtras: number) => new Date(agora - hAtras * 3600_000).toISOString();

  invalidateCompanyTokenCache();
  gravarCompanyTokenCache("CO", { access_token: "novo", companyId: "CO", expires_in: 86399, updated_at: emitido(1) });
  check("token de 1h atrás (dura 24h) serve do cache",
    lerCompanyTokenCache("CO", isCompanyTokenNearExpiry)?.access_token === "novo");

  invalidateCompanyTokenCache();
  gravarCompanyTokenCache("CO", { access_token: "vencendo", companyId: "CO", expires_in: 86399, updated_at: emitido(23) });
  check("token a <1h de vencer NÃO serve do cache (relê o banco)",
    lerCompanyTokenCache("CO", isCompanyTokenNearExpiry) === null);

  invalidateCompanyTokenCache();
  gravarCompanyTokenCache("CO", { access_token: "morto", companyId: "CO", expires_in: 86399, updated_at: emitido(40) });
  check("token JÁ vencido NÃO serve do cache (é o caso do apagão)",
    lerCompanyTokenCache("CO", isCompanyTokenNearExpiry) === null);

  invalidateCompanyTokenCache();
  gravarCompanyTokenCache("CO", { access_token: "x", companyId: "CO", expires_in: 86399, updated_at: emitido(1) });
  invalidateCompanyTokenCache("CO");
  check("invalidate mata a entrada (é o que o upsert do refresh chama)",
    lerCompanyTokenCache("CO", isCompanyTokenNearExpiry) === null);

  invalidateCompanyTokenCache();
  gravarCompanyTokenCache("CO", { access_token: "semmeta", companyId: "CO", expires_in: null, updated_at: null });
  check("sem metadados de validade → serve (isCompanyTokenNearExpiry é fail-safe false)",
    lerCompanyTokenCache("CO", isCompanyTokenNearExpiry)?.access_token === "semmeta");

  console.log(`\n=== ${ok} passaram, ${fail} falharam ===`);
  process.exit(fail ? 1 : 0);
}
main();
