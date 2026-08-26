/**
 * H82 — o gatilho por TAG lido do `ContactUpdate`.
 *
 * Medição que motivou (conta da Bianca, 26/08, teste controlado): adicionar uma
 * tag NÃO gera `ContactTagUpdate` — gera `ContactUpdate` com o contato inteiro.
 * O handler de tag existia desde a F27.D e nunca rodou porque escutava um
 * evento que o app não assina.
 *
 *   npx tsx scripts/test-tag-trigger-contactupdate.ts
 */
import { extractContactTagsEvents } from "@/lib/account-assistant/proactive/event-router";

let fail = 0;
const check = (nome: string, ok: boolean, extra = "") => {
  if (!ok) fail++;
  console.log(`${ok ? "✅" : "❌"} ${nome}${extra ? ` — ${extra}` : ""}`);
};

// Payload real do ContactUpdate da conta da Bianca (shape observado em 26/08).
const BASE = { locationId: "cRavIlyC52vFYgJATgi7", contactId: "p4REvKuE9kcPIe35Bikh" };

const comTagsString = { ...BASE, tags: ["novo seguidor", "qualificada"] };
const ev1 = extractContactTagsEvents(comTagsString);
check("extrai 1 evento por tag (array de string)", ev1.length === 2, ev1.map((e) => e.key).join(", "));
check("kind é tag_added", ev1.every((e) => e.kind === "tag_added"));
check("carrega location e contato", ev1.every((e) => e.locationId === BASE.locationId && e.contactId === BASE.contactId));

const comTagsObjeto = { ...BASE, tags: [{ name: "ia-ligada" }, { name: "client" }] };
const ev2 = extractContactTagsEvents(comTagsObjeto);
check("aceita array de objeto {name}", ev2.length === 2 && ev2[0].key === "ia-ligada");

check("sem tags → nenhum evento", extractContactTagsEvents({ ...BASE, tags: [] }).length === 0);
check("sem o campo tags → nenhum evento", extractContactTagsEvents({ ...BASE }).length === 0);
check("sem contactId → nenhum evento", extractContactTagsEvents({ locationId: "L", tags: ["x"] }).length === 0);
check("sem locationId → nenhum evento", extractContactTagsEvents({ contactId: "C", tags: ["x"] }).length === 0);

const duplicadas = extractContactTagsEvents({ ...BASE, tags: ["Novo Seguidor", "novo seguidor", "NOVO SEGUIDOR"] });
check("dedup case-insensitive", duplicadas.length === 1, `${duplicadas.length} evento(s)`);

const vazias = extractContactTagsEvents({ ...BASE, tags: ["", "   ", "ia-ligada"] });
check("ignora tag vazia/espaço", vazias.length === 1 && vazias[0].key === "ia-ligada");

const muitas = extractContactTagsEvents({ ...BASE, tags: Array.from({ length: 60 }, (_, i) => `tag-${i}`) });
check("cap de 30 tags", muitas.length === 30, `${muitas.length}`);

check("preserva a grafia original (o matcher compara com a regra)",
  extractContactTagsEvents({ ...BASE, tags: ["Novo Seguidor"] })[0].key === "Novo Seguidor");

const total = 12;
console.log(fail === 0 ? `\n✅ ${total}/${total}` : `\n❌ ${fail} falha(s) de ${total}`);
process.exit(fail === 0 ? 0 : 1);
