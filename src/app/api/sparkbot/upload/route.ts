/**
 * POST /api/sparkbot/upload
 *
 * Recebe arquivo (multipart) do painel web, parseia via file-processor
 * unificado e devolve estrutura pra painel guardar em React state.
 * Painel envia esse `attachment` no /send seguinte.
 *
 * Pass-through: arquivo original NÃO é persistido. Só os dados parseados
 * voltam pro client.
 *
 * Body: multipart/form-data { file: File }
 * Response: {
 *   ok: true,
 *   attachment: RepInput (kind: image | document | tabular)
 *   summary: string
 *   kind: FileKind
 * }
 */

import { NextRequest, NextResponse } from "next/server";
import { verifySparkbotWebToken } from "@/lib/account-assistant/web-auth";
import { processFile, FileProcessError, FILE_LIMITS } from "@/lib/account-assistant/file-processor";

export const maxDuration = 30;

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS });
}

const json = (data: Record<string, unknown>, init: ResponseInit = {}) =>
  NextResponse.json(data, { ...init, headers: { ...CORS_HEADERS, ...(init.headers || {}) } });

const MAX_UPLOAD_SIZE = Math.max(...Object.values(FILE_LIMITS));

export async function POST(request: NextRequest) {
  const tok = await verifySparkbotWebToken(request.headers.get("authorization"));
  if (!tok) return json({ ok: false, reason: "unauthorized" }, { status: 401 });

  const formData = await request.formData().catch(() => null);
  if (!formData) return json({ ok: false, reason: "invalid_form_data" }, { status: 400 });

  const file = formData.get("file") as File | null;
  if (!file) return json({ ok: false, reason: "missing_file" }, { status: 400 });

  // Limite genérico antes de parsear
  if (file.size > MAX_UPLOAD_SIZE) {
    return json(
      { ok: false, reason: "file_too_large", max_bytes: MAX_UPLOAD_SIZE },
      { status: 413 },
    );
  }
  if (file.size < 10) {
    return json({ ok: false, reason: "file_too_small" }, { status: 400 });
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    const result = await processFile({
      buffer,
      mime: file.type,
      filename: file.name || "arquivo",
    });

    return json({
      ok: true,
      kind: result.kind,
      attachment: result.repInput,
      summary: result.summary,
    });
  } catch (err) {
    if (err instanceof FileProcessError) {
      // Erros tipados — devolve code + msg pro painel mostrar
      const status = err.code === "file_too_large" ? 413
                   : err.code === "unsupported_type" ? 415
                   : 422;
      return json({ ok: false, reason: err.code, message: err.message }, { status });
    }
    console.error("[upload] erro inesperado:", err instanceof Error ? err.message : err);
    return json({ ok: false, reason: "internal_error" }, { status: 500 });
  }
}
