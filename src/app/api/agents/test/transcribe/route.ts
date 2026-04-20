import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import OpenAI, { toFile } from "openai";

export const maxDuration = 30;

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) {
    return NextResponse.json({ error: "Nao autenticado" }, { status: 401 });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("audio") as File | null;

    if (!file) {
      return NextResponse.json({ error: "Arquivo de audio obrigatorio" }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length < 100) {
      return NextResponse.json({ error: "Arquivo muito pequeno" }, { status: 400 });
    }

    const ext = file.name.split(".").pop() || "webm";
    const openaiFile = await toFile(buffer, `audio.${ext}`, {
      type: file.type || `audio/${ext}`,
    });

    const openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
      timeout: 25000,
    });

    const transcription = await openai.audio.transcriptions.create({
      file: openaiFile,
      model: "whisper-1",
      language: "pt",
    });

    const text = transcription.text?.trim();
    if (!text) {
      return NextResponse.json({ text: "", error: "Audio sem conteudo detectavel" });
    }

    return NextResponse.json({ text });
  } catch (error) {
    console.error("[Transcribe] Error:", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Erro na transcricao" },
      { status: 500 }
    );
  }
}
