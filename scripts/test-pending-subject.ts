/**
 * Testes do "assunto pendente" (H59) — reproduzem a conversa REAL do caso Paulo
 * Abreu (rep +17867717077, 29/07 23:55 → 30/07 00:51), lida de sparkbot_messages.
 *
 * O que se prova aqui: a pessoa que o rep apresenta e que NÃO está no CRM passa
 * a existir pro contexto, e um contato de outra conversa deixa de ocupar o lugar
 * dela (foi assim que a Bianca Amorim apareceu do nada).
 *
 * Rodar: npx tsx scripts/test-pending-subject.ts
 */
import {
  extractPendingSubject,
  renderPendingSubjectBlock,
} from "../src/lib/account-assistant/contact-resolver/pending-subject";
import { getActiveContactContext } from "../src/lib/account-assistant/contact-resolver/active-contact";

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
console.log("\n1. Extração do assunto a partir do que o turno FEZ");
// ---------------------------------------------------------------------------

// Turno real 23:55:42 — o bot buscou "Paulo Abreu" e não achou.
const buscaVazia = extractPendingSubject([
  {
    name: "search_contacts",
    input: { query: "Paulo Abreu" },
    result_preview: '{"contacts":[],"confidence":"low","total":0}',
  },
]);
check("CASO PAULO: busca sem resultado vira assunto", !!buscaVazia);
check("nome capturado", buscaVazia?.name === "Paulo Abreu", buscaVazia?.name);
check("origem = busca vazia", buscaVazia?.via === "search_miss");

// Busca que ACHOU não vira assunto pendente — o H45 assume dali.
check(
  "busca com resultado NÃO vira pendente",
  extractPendingSubject([
    {
      name: "search_contacts",
      input: { query: "Melissa" },
      result_preview: '{"contacts":[{"id":"abc","name":"Melissa"}],"confidence":"high","total":1}',
    },
  ]) === null,
);

// Turno real 00:51:08 — create_contact com nome + telefone.
const criacao = extractPendingSubject([
  { name: "search_contacts", input: { query: "Paulo Abreu" }, result_preview: '{"total":0}' },
  {
    name: "create_contact",
    input: { first_name: "Paulo", last_name: "Abreu", phone: "+1 561-441-2585" },
    result_preview: '{"ok":true}',
  },
]);
check("criação ganha da busca", criacao?.via === "create_attempt");
check("nome montado de first+last", criacao?.name === "Paulo Abreu", criacao?.name);
check("telefone capturado", criacao?.phone === "+1 561-441-2585", criacao?.phone);

// Telefone dentro do termo de busca.
const porTelefone = extractPendingSubject([
  { name: "search_contacts", input: { query: "+1 (561) 441-2585" }, result_preview: '{"total":0}' },
]);
check("termo que é só telefone não vira nome", !porTelefone?.name);
check("…e é lido como telefone", !!porTelefone?.phone, porTelefone?.phone);

check("sem tool_calls → null", extractPendingSubject(undefined) === null);
check("tool_calls não-array → null", extractPendingSubject("nada") === null);
check(
  "tool sem relação → null",
  extractPendingSubject([{ name: "list_calendars", input: {}, result_preview: "{}" }]) === null,
);

// ---------------------------------------------------------------------------
console.log("\n2. O bloco que o modelo lê");
// ---------------------------------------------------------------------------
const bloco = renderPendingSubjectBlock({
  name: "Paulo Abreu",
  phone: "+1 561-441-2585",
  via: "search_miss",
});
check("nomeia a pessoa", bloco.includes("Paulo Abreu"));
check("traz o telefone", bloco.includes("561-441-2585"));
check("proíbe perguntar 'com quem é'", /NUNCA pergunte "com quem é/.test(bloco));
check("proíbe trocar por outra conversa", /outra conversa/.test(bloco));
check("sem assunto → bloco vazio", renderPendingSubjectBlock(null) === "");
check("assunto sem nome nem telefone → vazio", renderPendingSubjectBlock({ via: "search_miss" }) === "");

// ---------------------------------------------------------------------------
console.log("\n3. O vácuo que trouxe a Bianca (regressão)");
// ---------------------------------------------------------------------------
// Sem contact_id nenhum no histórico: só o buffer de recentes de outra conversa.
const supabaseFake = {
  from() {
    const q: Record<string, unknown> = {};
    const self = new Proxy(q, {
      get(_t, prop) {
        if (prop === "then") return undefined;
        return () => self;
      },
    });
    return Object.assign(self, { then: undefined });
  },
} as never;

const recentes = [{ id: "bianca-id", name: "Bianca Amorim" }];

(async () => {
  const semPendente = await getActiveContactContext(supabaseFake, "rep-1", {
    recentContacts: recentes,
  });
  check(
    "sem assunto pendente: comportamento antigo preservado (recente vira foco)",
    semPendente.focus?.id === "bianca-id",
  );

  const comPendente = await getActiveContactContext(supabaseFake, "rep-1", {
    recentContacts: recentes,
    hasPendingSubject: true,
  });
  check(
    "CASO BIANCA: com assunto pendente, contato antigo NÃO vira foco",
    comPendente.focus === null,
    JSON.stringify(comPendente.focus),
  );
  check(
    "…mas segue listado como recente (pista fraca, não foco)",
    comPendente.recent.some((c) => c.id === "bianca-id"),
  );

  console.log(`\n${pass}/${pass + fail} passaram${fail ? ` — ${fail} FALHARAM` : ""}\n`);
  process.exit(fail ? 1 : 0);
})();
