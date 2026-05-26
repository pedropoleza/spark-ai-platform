/**
 * Recuperação RAG da carrier_knowledge para AGENTES DE LEAD (Plataforma Modular
 * — KB parte B). Quando o agente tem `enabled_kbs` (ex: national_life_group),
 * embedamos a mensagem do lead e buscamos os chunks mais relevantes pra injetar
 * no prompt — mesmo corpus/infra que o SparkBot usa (search_carrier_knowledge).
 *
 * Mesmo embedding provider/modelo da ingestão (Voyage voyage-3-large 1024d,
 * fallback OpenAI text-embedding-3-small) — tem que bater pra similarity valer.
 * Tudo fail-safe: qualquer erro → retorna [] e o agente segue sem o template.
 */
import { createAdminClient } from "@/lib/supabase/admin";

const VOYAGE_KEY = process.env.VOYAGE_API_KEY;
const VALID_CARRIERS = new Set(["national_life_group", "agency_brazillionaires"]);

// O corpus é vector(1024) (Voyage voyage-3-large, migration 00039). NÃO há
// fallback compatível: text-embedding-3-small é 1536d → o operador <=> da RPC
// estoura "different vector dimensions". Antes isso falhava SILENCIOSO (catch →
// []) sem alerta. Agora loga ERROR alto pra ficar visível se a key sumir.
async function embedQuery(text: string): Promise<number[]> {
  if (!VOYAGE_KEY) {
    console.error("[carrier-retrieval] VOYAGE_API_KEY ausente — RAG de carrier desativado (corpus 1024d, sem fallback compatível).");
    throw new Error("voyage_key_missing");
  }
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: { Authorization: `Bearer ${VOYAGE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ input: text, model: "voyage-3-large", input_type: "query" }),
  });
  if (!res.ok) throw new Error(`Voyage ${res.status}`);
  const data = (await res.json()) as { data: { embedding: number[] }[] };
  return data.data[0].embedding;
}

export interface CarrierChunk {
  carrier: string;
  title: string;
  content: string;
  similarity: number;
}

/**
 * Busca os top-K chunks por carrier habilitado. Não lança — devolve [] em falha.
 */
export async function retrieveCarrierKnowledge(
  carriers: string[],
  query: string,
  topKPerCarrier = 3,
): Promise<CarrierChunk[]> {
  const valid = Array.from(new Set((carriers || []).filter((c) => VALID_CARRIERS.has(c))));
  const q = (query || "").trim();
  if (valid.length === 0 || q.length < 3) return [];

  let embedding: number[];
  try {
    embedding = await embedQuery(q.slice(0, 2000));
  } catch (err) {
    console.warn("[carrier-retrieval] embed falhou:", err instanceof Error ? err.message : err);
    return [];
  }

  const supabase = createAdminClient();
  const out: CarrierChunk[] = [];
  await Promise.all(
    valid.map(async (carrier) => {
      try {
        const { data, error } = await supabase.rpc("search_carrier_knowledge", {
          p_query_embedding: JSON.stringify(embedding),
          p_carrier: carrier,
          p_category: null,
          p_state: null,
          p_top_k: Math.min(Math.max(topKPerCarrier, 1), 6),
          p_min_similarity: 0.4,
        });
        if (error || !data) return;
        for (const r of data as { title: string; content: string; similarity: number }[]) {
          out.push({ carrier, title: r.title, content: r.content, similarity: Number(r.similarity ?? 0) });
        }
      } catch {
        /* pula essa carrier */
      }
    }),
  );

  // Maior similarity primeiro (melhor relevância no topo do prompt).
  return out.sort((a, b) => b.similarity - a.similarity);
}

/** Rótulo amigável da carrier pra exibir no título do chunk no prompt. */
export function carrierLabel(carrier: string): string {
  if (carrier === "national_life_group") return "National Life";
  if (carrier === "agency_brazillionaires") return "Brazillionaires";
  return carrier;
}
