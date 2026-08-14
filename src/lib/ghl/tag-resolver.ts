/**
 * Resolução de nome de tag contra o catálogo REAL da location (H75, 2026-08-12).
 *
 * Fix bug observado em prod 2026-08-12 (caso Jussara/Ibrahim): o nome da tag que
 * vai pro Spark Leads era a string CRUA que o LLM escreveu no turno, e o CRM cria
 * a tag se ela não existir. Resultado: a conta acumulou "no show" E "no-show" pro
 * MESMO conceito, o workflow de no-show escuta só a segunda, e os 4 leads que
 * levaram a primeira nunca entraram na sequência — com o bot respondendo
 * "Tag no show adicionada ✅" nas quatro. Confirmação certa, efeito nenhum.
 *
 * Regra: caixa, acento e separador NÃO distinguem tag. "No-Show" == "no show" ==
 * "no_show". Quando a conta já tem a tag escrita de outro jeito, a gente grava a
 * QUE JÁ EXISTE em vez de criar uma irmã órfã.
 *
 * O que este módulo deliberadamente NÃO faz: casar por semelhança. "no-shw" não
 * vira "no-show" sozinho — tag errada dispara automação errada, que é pior que o
 * silêncio de hoje. Near-miss volta em `similar` pro bot AVISAR o rep.
 */

import type { GHLClient } from "./client";
import { listLocationTags } from "./operations";
import { deburr, tokenSim } from "@/lib/account-assistant/contact-resolver/normalize";

const TTL_MS = 10 * 60 * 1000;
/**
 * Acima disto, duas tags são "parecidas o bastante pra AVISAR" (nunca pra
 * aplicar). Calibrado no alvo real — typo de 1 letra em tag curta:
 * "no-shw"×"no-show" dá 0,857, então 0,88 deixava passar em silêncio
 * justamente o caso que este campo existe pra pegar. Falso-positivo aqui custa
 * uma frase a mais do bot; falso-negativo custa uma automação que não dispara.
 */
const NEAR_MISS_MIN = 0.8;

interface CatalogEntry {
  names: string[];
  fetched_at: number;
}

const catalogCache = new Map<string, CatalogEntry>();
const countCache = new Map<string, { total: number; fetched_at: number }>();

/**
 * Chave canônica de tag: deburr (acento + caixa) e qualquer run de separador
 * vira um espaço. "No-Show" / "no_show" / "NO  SHOW" → "no show".
 *
 * Chave VAZIA (tag só de emoji/pontuação) desliga o casamento por chave — sem
 * isso, "⭐" e "🔥" colidiriam em "" e viraram a mesma tag.
 */
export function tagKey(s: string): string {
  return deburr(s).replace(/[^a-z0-9]+/gu, " ").trim();
}

export type TagResolutionStatus =
  /** A tag pedida existe exatamente assim na conta. */
  | "exact"
  /** A conta já tinha a MESMA tag escrita de outro jeito — usamos a dela. */
  | "normalized"
  /** Não existe nada equivalente: vai criar tag nova no CRM. */
  | "created"
  /** Não deu pra ler o catálogo — grava crua (comportamento pré-H75). */
  | "unresolved";

export interface TagResolution {
  /** O que o modelo (ou a action) escreveu. */
  asked: string;
  /** O que vai de fato pro CRM. */
  used: string;
  status: TagResolutionStatus;
  /** Outras grafias da MESMA tag que existem na conta (perderam o desempate). */
  alternatives?: string[];
  /** Tags parecidas que já existem, quando estamos criando uma nova. */
  similar?: string[];
}

/** Tags da location, com cache de 10min e stale-while-revalidate. */
async function getCatalog(client: GHLClient, locationId: string): Promise<string[] | null> {
  const cached = catalogCache.get(locationId);
  if (cached && Date.now() - cached.fetched_at < TTL_MS) return cached.names;

  try {
    const res = await listLocationTags(client, locationId);
    const names = (res.tags || []).map((t) => t.name).filter((n): n is string => Boolean(n));
    catalogCache.set(locationId, { names, fetched_at: Date.now() });
    return names;
  } catch (err) {
    if (cached) {
      console.warn(
        `[tag-resolver] catálogo de ${locationId} falhou, usando stale:`,
        err instanceof Error ? err.message : err,
      );
      return cached.names;
    }
    console.warn(
      `[tag-resolver] catálogo de ${locationId} indisponível:`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Quantos contatos têm esta tag. Só é chamado no desempate (2+ grafias da mesma
 * tag na conta), que é raro — não vale pagar isso no caminho comum.
 */
async function countContactsWithTag(
  client: GHLClient,
  locationId: string,
  tag: string,
): Promise<number> {
  const k = `${locationId}:${tag}`;
  const cached = countCache.get(k);
  if (cached && Date.now() - cached.fetched_at < TTL_MS) return cached.total;

  try {
    const res = await client.post<{ total?: number }>("/contacts/search", {
      locationId,
      pageLimit: 1,
      filters: [{ field: "tags", operator: "eq", value: tag }],
    });
    const total = typeof res.total === "number" ? res.total : 0;
    countCache.set(k, { total, fetched_at: Date.now() });
    return total;
  } catch (err) {
    console.warn(
      `[tag-resolver] contagem da tag "${tag}" falhou:`,
      err instanceof Error ? err.message : err,
    );
    return 0;
  }
}

/**
 * Desempate entre grafias da mesma tag: vence a MAIS USADA na conta. Não é
 * prova de qual delas a automação escuta (a API não expõe trigger de workflow),
 * mas é o único sinal disponível — e a grafia órfã, por definição, é a que
 * quase ninguém tem. Empate → prefere a que o modelo pediu, senão alfabética
 * (determinístico: o mesmo pedido resolve sempre igual).
 */
async function pickAmong(
  client: GHLClient,
  locationId: string,
  candidates: string[],
  asked: string,
): Promise<{ used: string; alternatives: string[] }> {
  const counts = await Promise.all(
    candidates.map(async (c) => ({ name: c, total: await countContactsWithTag(client, locationId, c) })),
  );
  counts.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.name === asked) return -1;
    if (b.name === asked) return 1;
    return a.name.localeCompare(b.name);
  });
  return { used: counts[0].name, alternatives: counts.slice(1).map((c) => c.name) };
}

/**
 * Resolve os nomes que devem ser GRAVADOS. Fail-open em qualquer erro: sem
 * catálogo, devolve a string crua com status `unresolved` — o resolver nunca
 * impede a tag de ser aplicada.
 */
export async function resolveTagsForWrite(
  client: GHLClient,
  locationId: string,
  asked: string[],
): Promise<TagResolution[]> {
  const catalog = await getCatalog(client, locationId);
  if (!catalog) return asked.map((a) => ({ asked: a, used: a, status: "unresolved" as const }));

  const out: TagResolution[] = [];
  for (const a of asked) {
    const k = tagKey(a);
    const sameKey = k ? catalog.filter((n) => tagKey(n) === k) : [];
    const candidates = sameKey.length ? sameKey : catalog.filter((n) => n === a);

    if (candidates.length === 0) {
      const similar = k
        ? catalog
            .map((n) => ({ n, s: tokenSim(k, tagKey(n)) }))
            .filter((x) => x.s >= NEAR_MISS_MIN)
            .sort((x, y) => y.s - x.s)
            .slice(0, 3)
            .map((x) => x.n)
        : [];
      out.push({ asked: a, used: a, status: "created", ...(similar.length ? { similar } : {}) });
      continue;
    }

    if (candidates.length === 1) {
      const used = candidates[0];
      out.push({ asked: a, used, status: used === a ? "exact" : "normalized" });
      continue;
    }

    const { used, alternatives } = await pickAmong(client, locationId, candidates, a);
    out.push({
      asked: a,
      used,
      status: used === a ? "exact" : "normalized",
      alternatives,
    });
  }
  return out;
}

/**
 * Grafias a REMOVER quando o rep pede pra tirar uma tag: todas as variantes da
 * mesma chave. Quem diz "tira o no-show" quer o conceito fora do contato, não a
 * grafia — deixar a irmã pra trás recria o bug pelo avesso.
 */
export async function resolveTagsForRemoval(
  client: GHLClient,
  locationId: string,
  asked: string[],
): Promise<string[]> {
  const catalog = await getCatalog(client, locationId);
  if (!catalog) return asked;

  const out = new Set<string>();
  for (const a of asked) {
    out.add(a);
    const k = tagKey(a);
    if (!k) continue;
    for (const n of catalog) if (tagKey(n) === k) out.add(n);
  }
  return [...out];
}

/** Usado em testes e depois de mexer nas tags da conta à mão. */
export function invalidateTagCache(locationId?: string): void {
  if (!locationId) {
    catalogCache.clear();
    countCache.clear();
    return;
  }
  catalogCache.delete(locationId);
  for (const k of countCache.keys()) if (k.startsWith(`${locationId}:`)) countCache.delete(k);
}
