import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

const BUCKET = "agent-media";
const MAX_SIZE = 25 * 1024 * 1024; // 25 MB
const ALLOWED_PREFIXES = ["image/", "audio/", "video/", "application/pdf"];

function isAllowedMime(mime: string): boolean {
  return ALLOWED_PREFIXES.some((p) => mime.startsWith(p));
}

// GET /api/media?agent_id=xxx  — lista biblioteca de midia do agente
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });

  const agentId = request.nextUrl.searchParams.get("agent_id");
  if (!agentId) return NextResponse.json({ error: "agent_id obrigatorio" }, { status: 400 });

  const supabase = createServerClient();
  const { data } = await supabase
    .from("media_library")
    .select("*")
    .eq("agent_id", agentId)
    .eq("location_id", session.locationId)
    .order("created_at", { ascending: false });

  return NextResponse.json({ items: data || [] });
}

// POST /api/media — upload multipart/form-data (file + agent_id [+ name])
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });

  const contentType = request.headers.get("content-type") || "";
  if (!contentType.includes("multipart/form-data")) {
    return NextResponse.json({ error: "Esperado multipart/form-data" }, { status: 400 });
  }

  const formData = await request.formData();
  const file = formData.get("file") as File | null;
  const agentId = formData.get("agent_id") as string | null;
  const customName = (formData.get("name") as string | null) || file?.name || "arquivo";

  if (!file || !agentId) {
    return NextResponse.json({ error: "file e agent_id obrigatorios" }, { status: 400 });
  }
  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: "Arquivo maior que 25MB" }, { status: 413 });
  }
  if (!isAllowedMime(file.type)) {
    return NextResponse.json({ error: "Tipo de arquivo nao permitido" }, { status: 415 });
  }

  const supabase = createServerClient();

  // Upload para o bucket. Path: {locationId}/{agentId}/{uuid}.{ext}
  const ext = file.name.includes(".") ? file.name.split(".").pop() : "";
  const objectId = crypto.randomUUID();
  const storagePath = `${session.locationId}/${agentId}/${objectId}${ext ? "." + ext : ""}`;

  const buffer = Buffer.from(await file.arrayBuffer());
  const { error: uploadError } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, buffer, { contentType: file.type, upsert: false });

  if (uploadError) {
    return NextResponse.json({ error: uploadError.message }, { status: 500 });
  }

  const { data, error } = await supabase
    .from("media_library")
    .insert({
      agent_id: agentId,
      location_id: session.locationId,
      name: customName,
      storage_path: storagePath,
      mime_type: file.type,
      size_bytes: file.size,
    })
    .select()
    .single();

  if (error) {
    // limpar arquivo orfao
    await supabase.storage.from(BUCKET).remove([storagePath]);
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ item: data }, { status: 201 });
}

// DELETE /api/media?id=xxx&agent_id=yyy
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });

  const id = request.nextUrl.searchParams.get("id");
  const agentId = request.nextUrl.searchParams.get("agent_id");
  if (!id || !agentId) return NextResponse.json({ error: "id e agent_id obrigatorios" }, { status: 400 });

  const supabase = createServerClient();
  const { data: item } = await supabase
    .from("media_library")
    .select("storage_path")
    .eq("id", id)
    .eq("agent_id", agentId)
    .eq("location_id", session.locationId)
    .single();

  if (!item) {
    return NextResponse.json({ error: "Midia nao encontrada" }, { status: 404 });
  }

  await supabase.storage.from(BUCKET).remove([item.storage_path]);
  await supabase
    .from("media_library")
    .delete()
    .eq("id", id)
    .eq("agent_id", agentId)
    .eq("location_id", session.locationId);

  return NextResponse.json({ success: true });
}
