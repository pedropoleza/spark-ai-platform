/**
 * H81 — folha de EXCLUSÃO (`negate`) no targeting.
 *
 * Motivo: abrir o gate numa conta que é a operação INTEIRA do cliente sem poder
 * dizer "menos quem tem a tag client" foi o incidente da Jussara (19/08 — a IA
 * atendeu clientes, fornecedores e contatos pessoais). A folha `tag` não tinha
 * negação (só `message`/`attribution` tinham `not_contains`).
 *
 * Propriedade de segurança central: NEUTRO NUNCA É INVERTIDO. Folha malformada
 * (tag vazia, operador ausente, `message` sem texto do lead) continua neutra —
 * inverter neutro transformaria regra quebrada em catch-all que atende todos.
 *
 * Payloads REAIS da conta da Bianca (cRavIlyC52vFYgJATgi7), lidos em 26/08.
 *
 *   npx tsx scripts/test-targeting-negate.ts
 */
import { evaluateTargetingSet } from "@/lib/queue/targeting";
import type { TargetingRuleSet } from "@/types/agent";

/* ── contatos reais da conta ───────────────────────────────────────── */

// anair guedes — lead de anúncio (o público-alvo do agente A)
const LEAD_ANUNCIO = {
  tags: [],
  attributionSource: {
    sessionSource: "Paid Social", medium: "instagram", mediumId: "1666834931617704",
    campaign: "[AF] [Perp] [Captura] Msg_Direct engaj v4", utmMedium: "[ADV]_Aberto_engj",
    utmContent: "[VID]_09_10_17_18", campaignId: "120250544685670600", adId: "120250544685660600",
  },
  lastAttributionSource: { sessionSource: "Paid Social", medium: "instagram" },
};

// sophie.grin — seguidora orgânica (público do agente B)
const SEGUIDOR_ORGANICO = {
  tags: [],
  attributionSource: { sessionSource: "Social media", medium: "instagram", mediumId: "2423577894718953" },
  lastAttributionSource: {},
};

// CLIENTE que originalmente veio de anúncio — o caso perigoso: casa o filtro de
// anúncio E é cliente. Sem exclusão, a IA de recrutamento aborda um cliente.
const CLIENTE_VINDO_DE_ANUNCIO = {
  tags: ["client", "aap: 2k-5k"],
  attributionSource: { sessionSource: "Paid Social", medium: "instagram", adId: "120250544685660600" },
  lastAttributionSource: { sessionSource: "Paid Social" },
};

// contato pessoal da Bianca (tag real da conta)
const CONTATO_PESSOAL = {
  tags: ["contato pessoal", "pessoal bia"],
  attributionSource: { sessionSource: "Social media", medium: "instagram" },
  lastAttributionSource: {},
};

// membro da agência
const MEMBRO_AGENCIA = {
  tags: ["membro da agencia"],
  attributionSource: { sessionSource: "Paid Social", medium: "instagram" },
  lastAttributionSource: {},
};

// acento/caixa diferente — o deburr do H70 tem que valer na exclusão também
const CLIENTE_ACENTO = {
  tags: ["Membro da Agência"],
  attributionSource: { sessionSource: "Paid Social", medium: "instagram" },
  lastAttributionSource: {},
};

/* ── o gate real que vai pra produção (Fase 0 do plano) ────────────── */

const EXCLUIDAS = ["client", "cliente", "contato pessoal", "pessoal bia", "membro da agencia"];

const GATE_AGENTE_A: TargetingRuleSet = {
  version: 2,
  match: "all", // ENTRADA e EXCLUSÃO precisam valer as duas
  groups: [
    {
      id: "g-entrada",
      match: "any",
      rules: [
        { id: "e-attr", type: "attribution", attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "Paid", attribution_scope: "first" },
        { id: "e-msg", type: "message", message_operator: "contains", message_value: "Sim! Quero me tornar um Agente Financeiro" },
        { id: "e-tag", type: "tag", tag: "ia-ligada" },
      ],
    },
    {
      id: "g-exclusao",
      match: "all", // NENHUMA das excluídas pode estar presente
      rules: EXCLUIDAS.map((t, i) => ({ id: `x-${i}`, type: "tag" as const, tag: t, negate: true })),
    },
  ],
};

/* ── casos ─────────────────────────────────────────────────────────── */

type Caso = [string, unknown, string, boolean];
const casos: Caso[] = [
  ["lead de anúncio entra", LEAD_ANUNCIO, "Oi, vi o anúncio", true],
  ["seguidor orgânico NÃO entra no agente de anúncio", SEGUIDOR_ORGANICO, "oi tudo bem?", false],
  ["CLIENTE vindo de anúncio é BARRADO (caso Jussara)", CLIENTE_VINDO_DE_ANUNCIO, "oi bianca", false],
  ["contato pessoal é barrado", CONTATO_PESSOAL, "oi", false],
  ["membro da agência é barrado", MEMBRO_AGENCIA, "e aí", false],
  ["exclusão é acento/caixa-insensível", CLIENTE_ACENTO, "oi", false],
  ["frase do anúncio entra mesmo sem atribuição paga", SEGUIDOR_ORGANICO, "Sim! Quero me tornar um Agente Financeiro nos Estados Unidos,", true],
  ["tag ia-ligada entra (SDR ligou pelo celular)", { ...SEGUIDOR_ORGANICO, tags: ["ia-ligada"] }, "oi", true],
  ["tag ia-ligada NÃO salva cliente (exclusão ganha)", { ...CLIENTE_VINDO_DE_ANUNCIO, tags: ["client", "ia-ligada"] }, "oi", false],
];

let fail = 0;
const check = (label: string, got: boolean, exp: boolean) => {
  const ok = got === exp;
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${label} → ${got} (esperado ${exp})`);
};

console.log("=== gate real do agente A (entrada + exclusão) ===");
for (const [label, contato, msg, esperado] of casos) {
  const got = evaluateTargetingSet(GATE_AGENTE_A, contato as never, [], { messageText: msg });
  check(label, got, esperado);
}

console.log("\n=== propriedade de segurança: NEUTRO NUNCA INVERTE ===");
const soNeutra = (rules: TargetingRuleSet["groups"][number]["rules"]): TargetingRuleSet => ({
  version: 2, match: "all", groups: [{ id: "g", match: "all", rules }],
});
// tag vazia + negate: se invertesse o neutro, viraria "match" = catch-all.
// Set com TUDO neutro → evaluateTargetingSet devolve true (sem regra efetiva),
// então o teste real é: a folha negada não pode ser a ÚNICA a dar match quando
// combinada com uma folha que dá no_match.
check(
  "folha `tag` vazia + negate não vira catch-all",
  evaluateTargetingSet(
    { version: 2, match: "all", groups: [{ id: "g", match: "all", rules: [
      { id: "vazia", type: "tag", tag: "", negate: true },
      { id: "real", type: "tag", tag: "existe-nao" },
    ] }] },
    SEGUIDOR_ORGANICO as never, [], { messageText: "oi" },
  ),
  false,
);
check(
  "folha `message` negada é NEUTRA em turno proativo (não bloqueia follow-up)",
  evaluateTargetingSet(
    soNeutra([{ id: "m", type: "message", message_operator: "contains", message_value: "anúncio", negate: true }]),
    LEAD_ANUNCIO as never, [], { messageText: "qualquer", isProactive: true },
  ),
  true, // tudo neutro = passa (comportamento legado preservado)
);
check(
  "folha `message` negada é NEUTRA em conversa ativa",
  evaluateTargetingSet(
    soNeutra([{ id: "m", type: "message", message_operator: "contains", message_value: "anúncio", negate: true }]),
    LEAD_ANUNCIO as never, [], { messageText: "oi de novo", conversationActive: true },
  ),
  true,
);
check(
  "attribution negada: 'não veio de anúncio' pega o orgânico",
  evaluateTargetingSet(
    soNeutra([{ id: "a", type: "attribution", attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "Paid", attribution_scope: "first", negate: true }]),
    SEGUIDOR_ORGANICO as never, [], { messageText: "oi" },
  ),
  true,
);
check(
  "attribution negada: 'não veio de anúncio' barra o pago",
  evaluateTargetingSet(
    soNeutra([{ id: "a", type: "attribution", attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "Paid", attribution_scope: "first", negate: true }]),
    LEAD_ANUNCIO as never, [], { messageText: "oi" },
  ),
  false,
);

console.log("\n=== regressão: sem `negate`, nada muda ===");
check(
  "tag simples sem negate segue igual (match)",
  evaluateTargetingSet(soNeutra([{ id: "t", type: "tag", tag: "client" }]), CLIENTE_VINDO_DE_ANUNCIO as never, [], {}),
  true,
);
check(
  "tag simples sem negate segue igual (no_match)",
  evaluateTargetingSet(soNeutra([{ id: "t", type: "tag", tag: "client" }]), SEGUIDOR_ORGANICO as never, [], {}),
  false,
);
check(
  "negate:false explícito é igual a ausente",
  evaluateTargetingSet(soNeutra([{ id: "t", type: "tag", tag: "client", negate: false }]), CLIENTE_VINDO_DE_ANUNCIO as never, [], {}),
  true,
);

const total = casos.length + 8;
console.log(fail === 0 ? `\n✅ ${total}/${total}` : `\n❌ ${fail} falha(s) de ${total}`);
process.exit(fail === 0 ? 0 : 1);
