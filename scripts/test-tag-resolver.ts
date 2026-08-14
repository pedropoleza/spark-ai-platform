/**
 * Testes do resolver de tags (H75, 2026-08-12).
 *
 * Reproduz o caso Jussara: a conta tem "no-show" (13 contatos, é a que o
 * workflow escuta) e "no show" (4 contatos, órfã). O LLM escreve qualquer uma
 * das duas — os dois caminhos têm que terminar na MESMA tag do CRM.
 *
 *   npx tsx scripts/test-tag-resolver.ts
 */
import { config } from "dotenv";
import { resolve } from "path";
config({ path: resolve(__dirname, "..", ".env.local") });

import {
  tagKey,
  resolveTagsForWrite,
  resolveTagsForRemoval,
  invalidateTagCache,
} from "../src/lib/ghl/tag-resolver";

let passou = 0;
let falhou = 0;

function check(nome: string, cond: boolean, detalhe = ""): void {
  if (cond) {
    passou++;
    console.log(`  ✅ ${nome}`);
  } else {
    falhou++;
    console.log(`  ❌ ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
  }
}

/** GHLClient falso: catálogo fixo + contagem fixa, sem rede. */
function fakeClient(catalogo: string[], contagens: Record<string, number> = {}, falhar = false) {
  let getCalls = 0;
  let postCalls = 0;
  const client = {
    get: async (path: string) => {
      getCalls++;
      if (falhar) throw new Error("boom");
      if (path.includes("/tags")) return { tags: catalogo.map((n, i) => ({ id: String(i), name: n })) };
      return {};
    },
    post: async (_path: string, body: Record<string, unknown>) => {
      postCalls++;
      const f = (body.filters as Array<{ value: string }>)[0];
      return { total: contagens[f.value] ?? 0 };
    },
  };
  return {
    client: client as never,
    stats: () => ({ getCalls, postCalls }),
  };
}

async function main() {
  console.log("\n=== 1. tagKey: caixa, acento e separador não distinguem tag ===");
  check("no-show == no show", tagKey("no-show") === tagKey("no show"));
  check("No_Show == no show", tagKey("No_Show") === tagKey("no show"));
  check("NO  SHOW == no show", tagKey("NO  SHOW") === tagKey("no show"));
  check("órfão == orfao", tagKey("órfão") === tagKey("orfao"));
  check("'no-show' != 'lost - no show'", tagKey("no-show") !== tagKey("lost - no show"));
  check("tag só de emoji tem chave vazia", tagKey("⭐") === "");

  console.log("\n=== 2. caso Jussara: as duas grafias caem na tag mais usada ===");
  const CATALOGO = ["no show", "no-show", "lost - no show", "anuncio", "agendado pela ia"];
  const CONTAGENS = { "no-show": 13, "no show": 4 };
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const r = await resolveTagsForWrite(client, "loc1", ["no show"]);
    check("LLM escreve 'no show' → grava 'no-show'", r[0].used === "no-show", `usou "${r[0].used}"`);
    check("status = normalized", r[0].status === "normalized", r[0].status);
    check("reporta a grafia perdedora", r[0].alternatives?.includes("no show") === true);
  }
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const r = await resolveTagsForWrite(client, "loc1", ["no-show"]);
    check("LLM escreve 'no-show' → grava 'no-show'", r[0].used === "no-show");
    check("status = exact", r[0].status === "exact", r[0].status);
  }
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const r = await resolveTagsForWrite(client, "loc1", ["No_Show"]);
    check("LLM escreve 'No_Show' → grava 'no-show'", r[0].used === "no-show", `usou "${r[0].used}"`);
  }

  console.log("\n=== 3. 'lost - no show' NÃO é a mesma tag (não pode ser engolida) ===");
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const r = await resolveTagsForWrite(client, "loc1", ["lost - no show"]);
    check("mantém 'lost - no show'", r[0].used === "lost - no show", `usou "${r[0].used}"`);
    check("status = exact", r[0].status === "exact");
  }

  console.log("\n=== 4. tag nova: cria, mas avisa quem é parecida ===");
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const r = await resolveTagsForWrite(client, "loc1", ["no-shw"]);
    check("typo NÃO vira 'no-show' sozinho", r[0].used === "no-shw", `usou "${r[0].used}"`);
    check("status = created", r[0].status === "created", r[0].status);
    check("devolve similar pro bot avisar", (r[0].similar ?? []).includes("no-show"), JSON.stringify(r[0].similar));
  }
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const r = await resolveTagsForWrite(client, "loc1", ["mora perto de boca raton"]);
    check("tag genuinamente nova é criada", r[0].status === "created" && r[0].used === "mora perto de boca raton");
    check("sem similar quando não há parecida", r[0].similar === undefined, JSON.stringify(r[0].similar));
  }

  console.log("\n=== 5. desempate só custa request quando há ambiguidade ===");
  {
    invalidateTagCache();
    const semAmbiguidade = fakeClient(["anuncio", "vip"], {});
    await resolveTagsForWrite(semAmbiguidade.client, "loc2", ["anuncio"]);
    check("1 candidato → zero POST de contagem", semAmbiguidade.stats().postCalls === 0, `${semAmbiguidade.stats().postCalls} posts`);

    invalidateTagCache();
    const comAmbiguidade = fakeClient(CATALOGO, CONTAGENS);
    await resolveTagsForWrite(comAmbiguidade.client, "loc1", ["no show"]);
    check("2 candidatos → conta os dois", comAmbiguidade.stats().postCalls === 2, `${comAmbiguidade.stats().postCalls} posts`);
  }
  {
    invalidateTagCache();
    const f = fakeClient(CATALOGO, CONTAGENS);
    await resolveTagsForWrite(f.client, "loc1", ["anuncio"]);
    await resolveTagsForWrite(f.client, "loc1", ["vip"]);
    await resolveTagsForWrite(f.client, "loc1", ["outra"]);
    check("catálogo é cacheado por location", f.stats().getCalls === 1, `${f.stats().getCalls} gets`);
  }

  console.log("\n=== 6. empate de contagem resolve determinístico ===");
  {
    invalidateTagCache();
    const { client } = fakeClient(["no show", "no-show"], { "no-show": 5, "no show": 5 });
    const r1 = await resolveTagsForWrite(client, "loc3", ["no show"]);
    check("empate → prefere a que foi pedida", r1[0].used === "no show", `usou "${r1[0].used}"`);
    invalidateTagCache();
    const { client: c2 } = fakeClient(["no show", "no-show"], { "no-show": 5, "no show": 5 });
    const r2 = await resolveTagsForWrite(c2, "loc3", ["NO SHOW"]);
    check("empate sem match exato → alfabética estável", r2[0].used === "no show", `usou "${r2[0].used}"`);
  }

  console.log("\n=== 7. fail-open: catálogo fora do ar não bloqueia a tag ===");
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS, true);
    const r = await resolveTagsForWrite(client, "loc4", ["no show"]);
    check("grava a string crua", r[0].used === "no show");
    check("status = unresolved", r[0].status === "unresolved", r[0].status);
  }

  console.log("\n=== 8. remoção tira todas as grafias ===");
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const alvos = await resolveTagsForRemoval(client, "loc1", ["no-show"]);
    check("remove 'no-show' e 'no show'", alvos.includes("no-show") && alvos.includes("no show"), JSON.stringify(alvos));
    check("NÃO remove 'lost - no show'", !alvos.includes("lost - no show"), JSON.stringify(alvos));
  }
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS, true);
    const alvos = await resolveTagsForRemoval(client, "loc5", ["no-show"]);
    check("catálogo fora do ar → remove ao menos a pedida", alvos.length === 1 && alvos[0] === "no-show");
  }

  console.log("\n=== 9. múltiplas tags num call ===");
  {
    invalidateTagCache();
    const { client } = fakeClient(CATALOGO, CONTAGENS);
    const r = await resolveTagsForWrite(client, "loc1", ["No Show", "anuncio", "tag inedita"]);
    check("resolve as 3 na ordem", r.length === 3);
    check("  [0] normaliza", r[0].used === "no-show", r[0].used);
    check("  [1] exata", r[1].used === "anuncio" && r[1].status === "exact");
    check("  [2] cria", r[2].status === "created");
  }

  console.log(`\n${falhou === 0 ? "✅" : "❌"} ${passou}/${passou + falhou} passaram`);
  process.exit(falhou === 0 ? 0 : 1);
}

main();
