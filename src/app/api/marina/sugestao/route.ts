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
import { processWithAI } from "@/lib/ai/openai-client";
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

FORMATO DA RESPOSTA — responda SÓ com JSON válido, sem cerca de código:
{"message":["bolha 1","bolha 2"],"should_send_message":true,"actions":[],"collected_data":{},"conversation_status":"active","internal_notes":"LEITURA: o que você entendeu do print, 1-3 frases | PORQUE: 1 frase sobre a escolha | CONFIANCA: alta ou media ou baixa"}
"message" é o rascunho EXATO pra Marina copiar, quebrado em bolhas curtas — sem aspas em
volta, sem colchete, sem placeholder, sem "[nome]". "internal_notes" é só pra ela conferir
se você leu o print certo; use CONFIANCA: baixa quando não tiver certeza de quem falou o quê.
"actions" é SEMPRE lista vazia aqui — este é um rascunho, não um turno de verdade.`;

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

    // O processWithAI SEMPRE normaliza pro formato da plataforma (message /
    // internal_notes / ...) — então a gente fala a língua dele em vez de inventar
    // um schema paralelo. Bônus: as bolhas passam pelo mesmo sanitizador do
    // agente de produção (tira travessão, saudação repetida), então o rascunho
    // já sai no padrão que ela aprovou.
    const resp = (r.response || {}) as { message?: unknown; internal_notes?: unknown };
    const msg = resp.message;
    const bolhas = (Array.isArray(msg) ? msg : msg ? [msg] : [])
      .map((x) => String(x).trim())
      .filter(Boolean);

    const notas = String(resp.internal_notes || "");
    const pega = (rot: string) => {
      const m = notas.match(new RegExp(`${rot}\\s*:\\s*([^|]+)`, "i"));
      return m ? m[1].trim() : "";
    };
    const leitura = pega("LEITURA");
    const porque = pega("PORQUE");
    const conf = pega("CONFIANCA").toLowerCase();
    const confianca = /baix/.test(conf) ? "baixa" : /alt/.test(conf) ? "alta" : "media";

    if (bolhas.length === 0) {
      return NextResponse.json(
        { ok: false, erro: "não consegui ler esse print — tenta um mais nítido ou recorta só a conversa" },
        { status: 502 },
      );
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
