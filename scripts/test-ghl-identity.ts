/**
 * H98 — identidade do Spark Leads no loader + verificação no servidor.
 *
 * Contexto: o Spark Leads parou de gravar o `refreshedToken` no localStorage; a
 * sessão foi pro Vuex (state.user.user.firebaseToken) e as claims viraram
 * camelCase. O loader roda em TODA página do Spark Leads de TODOS os clientes —
 * um erro de sintaxe aqui derruba SparkBot e controles da frota inteira. Por isso
 * a parte 1 checa o script EXATAMENTE como é servido.
 *
 *   npx tsx scripts/test-ghl-identity.ts
 */
import { writeFileSync } from "fs";
import { execSync } from "child_process";
import vm from "vm";
import { GET } from "../src/app/embed/sparkbot/loader/route";
import { normalizeClaims, tokenMatchesRequest, tokenCoversLocation } from "../src/lib/auth/ghl-idtoken";

let ok = 0, fail = 0;
const t = (nome: string, cond: boolean, det = "") => {
  if (cond) { ok++; console.log(`  ✅ ${nome}`); } else { fail++; console.log(`  ❌ ${nome}${det ? "  → " + det : ""}`); }
};
const b64u = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: unknown) => `${b64u({ alg: "RS256", typ: "JWT" })}.${b64u(payload)}.assinatura-fake`;

async function main() {
  console.log("\n1. O script servido é JavaScript válido");
  const res = await GET();
  const script = await res.text();
  writeFileSync("/tmp/_loader_servido.js", script);
  let sintaxeOk = true;
  try { execSync("node --check /tmp/_loader_servido.js", { stdio: "pipe" }); } catch (e) { sintaxeOk = false; console.log(String((e as { stderr?: Buffer }).stderr || e)); }
  t("node --check passa no script inteiro", sintaxeOk);
  t("resolvedor vem ANTES dos dois módulos", script.indexOf("__sparkGhlIdentity = function") < script.indexOf("[Sparkbot] boot()") &&
    script.indexOf("__sparkGhlIdentity = function") < script.indexOf("módulo de controles iniciado"));

  // Extrai só o IIFE do resolvedor pra exercitar isolado.
  const ini = script.indexOf("(function () {\n  if (window.__sparkGhlIdentity) return;");
  const fim = script.indexOf("})();", ini) + "})();".length;
  const resolver = script.slice(ini, fim);
  t("consegui isolar o resolvedor", ini >= 0 && fim > ini);

  function rodar(cenario: { app?: unknown; ls?: Record<string, string> }) {
    const logs: string[] = [];
    const ls = cenario.ls || {};
    const appEl = cenario.app ? { __vue_app__: cenario.app } : null;
    const sandbox: Record<string, unknown> = {
      console: { log: (m: string) => logs.push(m), warn: (m: string) => logs.push(m) },
      localStorage: { getItem: (k: string) => (k in ls ? ls[k] : null) },
      document: { getElementById: (id: string) => (id === "app" ? appEl : null), querySelector: () => null },
      atob: (b: string) => Buffer.from(b, "base64").toString("binary"),
      escape, decodeURIComponent, JSON,
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(resolver, sandbox);
    const r = (sandbox.window as { __sparkGhlIdentity: () => Record<string, unknown> }).__sparkGhlIdentity();
    return { r, logs };
  }
  const vuex = (user: unknown, company?: unknown) => ({ config: { globalProperties: { $store: { state: { user: { user }, company: { company } } } } } });

  console.log("\n2. Navegador simulado");
  const tokNovo = jwt({ iss: "default-platform@highlevel-backend.iam.gserviceaccount.com", claims: { userId: "U-novo", region: "us", locations: { "LOC1": true } } });
  {
    const { r, logs } = rodar({ app: vuex({ userId: "U-novo", firebaseToken: tokNovo }, { id: "C-1" }) });
    t("Spark Leads ATUAL (Vuex): acha user", r.userId === "U-novo", JSON.stringify(r));
    t("Spark Leads ATUAL: company vem do state.company", r.companyId === "C-1");
    t("Spark Leads ATUAL: manda o firebaseToken", r.idToken === tokNovo);
    t("Spark Leads ATUAL: fonte = vuex", r.source === "vuex");
    t("log mostra a fonte e NÃO vaza token", logs.some((l) => l.includes("fonte=vuex")) && !logs.some((l) => l.includes(tokNovo)));
  }
  {
    const tok = jwt({ claims: { userId: "U-2", companyId: "C-2" } });
    const { r } = rodar({ app: vuex({ firebaseToken: tok }, null) });
    t("company dentro do token (camelCase) também serve", r.userId === "U-2" && r.companyId === "C-2", JSON.stringify(r));
  }
  {
    const tokVelho = jwt({ claims: { user_id: "U-velho", company_id: "C-velho" } });
    const { r } = rodar({ ls: { refreshedToken: JSON.stringify(tokVelho) } });
    t("sessão ANTIGA (localStorage, token entre aspas) continua funcionando", r.userId === "U-velho" && r.companyId === "C-velho", JSON.stringify(r));
    t("sessão antiga: manda o token SEM aspas, como antes", r.idToken === tokVelho);
    t("sessão antiga: fonte = localStorage:refreshedToken", r.source === "localStorage:refreshedToken");
  }
  {
    const { r } = rodar({ ls: { refreshedToken: JSON.stringify({ refreshedToken: { claims: { user_id: "U-env", company_id: "C-env" } } }) } });
    t("envelope antigo { refreshedToken: { claims } } ainda lido", r.userId === "U-env" && r.companyId === "C-env");
  }
  {
    const tokVelho = jwt({ claims: { user_id: "U-velho", company_id: "C-velho" } });
    const { r } = rodar({ app: vuex({ userId: "U-novo", firebaseToken: tokNovo }, { id: "C-1" }), ls: { refreshedToken: tokVelho } });
    t("com os dois, o Vuex (atual) ganha do token velho", r.source === "vuex" && r.userId === "U-novo");
  }
  {
    const { r } = rodar({ app: vuex({}, null) });
    t("store sem usuário carregado ainda → none (o tick tenta de novo)", r.source === "none" && r.userId === null);
  }
  {
    const { r } = rodar({});
    t("sem nada → none, sem exceção", r.source === "none");
  }
  {
    const { r } = rodar({ app: { config: null }, ls: { refreshedToken: "lixo" } });
    t("app quebrado + localStorage lixo → none, sem exceção", r.source === "none");
  }

  console.log("\n3. Servidor: normalização e regra de aceite");
  const novo = normalizeClaims({ iss: "x", claims: { userId: "U1", locations: { LOC1: true } } })!;
  t("camelCase vira user_id", novo.user_id === "U1");
  t("chaves do token ficam registradas (só nomes)", (novo._keys || []).includes("userId"));
  const velho = normalizeClaims({ claims: { user_id: "U1", company_id: "C1", role: "admin", type: "agency" } })!;
  t("formato antigo continua igual", velho.user_id === "U1" && velho.company_id === "C1" && velho.role === "admin");
  t("location por objeto", tokenCoversLocation(novo, "LOC1") && !tokenCoversLocation(novo, "LOC2"));
  t("location por lista", tokenCoversLocation({ locations: ["A", "B"] }, "B"));
  t("aceita: user + company", tokenMatchesRequest(velho, { userId: "U1", companyId: "C1" }));
  t("aceita: user + location listada no token (sem company)", tokenMatchesRequest(novo, { userId: "U1", companyId: "C-qualquer", locationId: "LOC1" }));
  t("RECUSA: user diferente, mesmo com location", !tokenMatchesRequest(novo, { userId: "U-outro", companyId: "C1", locationId: "LOC1" }));
  t("RECUSA: company errada e location fora do token", !tokenMatchesRequest(novo, { userId: "U1", companyId: "C-errada", locationId: "LOC2" }));
  t("RECUSA: company errada sem location informada", !tokenMatchesRequest(velho, { userId: "U1", companyId: "C-errada" }));
  t("RECUSA: token sem user nenhum", !tokenMatchesRequest(normalizeClaims({ claims: { companyId: "C1" } })!, { userId: "", companyId: "C1" }));

  console.log(`\n${"=".repeat(60)}\nRESULTADO: ${ok} ok, ${fail} falhas\n${"=".repeat(60)}`);
  process.exit(fail ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
