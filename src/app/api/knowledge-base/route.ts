import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";

// GET /api/knowledge-base?agent_id=xxx
export async function GET(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const agentId = request.nextUrl.searchParams.get("agent_id");
  if (!agentId) {
    return NextResponse.json({ error: "agent_id obrigatorio" }, { status: 400 });
  }

  const supabase = createServerClient();
  const { data } = await supabase
    .from("knowledge_base")
    .select("*")
    .eq("agent_id", agentId)
    .eq("location_id", session.locationId)
    .order("created_at", { ascending: false });

  return NextResponse.json({ items: data || [] });
}

// POST /api/knowledge-base — adicionar item
export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const contentType = request.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    // Upload de arquivo
    const formData = await request.formData();
    const file = formData.get("file") as File | null;
    const agentId = formData.get("agent_id") as string;
    const title = formData.get("title") as string || file?.name || "Documento";

    if (!file || !agentId) {
      return NextResponse.json({ error: "file e agent_id obrigatorios" }, { status: 400 });
    }

    // Extrair texto do arquivo
    let content = "";
    const buffer = Buffer.from(await file.arrayBuffer());

    if (file.name.endsWith(".pdf")) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const pdfParse = require("pdf-parse");
        const pdfData = await pdfParse(buffer);
        content = pdfData.text;
      } catch (error) {
        console.error("Erro ao parsear PDF:", error);
        content = "[Erro ao extrair texto do PDF]";
      }
    } else if (file.name.endsWith(".txt") || file.name.endsWith(".csv") || file.name.endsWith(".md")) {
      content = buffer.toString("utf-8");
    } else if (file.name.endsWith(".doc") || file.name.endsWith(".docx")) {
      content = buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").trim();
    } else {
      content = buffer.toString("utf-8");
    }

    // Truncar conteudo muito grande
    const maxChars = 50000;
    if (content.length > maxChars) {
      content = content.substring(0, maxChars) + "\n[...conteudo truncado]";
    }

    const tokenEstimate = Math.ceil(content.length / 4);

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("knowledge_base")
      .insert({
        agent_id: agentId,
        location_id: session.locationId,
        type: "file",
        title,
        content,
        file_name: file.name,
        token_count: tokenEstimate,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ item: data }, { status: 201 });
  } else {
    // Texto ou URL
    const body = await request.json();
    const { agent_id, type, title, content } = body;

    if (!agent_id || !type || !title) {
      return NextResponse.json({ error: "Campos obrigatorios faltando" }, { status: 400 });
    }

    let finalContent = content || "";

    // Se for URL, tentar buscar conteudo
    if (type === "url" && content) {
      try {
        const res = await fetch(content, { signal: AbortSignal.timeout(10000) });
        if (res.ok) {
          const html = await res.text();
          // Extrair texto basico do HTML
          finalContent = html
            .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, " ")
            .replace(/\s+/g, " ")
            .trim()
            .substring(0, 50000);
        }
      } catch {
        // Se falhar, manter a URL como conteudo
      }
    }

    const tokenEstimate = Math.ceil(finalContent.length / 4);

    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("knowledge_base")
      .insert({
        agent_id,
        location_id: session.locationId,
        type,
        title,
        content: finalContent,
        file_url: type === "url" ? content : null,
        token_count: tokenEstimate,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ item: data }, { status: 201 });
  }
}

// DELETE /api/knowledge-base?id=xxx
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id obrigatorio" }, { status: 400 });
  }

  const supabase = createServerClient();
  await supabase
    .from("knowledge_base")
    .delete()
    .eq("id", id)
    .eq("location_id", session.locationId);

  return NextResponse.json({ success: true });
}
