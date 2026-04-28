import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createAdminClient } from "@/lib/supabase/admin";
import { errorResponse, unauthorized } from "@/lib/utils/api";

/**
 * GET /api/admin/carrier-kb?carrier=national_life_group
 *
 * Lista todos os chunks da KB de uma carrier (sem embedding pra não inflar
 * payload). Usado por Pedro pra inspecionar o que foi ingerido sem precisar
 * abrir o Supabase Studio.
 *
 * Resposta agrupada por categoria pra UI poder renderizar tree direto.
 */
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session?.isAdmin) return unauthorized();

  const url = new URL(request.url);
  const carrier = url.searchParams.get("carrier") || "national_life_group";

  const supabase = createAdminClient();
  const { data: rawData, error } = await supabase
    .from("carrier_knowledge")
    .select(
      "id, category, subcategory, slug, title, priority, " +
      "product_refs, state_specific, tags, applies_to_companies, " +
      "source, source_doc_cat, source_url, last_verified_at, " +
      "embedded_at, content_hash, created_at, updated_at, " +
      "created_by_user_id, last_modified_by_user_id, verified_by_user_id"
    )
    .eq("carrier", carrier)
    .order("category", { ascending: true })
    .order("subcategory", { ascending: true, nullsFirst: false })
    .order("title", { ascending: true });

  if (error) return errorResponse(error.message, 500, "db_error");

  // Cast pq Supabase types não foram gerados pra carrier_knowledge ainda.
  interface ChunkRow {
    id: string;
    category: string;
    subcategory: string | null;
    slug: string;
    title: string;
    priority: "always" | "on_demand";
    last_verified_at: string | null;
    embedded_at: string | null;
    [k: string]: unknown;
  }
  const data = (rawData || []) as unknown as ChunkRow[];

  // Métricas rápidas pra dashboard.
  const total = data.length;
  const tier1 = data.filter((c) => c.priority === "always").length;
  const tier2 = total - tier1;
  const now = Date.now();
  const STALE_DAYS = 180;
  const stale = data.filter((c) => {
    if (!c.last_verified_at) return true; // chunks sem validação são stale
    const ageDays = (now - new Date(c.last_verified_at).getTime()) / (1000 * 60 * 60 * 24);
    return ageDays > STALE_DAYS;
  }).length;
  const noEmbedding = data.filter((c) => !c.embedded_at).length;

  // Agrupa por category[:subcategory] pra UI tree.
  const grouped: Record<string, ChunkRow[]> = {};
  for (const row of data) {
    const key = row.subcategory ? `${row.category}:${row.subcategory}` : row.category;
    (grouped[key] ||= []).push(row);
  }

  return NextResponse.json({
    carrier,
    metrics: { total, tier1, tier2, stale, no_embedding: noEmbedding },
    by_category: grouped,
  });
}
