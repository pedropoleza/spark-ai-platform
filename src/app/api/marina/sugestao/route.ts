/**
 * POST /api/marina/sugestao — o MODO SEMI-AUTOMÁTICO.
 *
 * A Marina manda print(s) da conversa real com um lead e recebe uma sugestão de
 * resposta pra COPIAR e mandar ela mesma. A IA não fala com o lead aqui: nada é
 * enviado, nada é escrito no CRM.
 *
 * Entrada: { imagens: string[] (data URI), nota?: string }
 * Saída:   { leitura, bolhas: string[], porque, registro_id }
 *
 * A persona/fatos vêm do MESMO `custom_instructions` do agente de produção —
 * assim a sugestão que ela aprova é a mesma coisa que o agente diria sozinho
 * (se fosse o contrário, a gente estaria treinando com material de outro bot).
 * Ver `_planning/marina-lab/PLANO.md`.
 */
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { processWithAI, parseAIResponse } from "@/lib/ai/openai-client";
import { lerTokenMarina } from "@/lib/marina-lab/auth";

export const maxDuration = 60;

const MAX_IMAGENS = 3;
const MAX_BYTES_POR_IMAGEM = 5 * 1024 * 1024; // ~5MB depois do base64

export async function POST(request: NextRequest) {
  const token = await lerTokenMarina(request);
  if (!token) return NextResponse.json({ ok: false, erro: "não autenticada" }, { status: 401 });

  let imagens: string[] = [];
  let nota = "";
  try {
    const body = (await request.json()) as { imagens?: unknown; nota?: unknown };
    imagens = Array.isArray(body.imagens) ? body.imagens.map(String).slice(0, MAX_IMAGENS) : [];
    nota = String(body.nota || "").slice(0, 1000);
  } catch {
    return NextResponse.json({ ok: false, erro: "payload inválido" }, { status: 400 });
  }

  const validas = imagens.filter(
    (u) => /^data:image\/(png|jpe?g|webp|gif);base64,/.test(u) && u.length < MAX_BYTES_POR_IMAGEM * 1.4,
  );
  if (validas.length === 0) {
    return NextResponse.json(
      { ok: false, erro: "manda pelo menos um print (PNG ou JPG, até 5MB)" },
      { status: 400 },
    );
  }

  const supabase = createAdminClient();
  const { data: cfg } = await supabase
    .from("agent_configs")
    .select("custom_instructions, conversation_examples, ai_model")
    .eq("agent_id", token.agent_id)
    .single();

  if (!cfg) return NextResponse.json({ ok: false, erro: "config do agente não encontrada" }, { status: 500 });

  const systemPrompt = `${cfg.custom_instructions || ""}

${cfg.conversation_examples ? `# EXEMPLOS DO SEU JEITO DE ESCREVER\n${cfg.conversation_examples}\n` : ""}
# TAREFA DE AGORA — RASCUNHO PRA MARINA COPIAR
Você está OLHANDO UM PRINT de uma conversa real entre a Marina e uma pessoa. Você NÃO está
falando com essa pessoa: você escreve o rascunho que a MARINA vai copiar e mandar.
1. Leia o print com atenção. Descubra quem é quem: as mensagens da Marina normalmente estão
   de um lado (alinhadas à direita) e as da pessoa do outro. Se não der pra ter certeza de
   quem falou o quê, DIGA ISSO na leitura em vez de adivinhar.
2. A última mensagem da PESSOA é o que você precisa responder.
3. Responda seguindo as MESMAS regras e o MESMO estilo das suas instruções acima (fatos
   fixos, link só o oficial, sem promessa de renda, sem inventar nada que não esteja lá).
4. Se o print não tiver informação suficiente, ou se o caso for daqueles de segurar
   (reembolso, cobrança, visto, jurídico), diga isso claramente em vez de inventar resposta.

Responda SÓ com JSON válido, sem cerca de código:
{"leitura":"1-3 frases do que você entendeu do print (pra Marina conferir se você leu certo)","bolhas":["mensagem 1","mensagem 2"],"porque":"1 frase explicando a escolha","confianca":"alta|media|baixa"}
As "bolhas" são o texto EXATO pra copiar — sem aspas em volta, sem colchete, sem placeholder.`;

  const entrada = nota
    ? `Print(s) da conversa em anexo. Observação da Marina: ${nota}`
    : "Print(s) da conversa em anexo.";

  try {
    const r = await processWithAI({
      systemPrompt,
      conversationHistory: "",
      newMessages: entrada,
      model: cfg.ai_model || "claude-sonnet-4-6",
      images: validas.map((u) => ({ url: "", base64DataUri: u })),
    });

    const bruto = r.response as unknown;
    const texto =
      typeof bruto === "string" ? bruto : ((bruto as { raw?: string })?.raw ?? JSON.stringify(bruto ?? ""));
    const parsed = (parseAIResponse(texto) ?? null) as unknown as {
      leitura?: string; bolhas?: unknown; porque?: string; confianca?: string;
    } | null;

    let leitura = parsed?.leitura || "";
    let bolhas = Array.isArray(parsed?.bolhas) ? parsed!.bolhas.map(String).filter(Boolean) : [];
    const porque = parsed?.porque || "";
    const confianca = parsed?.confianca || "media";

    // Fallback honesto: se o JSON não veio, devolve o texto cru como uma bolha
    // só — melhor a Marina ver o que a IA escreveu do que um erro seco.
    if (bolhas.length === 0) {
      const limpo = String(texto || "").replace(/```(json)?/g, "").trim();
      if (!limpo) return NextResponse.json({ ok: false, erro: "não consegui ler o print, tenta de novo" }, { status: 502 });
      bolhas = [limpo.slice(0, 1200)];
      leitura = leitura || "(não consegui estruturar a leitura — segue o rascunho cru)";
    }

    const { data: reg } = await supabase
      .from("marina_lab_feedback")
      .insert({
        agent_id: token.agent_id,
        location_id: token.location_id,
        tipo: "print",
        texto: nota || null,
        conversa_extraida: leitura || null,
        resposta_sugerida: bolhas.join("\n"),
        imagens_count: validas.length,
      })
      .select("id")
      .single();

    return NextResponse.json({ ok: true, leitura, bolhas, porque, confianca, registro_id: reg?.id ?? null });
  } catch (e) {
    console.error("[marina/sugestao] falhou:", e instanceof Error ? e.message : e);
    return NextResponse.json({ ok: false, erro: "deu erro ao ler o print, tenta de novo" }, { status: 500 });
  }
}
