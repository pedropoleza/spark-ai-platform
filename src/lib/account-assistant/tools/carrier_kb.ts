/**
 * Tool de consulta à carrier knowledge base via RAG (pgvector).
 *
 * O Sparkbot invoca esta tool quando o rep pergunta sobre produtos,
 * underwriting, riders, compliance ou processo de uma carrier (NLG).
 *
 * Fluxo:
 *   1. embed da pergunta via OpenAI text-embedding-3-small (1536 dim)
 *   2. similarity search via função SQL search_carrier_knowledge
 *   3. retorna chunks com similarity ≥ 0.6 (gate anti-alucinação)
 *
 * Calibração de incerteza (regra central — ver _planning/nlg-kb-implementation-plan.md §7.5):
 *   - similarity < 0.6 → 0 chunks → bot deve dizer "sem info confiável"
 *   - last_verified_at injetado em todo chunk → bot decide alertar staleness >180d
 *   - source_doc_cat propagado → bot pode citar fonte
 *   - state_specific propagado → bot identifica regras NY-only etc
 *
 * Não usa ToolContext.rep — KB é cross-tenant. Mas implementa o contrato
 * ToolEntry pro registry agregar com as outras tools normalmente.
 */

import OpenAI from "openai";
import type { ToolEntry } from "./types";
import { createAdminClient } from "@/lib/supabase/admin";

interface SearchRow {
  id: string;
  category: string;
  subcategory: string | null;
  title: string;
  content: string;
  similarity: number;
  source_doc_cat: string | null;
  last_verified_at: string | null;
  state_specific: string[] | null;
  tags: string[] | null;
}

const queryCarrierKnowledge: ToolEntry = {
  def: {
    name: "query_carrier_knowledge",
    description:
      "Consulta a base de conhecimento de uma carrier (seguradora) sobre produtos, underwriting, riders, compliance, processo de aplicação. USE SEMPRE que o rep perguntar algo específico de uma carrier — ex: 'qual o cap do FlexLife em NY?', 'como diabetes Type 2 é underwritten?', 'qual o waiting period do LIBR?', 'pode vender em NY?', 'foreign national brasileiro qual o face máximo?'. Default carrier='national_life_group'. NUNCA invente resposta sem chamar esta tool.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Pergunta em linguagem natural — quanto mais específica, melhor o retrieval.",
        },
        carrier: {
          type: "string",
          enum: ["national_life_group"],
          default: "national_life_group",
          description: "Por enquanto só NLG.",
        },
        category_hint: {
          type: "string",
          enum: [
            "overview", "product", "rider", "underwriting",
            "compliance", "process", "pitfall", "resource",
            "commission", "workflow",
          ],
          description: "Restringe busca a uma categoria. Use 'underwriting' pra perguntas sobre rate classes/build chart/medical, 'product' pra detalhes de produto, 'rider' pra ABR/LIBR/etc, 'commission' pra 1035/comissão.",
        },
        state: {
          type: "string",
          description: "Sigla do estado (ex: 'NY', 'CA', 'TX') — restringe a chunks state-specific. Use SEMPRE que o rep mencionar estado do cliente.",
        },
        top_k: {
          type: "number",
          default: 5,
          description: "Quantos chunks retornar (max 8).",
        },
      },
      required: ["question"],
    },
  },
  handler: async (_ctx, args) => {
    const question = String(args.question || "").trim();
    if (!question) {
      return { status: "error", message: "question vazia", retryable: false };
    }
    const carrier = String(args.carrier || "national_life_group");
    const categoryHint = args.category_hint ? String(args.category_hint) : null;
    const state = args.state ? String(args.state).toUpperCase() : null;
    const topK = Math.min(Math.max(Number(args.top_k) || 5, 1), 8);

    // 1. Embed da pergunta. Mesmo modelo que ingestion script — fundamental
    //    pra similarity ser comparável.
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      return { status: "error", message: "OPENAI_API_KEY não configurado no servidor", retryable: false };
    }
    const openai = new OpenAI({ apiKey });

    let queryEmbedding: number[];
    try {
      const res = await openai.embeddings.create({
        model: "text-embedding-3-small",
        input: question,
      });
      queryEmbedding = res.data[0].embedding;
    } catch (err) {
      return {
        status: "error",
        message: `embedding falhou: ${err instanceof Error ? err.message : String(err)}`,
        retryable: true,
      };
    }

    // 2. Similarity search via função SQL. Threshold 0.6 é gate anti-alucinação.
    //    pgvector aceita o array JSON serializado como string.
    const supabase = createAdminClient();
    const { data, error } = await supabase.rpc("search_carrier_knowledge", {
      p_query_embedding: JSON.stringify(queryEmbedding),
      p_carrier: carrier,
      p_category: categoryHint,
      p_state: state,
      p_top_k: topK,
      p_min_similarity: 0.6,
    });

    if (error) {
      return { status: "error", message: `search_carrier_knowledge: ${error.message}`, retryable: true };
    }

    const rows = (data || []) as SearchRow[];

    // 3. Sem chunks → resposta explícita "sem info" (ver §7.5 do plano).
    if (rows.length === 0) {
      return {
        status: "ok",
        data: {
          chunks: [],
          carrier,
          message:
            "Nenhum chunk com similarity ≥ 0.6 encontrado. Diga ao rep: 'não tenho info confiável sobre isso. Sugestões: (1) Sales Desk NLG 800-906-3310, (2) Underwriting Guide Cat 62797 no portal, (3) seu wholesaler/IMO'.",
        },
      };
    }

    // 4. Resposta estruturada — bot tem que decidir comportamento por chunk
    //    (staleness, state_specific, source).
    const now = Date.now();
    const STALE_DAYS = 180;
    const chunks = rows.map((c) => {
      const verifiedAt = c.last_verified_at ? new Date(c.last_verified_at).getTime() : null;
      const ageDays = verifiedAt ? Math.floor((now - verifiedAt) / (1000 * 60 * 60 * 24)) : null;
      const isStale = ageDays !== null && ageDays > STALE_DAYS;

      return {
        title: c.title,
        category: c.category,
        subcategory: c.subcategory,
        content: c.content,
        similarity: Number((c.similarity ?? 0).toFixed(3)),
        source_doc_cat: c.source_doc_cat,
        last_verified_at: c.last_verified_at,
        verified_age_days: ageDays,
        is_stale: isStale,
        state_specific: c.state_specific,
        state_query: state,
        state_match: state && c.state_specific
          ? c.state_specific.includes(state)
            ? "exact"
            : "mismatch"
          : "none",
        tags: c.tags,
      };
    });

    return {
      status: "ok",
      data: {
        carrier,
        chunks,
        guidance:
          "Cite a fonte ao responder (ex: 'fonte: NLG Cat 62797'). Se algum chunk tem is_stale=true, alerte o rep que valores podem ter mudado. Se state_match='mismatch', mencione que a regra é de outro estado. Use o conteúdo dos chunks pra responder, NÃO invente complementos.",
      },
    };
  },
};

export const CARRIER_KB_TOOLS: ToolEntry[] = [queryCarrierKnowledge];
