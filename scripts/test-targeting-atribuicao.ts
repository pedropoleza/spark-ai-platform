/**
 * Ativação por ORIGEM do contato — "só atender quem veio de anúncio".
 * Pedido do Pedro 2026-08-11, a partir da Marina's Support Account
 * (A62s5EQj1hldOuvBEowv), onde 464 de 500 contatos têm campos de atribuição.
 *
 * Os payloads abaixo são REAIS, copiados do `GET /contacts/{id}` daquela conta.
 *
 *   npx tsx -r tsconfig-paths/register scripts/test-targeting-atribuicao.ts
 */
import { evaluateTargetingSet, normalizeTargeting, valorDeAtribuicao } from "@/lib/queue/targeting";
import type { TargetingRule } from "@/types/agent";

/* ── contatos reais ────────────────────────────────────────────────── */

// Ediléa Luiz — veio de anúncio pago (primeiro E último toque)
const ANUNCIO = {
  tags: [],
  attributionSource: {
    sessionSource: "Paid Social", medium: "instagram", mediumId: "2487084915099616",
    adId: "120253083749810210", utmContent: "2026-03-18 _ M02",
    campaign: "PERPETUO_SET25_MENSAGEM_FRIO_MARINA_V2[LLK_LISTA] [2606][NOVOTESTE]",
    utmCampaign: "PERPETUO_SET25_MENSAGEM_FRIO_MARINA_V2[LLK_LISTA] [2606][NOVOTESTE]",
    campaignId: "120253080981910210", utmMedium: "02_ADV_LLK_AGENDAMENTO",
    adSetId: "120253080982330210", photoUrl: null, postId: null,
  },
  lastAttributionSource: { sessionSource: "Paid Social", medium: "instagram", adId: "120253083749810210" },
};

// Andrea Zimmerman — entrou por anúncio, DEPOIS mandou DM orgânica.
// É o caso que prova por que "veio de anúncio" é pergunta de PRIMEIRO toque.
const ANUNCIO_DEPOIS_ORGANICO = {
  tags: [],
  attributionSource: {
    sessionSource: "Paid Social", medium: "instagram",
    campaign: "PERPETUO_SET25_MENSAGEM_FRIO_MARINA_V2 [2606][NOVOTESTE]",
    campaignId: "120253080982630210", adId: "120253080982650210",
    utmMedium: "02_ADV_NEGOCIOS_FINANÇAS",
  },
  lastAttributionSource: {
    sessionSource: "Social media", medium: "instagram", adId: null, utmContent: null,
  },
};

// Helen — DM orgânica de Instagram, nunca clicou em anúncio
const ORGANICO = {
  tags: ["ia - em atendimento"],
  attributionSource: { sessionSource: "Social media", medium: "instagram", mediumId: "911457528149963" },
  lastAttributionSource: { sessionSource: "Social media", medium: "instagram", mediumId: "911457528149963" },
};

// Contato de conta que NÃO tem atribuição (ex.: lead CTWA criado por upsert —
// é o caso da Horizon/Liberty, onde os 3 campos vêm undefined)
const SEM_ATRIBUICAO = { tags: ["ctwa-lead", "anuncio"] };

/* ── helpers ───────────────────────────────────────────────────────── */

let falhas = 0;
function checa(nome: string, real: boolean, esperado: boolean, porque: string) {
  const ok = real === esperado;
  console.log(`  ${ok ? "✅" : "❌"} ${nome} → ${real ? "ATENDE" : "ignora"} — ${porque}`);
  if (!ok) falhas++;
}

function avalia(rules: TargetingRule[], contact: unknown, opts = {}): boolean {
  const set = normalizeTargeting(rules);
  if (!set) return true;
  return evaluateTargetingSet(set, contact as never, [], opts);
}

const r = (p: Partial<TargetingRule>): TargetingRule =>
  ({ id: "r1", type: "attribution", ...p }) as TargetingRule;

/* ── 1. a receita recomendada ──────────────────────────────────────── */
console.log('1) "veio de anúncio" — sessionSource contém "Paid"\n');
{
  const regra = [r({ attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "Paid" })];
  checa("lead de anúncio", avalia(regra, ANUNCIO), true, "sessionSource=Paid Social");
  checa("anúncio + DM orgânica depois", avalia(regra, ANUNCIO_DEPOIS_ORGANICO), true, "primeiro toque foi o anúncio");
  checa("DM orgânica pura", avalia(regra, ORGANICO), false, "sessionSource=Social media");
  checa("conta sem atribuição", avalia(regra, SEM_ATRIBUICAO), false, "sem origem = não entra por acidente");
}

/* ── 2. o atalho que o Pedro pediu ─────────────────────────────────── */
console.log('\n2) "qualquer coisa de origem preenchida" — campo any + is_set\n');
{
  const regra = [r({ attribution_field: "any", attribution_operator: "is_set" })];
  checa("lead de anúncio", avalia(regra, ANUNCIO), true, "tem campanha, adId, utm...");
  checa("DM orgânica", avalia(regra, ORGANICO), true, "⚠️ TAMBÉM casa — orgânico tem sessionSource");
  checa("conta sem atribuição", avalia(regra, SEM_ATRIBUICAO), false, "nada preenchido");
}
console.log("   → por isso a receita 1 é a recomendada: 'is_set' não separa pago de orgânico.");

/* ── 3. recorte por campanha ───────────────────────────────────────── */
console.log("\n3) recorte por campanha específica\n");
{
  const porNome = [r({ attribution_field: "campaign", attribution_operator: "contains", attribution_value: "LLK_LISTA" })];
  checa("campanha LLK_LISTA", avalia(porNome, ANUNCIO), true, "casa o nome da campanha");
  checa("outra campanha", avalia(porNome, ANUNCIO_DEPOIS_ORGANICO), false, "campanha diferente");

  const porId = [r({ attribution_field: "campaignId", attribution_operator: "eq", attribution_value: "120253080981910210" })];
  checa("por campaignId exato", avalia(porId, ANUNCIO), true, "id bate");
  checa("id de outra campanha", avalia(porId, ANUNCIO_DEPOIS_ORGANICO), false, "id diferente");
}

/* ── 4. primeiro toque × último toque ──────────────────────────────── */
console.log("\n4) primeiro toque × último toque (o caso da Andrea)\n");
{
  const primeiro = [r({ attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "Paid", attribution_scope: "first" })];
  const ultimo = [r({ attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "Paid", attribution_scope: "last" })];
  checa("primeiro toque (default)", avalia(primeiro, ANUNCIO_DEPOIS_ORGANICO), true, "ela ENTROU pelo anúncio");
  checa("último toque", avalia(ultimo, ANUNCIO_DEPOIS_ORGANICO), false, "a última interação foi orgânica");
  console.log("   → default é 'first': quem veio de anúncio não deixa de ter vindo.");
}

/* ── 5. combinando com o resto (o if/else do pedido) ───────────────── */
console.log("\n5) 'respondeu uma mensagem E veio de anúncio'\n");
{
  const composta = {
    version: 2 as const,
    match: "all" as const,
    groups: [{
      id: "g1",
      match: "all" as const,
      rules: [
        { id: "m", type: "message", message_operator: "contains", message_value: "informação" } as TargetingRule,
        r({ id: "a", attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "Paid" }),
      ],
    }],
  };
  const comMsg = (c: unknown) =>
    evaluateTargetingSet(normalizeTargeting(composta)!, c as never, [], { messageText: "quero informação" });
  checa("anúncio + frase certa", comMsg(ANUNCIO), true, "as duas condições batem");
  checa("orgânico + frase certa", comMsg(ORGANICO), false, "a frase bate mas não veio de anúncio");
}

/* ── 6. bordas ─────────────────────────────────────────────────────── */
console.log("\n6) bordas\n");
{
  checa("operador ausente = regra ignorada",
    avalia([r({ attribution_field: "sessionSource" })], ORGANICO), true,
    "folha malformada é NEUTRA, não silencia o agente");
  checa("valor vazio = regra ignorada",
    avalia([r({ attribution_field: "sessionSource", attribution_operator: "contains", attribution_value: "  " })], ORGANICO), true,
    "needle vazio casaria qualquer um — vira neutra");
  checa("not_set pega quem não tem origem",
    avalia([r({ attribution_field: "any", attribution_operator: "not_set" })], SEM_ATRIBUICAO), true,
    "útil pra separar quem entrou por fora do anúncio");
  checa("campo nulo conta como ausente",
    avalia([r({ attribution_field: "adId", attribution_operator: "is_set" })], ANUNCIO_DEPOIS_ORGANICO), true,
    "adId preenchido no primeiro toque");
}

/* ── 7. extração ───────────────────────────────────────────────────── */
console.log("\n7) leitura dos campos\n");
{
  const ok1 = valorDeAtribuicao(ANUNCIO as never, "campaign") === "PERPETUO_SET25_MENSAGEM_FRIO_MARINA_V2[LLK_LISTA] [2606][NOVOTESTE]";
  checa("campo específico", ok1, true, "lê campaign direto");
  const any = valorDeAtribuicao(ANUNCIO as never, "any");
  checa("any concatena e ignora null", any.includes("Paid Social") && any.includes("120253083749810210") && !any.includes("null"), true, `${any.length} chars`);
  checa("contato sem atribuição = vazio", valorDeAtribuicao(SEM_ATRIBUICAO as never, "any") === "", true, "string vazia");
}

console.log(`\n${falhas === 0 ? "✅ Todos os cenários OK" : `❌ ${falhas} falha(s)`}`);
process.exit(falhas === 0 ? 0 : 1);
