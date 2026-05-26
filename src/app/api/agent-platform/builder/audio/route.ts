/**
 * POST /api/agent-platform/builder/audio — áudio do builder → transcrição + RESUMO.
 *
 * Pedro 2026-05-26: no onboarding, a pessoa pode GRAVAR um áudio explicando a
 * campanha. O sistema transcreve (Whisper) e devolve um RESUMO (não o texto
 * exato) pra aparecer na bolha; a pessoa confirma e envia. Body: formData{audio}.
 * Retorna { summary, transcript }.
 */
import { NextRequest, NextResponse } from "next/server";
import { getSession } from "@/lib/auth/sso";
import OpenAI, { toFile } from "openai";
import { errorResponse, unauthorized } from "@/lib/utils/api";

export const maxDuration = 45;

export async function POST(request: NextRequest) {
  const session = await getSession();
  if (!session) return unauthorized();

  try {
    const formData = await request.formData();
    const file = formData.get("audio") as File | null;
    if (!file) return errorResponse("Áudio obrigatório.", 400, "no_audio");

    const buffer = Buffer.from(await file.arrayBuffer());
    if (buffer.length < 100) return errorResponse("Áudio muito curto.", 400, "too_small");

    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY, timeout: 40000 });
    const ext = file.name.split(".").pop() || "webm";
    const oaFile = await toFile(buffer, `audio.${ext}`, { type: file.type || `audio/${ext}` });

    const tr = await openai.audio.transcriptions.create({ file: oaFile, model: "whisper-1", language: "pt" });
    const transcript = tr.text?.trim() || "";
    if (!transcript) return NextResponse.json({ summary: "", transcript: "" });

    // Resumo conciso em PT (1ª pessoa) preservando o que importa pro agente.
    const comp = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content:
            "Você resume, em português e em 1-3 frases, o que a pessoa falou sobre a campanha/agente que ela quer. " +
            "Escreva na 1ª pessoa (como se fosse a própria pessoa), claro e direto, preservando os detalhes úteis " +
            "(público-alvo, oferta, objetivo, canais, prazos, tom). NÃO invente nada que não foi dito.",
        },
        { role: "user", content: transcript },
      ],
      temperature: 0.2,
      max_tokens: 300,
    });
    const summary = comp.choices[0]?.message?.content?.trim() || transcript;

    return NextResponse.json({ summary, transcript });
  } catch (err) {
    console.error("[builder/audio] error:", err instanceof Error ? err.message : err);
    return errorResponse(err instanceof Error ? err.message : "erro no áudio", 500, "audio_error");
  }
}
