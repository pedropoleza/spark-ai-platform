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

// Provider config: Voyage AI primary (voyage-3-large, 1024 dims, free tier
// alto, qualidade superior multilingual). OpenAI text-embedding-3-small (1536)
// só é fallback se VOYAGE_API_KEY não estiver configurado E migration de DB
// foi revertida pra 1536. Atualmente schema é 1024 (migration 00039).
const VOYAGE_KEY = process.env.VOYAGE_API_KEY;

async function embedQuery(text: string): Promise<number[]> {
  if (VOYAGE_KEY) {
    const res = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: { Authorization: `Bearer ${VOYAGE_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        input: text,
        model: "voyage-3-large",
        // input_type=query indica busca (vs document) — Voyage otimiza assimetria query↔doc
        input_type: "query",
      }),
    });
    if (!res.ok) {
      throw new Error(`Voyage API ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }
    const data = await res.json() as { data: { embedding: number[] }[] };
    return data.data[0].embedding;
  }
  // Fallback OpenAI
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("Nem VOYAGE_API_KEY nem OPENAI_API_KEY configurados");
  const openai = new OpenAI({ apiKey });
  const res = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text,
  });
  return res.data[0].embedding;
}

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
      "Consulta uma das DUAS knowledge bases (kb). Estrutura da operação: National Life (carrier que emite a apólice) → Five Rings Financial (MGA/IMO) → Brazillionaires (sub-agência dos brasileiros). KBs disponíveis (parameter `kb`):\n\n  • kb='national_life_group' — regras TÉCNICAS DA CARRIER NLG. Use pra: produtos NLG (FlexLife, PeakLife, Term, RapidProtect, Annuities), rate classes UW, build chart, FN country tier, riders (LIBR, ABR, Alzheimer, Fertility, Overloan), compliance (NY Reg 187, illustration regs), commission policy, replacement/1035, processo NLG (eApp/iGo/ForeSight).\n\n  • kb='agency_brazillionaires' — portal de TREINAMENTO/OPERAÇÃO da sub-agência Brazillionaires (Five Rings). Use pra: emergency contact list, Napkin Presentations, Como Convidar, fingerprint, agendar prova, scripts de venda, Power Monday, IUL University, Dicas da Rita (Inforce, UW, Term Conversion, Owner Change), educação financeira, modelo de negócios, eventos, processo no dia-a-dia da agência.\n\nEXEMPLOS:\n- 'qual cap do FlexLife em NY?' → kb='national_life_group'\n- 'como funciona Emergency Contact List?' → kb='agency_brazillionaires'\n- 'cliente diabético, dá Standard?' → kb='national_life_group'\n- 'como Napkin Presentation?' → kb='agency_brazillionaires'\n- 'dicas da Rita pra Inforce?' → kb='agency_brazillionaires'\n- 'como agendar prova de licença?' → kb='agency_brazillionaires'\n- 'quais visas válidos pra FN brasileiro?' → kb='national_life_group'\n\nEm dúvida ou pergunta híbrida, chame a tool DUAS VEZES (uma com cada kb). NUNCA invente resposta sem chamar esta tool.",
    risk: "safe",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "Pergunta em linguagem natural — quanto mais específica, melhor o retrieval.",
        },
        kb: {
          type: "string",
          enum: ["national_life_group", "agency_brazillionaires"],
          description: "OBRIGATÓRIO. Escolha qual KB consultar baseado na pergunta. 'national_life_group' = regras técnicas NLG (carrier). 'agency_brazillionaires' = portal de treinamento Brazillionaires/Five Rings (processo, scripts, dicas operacionais). Veja exemplos na description da tool.",
        },
        category_hint: {
          type: "string",
          enum: [
            "overview", "product", "rider", "underwriting",
            "compliance", "process", "pitfall", "resource",
            "commission", "workflow",
          ],
          description: "OPCIONAL. SÓ use pra kb='national_life_group' (esquema de categorias bem definido: 'underwriting' rate classes/build/medical, 'product' produtos, 'rider' ABR/LIBR, 'commission' 1035, 'compliance' Reg 187/illustration). Pra kb='agency_brazillionaires' NÃO PASSE category_hint — deixa similarity ranking decidir, pq o esquema de categorias do portal é diferente.",
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
      required: ["question", "kb"],
    },
  },
  handler: async (ctx, args) => {
    const question = String(args.question || "").trim();
    if (!question) {
      return { status: "error", message: "question vazia", retryable: false };
    }
    // Aceita `kb` (novo, preferred) ou `carrier` (backwards-compat).
    // Default agency_brazillionaires (cobre maioria das queries operacionais).
    const carrier = String(args.kb || args.carrier || "agency_brazillionaires");

    // Filtro de enabled_kbs (admin pode desligar uma das KBs em prod).
    // Default: ambas habilitadas (sem ctx.enabledKbs setado = sem restrição).
    if (ctx.enabledKbs && ctx.enabledKbs.length > 0 && !ctx.enabledKbs.includes(carrier)) {
      return {
        status: "error",
        message:
          `KB '${carrier}' está desabilitada nesta location. ` +
          `KBs habilitadas: ${ctx.enabledKbs.join(", ")}. ` +
          `Use uma dessas ou diga ao rep que essa info não está disponível.`,
        retryable: false,
      };
    }
    const categoryHint = args.category_hint ? String(args.category_hint) : null;
    const state = args.state ? String(args.state).toUpperCase() : null;
    const topK = Math.min(Math.max(Number(args.top_k) || 5, 1), 8);

    // 1. Embed da pergunta. Voyage primary (1024 dims voyage-3-large) com
    //    input_type=query pra otimizar similarity contra documents (que foram
    //    embedded com input_type=document via ingest-carrier-kb.ts).
    //    Fundamental que provider+modelo bata com o usado na ingestão.
    let queryEmbedding: number[];
    try {
      queryEmbedding = await embedQuery(question);
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
      // 0.4 — ajustado de 0.5 pra reduzir falso-negativos em queries
      // laterais (chunks existem mas similarity <0.5 por divergência de
      // termo entre query do rep e título/corpo do chunk).
      // Defesa anti-alucinação acontece DOIS níveis:
      //   1. SQL: chunks com similarity <0.4 nem chegam ao LLM.
      //   2. Bot prompt: instruído a checar similarity score, hedging
      //      em chunks com similarity 0.4-0.6 ("pelo que tenho..."),
      //      recusar com confiança apenas se 0+ chunks ou top<0.4.
      // Adversarials A1-A4 passam com 0.4 (chunks "DL12 commission"/
      // "2030 cap" simplesmente não existem; similarity será ~0.2-0.3).
      p_min_similarity: 0.4,
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
          // Fix Track 3 + Track 9 (review 2026-05-05): mensagem mentia "≥ 0.6"
          // mas SQL gate é 0.4. Bot repassava "threshold 0.6" pro rep como
          // se fosse fonte de verdade — sintoma de over-confidence em zona
          // cinza. Agora bate com SQL.
          message:
            "Nenhum chunk com similarity ≥ 0.4 encontrado pra essa pergunta. Diga ao rep: 'não tenho info confiável sobre isso na KB. Sugestões: (1) Sales Desk NLG 800-906-3310, (2) Underwriting Guide Cat 62797 no portal, (3) seu wholesaler/IMO'.",
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
