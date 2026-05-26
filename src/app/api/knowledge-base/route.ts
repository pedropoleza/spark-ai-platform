import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import { createServerClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertLocationInCompany } from "@/lib/agent-platform/entitlement-admin";

// Visão (OCR de imagem) e parse de PDF podem demorar.
export const maxDuration = 60;

/**
 * Extrai texto de um arquivo subido pra base de conhecimento. Suporta:
 *  - PDF (pdf-parse), Excel .xlsx/.xls (xlsx → CSV por aba), Word .docx (mammoth),
 *  - txt/csv/md (utf-8), imagens .png/.jpg/.webp (OpenAI vision → texto/descrição).
 * Falha graciosa: devolve um marcador em vez de quebrar o upload.
 */
async function extractFileContent(file: File, buffer: Buffer): Promise<string> {
  const name = (file.name || "").toLowerCase();
  const type = file.type || "";
  try {
    if (name.endsWith(".pdf")) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const pdfParse = require("pdf-parse");
      const d = await pdfParse(buffer);
      return d.text || "";
    }
    if (name.endsWith(".xlsx") || name.endsWith(".xls")) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const XLSX = require("xlsx");
      const wb = XLSX.read(buffer, { type: "buffer" });
      return (wb.SheetNames as string[])
        .map((sn) => `## Planilha: ${sn}\n${XLSX.utils.sheet_to_csv(wb.Sheets[sn])}`)
        .join("\n\n");
    }
    if (name.endsWith(".docx")) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mammoth = require("mammoth");
      const r = await mammoth.extractRawText({ buffer });
      return r.value || "";
    }
    if (/\.(png|jpe?g|webp|gif)$/.test(name) || type.startsWith("image/")) {
      const OpenAI = (await import("openai")).default;
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 45000 });
      const dataUrl = `data:${type || "image/png"};base64,${buffer.toString("base64")}`;
      const comp = await openai.chat.completions.create({
        model: "gpt-4.1-mini",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Extraia TODO o texto legível desta imagem e descreva o conteúdo de forma útil pra um agente de seguros (tabelas, números, nomes, valores). Responda em português, só o conteúdo — sem comentários seus." },
              { type: "image_url", image_url: { url: dataUrl } },
            ],
          },
        ],
        max_tokens: 1500,
      });
      return comp.choices[0]?.message?.content || "";
    }
    if (name.endsWith(".txt") || name.endsWith(".csv") || name.endsWith(".md")) {
      return buffer.toString("utf-8");
    }
    if (name.endsWith(".doc")) {
      // .doc legado (binário) — extração crua (melhor pedir .docx/.pdf).
      return buffer.toString("utf-8").replace(/[^\x20-\x7E\n\r\t]/g, " ").replace(/\s+/g, " ").trim();
    }
    return buffer.toString("utf-8");
  } catch (err) {
    console.error("[knowledge-base] extração falhou:", file.name, err instanceof Error ? err.message : err);
    return `[Não consegui extrair o texto de ${file.name}. Tenta converter pra PDF ou colar o texto.]`;
  }
}

/**
 * Resolve location_id efetivo pra um agent. Sparkbot (account_assistant) é
 * global — sua KB pertence à location do agent_id, não à location do admin
 * logado. Outros agents têm KB scoped à location do admin (segurança
 * multi-tenant).
 *
 * Fix audit 2026-05-03: antes filtrava sempre por session.locationId. Pra
 * Sparkbot, admin de OUTRA location veria KB vazia mesmo o agent existindo.
 */
async function resolveKbLocation(agentId: string, sessionLocationId: string, sessionCompanyId: string): Promise<string> {
  const admin = createAdminClient();
  const { data: agent } = await admin
    .from("agents")
    .select("type, location_id")
    .eq("id", agentId)
    .maybeSingle();
  // SparkBot (account_assistant) é global pro admin — mas SÓ devolve a location
  // dele se for da MESMA company do caller (anti cross-tenant; fix ultra-review
  // 2026-05-26). Senão cai no escopo da própria location (não vaza outra conta).
  if (agent?.type === "account_assistant" && agent.location_id) {
    if (await assertLocationInCompany(agent.location_id, sessionCompanyId)) {
      return agent.location_id;
    }
  }
  return sessionLocationId;
}

// Limite de upload: evita OOM/abuso (e custo de visão em imagens enormes).
const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15 MB

/** Bloqueia SSRF: só http(s) público; rejeita localhost/IPs privados/link-local (metadata). */
function isSafeHttpUrl(raw: string): boolean {
  let u: URL;
  try { u = new URL(raw); } catch { return false; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return false;
  const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h === "0.0.0.0" || h === "::1") return false;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = Number(m[1]), b = Number(m[2]);
    if (a === 0 || a === 10 || a === 127) return false;       // this-host / privado / loopback
    if (a === 169 && b === 254) return false;                  // link-local (cloud metadata 169.254.169.254)
    if (a === 172 && b >= 16 && b <= 31) return false;         // privado
    if (a === 192 && b === 168) return false;                  // privado
    if (a === 100 && b >= 64 && b <= 127) return false;        // CGNAT
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return false; // IPv6 ULA/link-local
  return true;
}

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

  const locationId = await resolveKbLocation(agentId, session.locationId, session.companyId);
  const supabase = createServerClient();
  const { data } = await supabase
    .from("knowledge_base")
    .select("*")
    .eq("agent_id", agentId)
    .eq("location_id", locationId)
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
    const description = (formData.get("description") as string) || null;
    const usageInstructions = (formData.get("usage_instructions") as string) || null;

    if (!file || !agentId) {
      return NextResponse.json({ error: "file e agent_id obrigatorios" }, { status: 400 });
    }
    if (file.size > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Arquivo muito grande (máx 15 MB). Divida ou cole o texto." }, { status: 413 });
    }

    // Extrair texto do arquivo (PDF, Excel, Word, CSV/txt, imagem via visão).
    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length > MAX_FILE_BYTES) {
      return NextResponse.json({ error: "Arquivo muito grande (máx 15 MB)." }, { status: 413 });
    }
    let content = await extractFileContent(file, buffer);

    // Truncar conteudo muito grande
    const maxChars = 50000;
    if (content.length > maxChars) {
      content = content.substring(0, maxChars) + "\n[...conteudo truncado]";
    }

    const tokenEstimate = Math.ceil(content.length / 4);

    const locationIdForFile = await resolveKbLocation(agentId, session.locationId, session.companyId);
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("knowledge_base")
      .insert({
        agent_id: agentId,
        location_id: locationIdForFile,
        type: "file",
        title,
        content,
        file_name: file.name,
        token_count: tokenEstimate,
        description,
        usage_instructions: usageInstructions,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ item: data }, { status: 201 });
  } else {
    // Texto ou URL
    const body = await request.json().catch(() => ({}));
    const { agent_id, type, title, content, description, usage_instructions } = body;

    if (!agent_id || !type || !title) {
      return NextResponse.json({ error: "Campos obrigatorios faltando" }, { status: 400 });
    }

    let finalContent = content || "";

    // Se for URL, tentar buscar conteudo. Guarda SSRF: só busca URL pública.
    if (type === "url" && content && isSafeHttpUrl(String(content))) {
      try {
        const res = await fetch(content, { signal: AbortSignal.timeout(10000), redirect: "error" });
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

    const locationIdForBody = await resolveKbLocation(agent_id, session.locationId, session.companyId);
    const supabase = createServerClient();
    const { data, error } = await supabase
      .from("knowledge_base")
      .insert({
        agent_id,
        location_id: locationIdForBody,
        type,
        title,
        content: finalContent,
        file_url: type === "url" ? content : null,
        token_count: tokenEstimate,
        description: description || null,
        usage_instructions: usage_instructions || null,
      })
      .select()
      .single();

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 });
    }

    return NextResponse.json({ item: data }, { status: 201 });
  }
}

// PATCH /api/knowledge-base — atualizar titulo, descricao e instrucoes
export async function PATCH(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const body = await request.json();
  const { id, agent_id, title, description, usage_instructions } = body;
  if (!id || !agent_id) {
    return NextResponse.json({ error: "id e agent_id obrigatorios" }, { status: 400 });
  }

  const updates: Record<string, unknown> = {};
  if (typeof title === "string") updates.title = title;
  if (description !== undefined) updates.description = description || null;
  if (usage_instructions !== undefined) updates.usage_instructions = usage_instructions || null;

  if (Object.keys(updates).length === 0) {
    return NextResponse.json({ error: "Nada para atualizar" }, { status: 400 });
  }

  const locationIdForPatch = await resolveKbLocation(agent_id, session.locationId, session.companyId);
  const supabase = createServerClient();
  const { data, error } = await supabase
    .from("knowledge_base")
    .update(updates)
    .eq("id", id)
    .eq("agent_id", agent_id)
    .eq("location_id", locationIdForPatch)
    .select()
    .single();

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  return NextResponse.json({ item: data });
}

// DELETE /api/knowledge-base?id=xxx
export async function DELETE(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  const id = request.nextUrl.searchParams.get("id");
  const agentId = request.nextUrl.searchParams.get("agent_id");
  if (!id || !agentId) {
    return NextResponse.json({ error: "id e agent_id obrigatorios" }, { status: 400 });
  }

  const locationIdForDel = await resolveKbLocation(agentId, session.locationId, session.companyId);
  const supabase = createServerClient();
  await supabase
    .from("knowledge_base")
    .delete()
    .eq("id", id)
    .eq("agent_id", agentId)
    .eq("location_id", locationIdForDel);

  return NextResponse.json({ success: true });
}
