/**
 * Handler do RECEBIMENTO via webhook do Stevo (canal WhatsApp direto).
 *
 * Pedro 2026-05-20: novo fluxo — recebimento vem do Stevo DIRETO (webhook do
 * GHL vira fallback). Este handler é o orquestrador do path Stevo: recebe o
 * `ParsedStevoMessage` (já puro, vindo de stevo-parser.ts) e:
 *   1. Resolve o hub ativo (resolvePrimaryHub) → locationId + agentId.
 *   2. Identifica o rep pelo telefone (identifyRep).
 *   3. Dedup por messageId (findByGhlMessageId em sparkbot_messages).
 *   4. Monta o RepInput (texto direto; doc/imagem via processFile a partir do
 *      base64 decriptado; áudio via transcribeAudioFromBuffer).
 *   5. Chama processIncoming (channel "whatsapp").
 *   6. Persiste o turno (user + agent) em sparkbot_messages.
 *
 * ⚠️ FASE 1: NÃO ENVIA a resposta via Stevo ainda — só processa, persiste e
 * loga. O envio (Stevo API /send/text) entra na FASE 2. Ver TODO abaixo.
 *
 * NÃO substitui o webhook-handler.ts (path GHL) — os dois coexistem durante a
 * transição. Reusa os mesmos building blocks (identity, file-processor,
 * processor, repos) pra manter comportamento idêntico.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import type { RepInput } from "@/types/account-assistant";
import type { ConversationTurn } from "@/lib/ai/openai-client";
import { resolvePrimaryHub } from "../hub-resolver";
import { identifyRep } from "../identity";
import { processFile } from "../file-processor";
import { processIncoming } from "../processor";
import { transcribeAudioFromBuffer } from "@/lib/ai/audio-transcriber";
import { reportError } from "@/lib/admin-signals/report-error";
import {
  findByGhlMessageId,
  insertSparkbotMessage,
  getSparkbotHistory,
} from "@/lib/repositories/sparkbot-messages.repo";
import { upsertStevoInstance } from "@/lib/repositories/stevo-instances.repo";
import { resolveBurstTurn } from "../core/debounce";
import type { ParsedStevoMessage } from "./stevo-parser";
import {
  sendStevoText,
  sendStevoButton,
  sendStevoList,
  type StevoSendResult,
} from "./stevo-send";

const SPARKBOT_HISTORY_TURNS = 30;

/** Gate do envio via Stevo (fase 2). Default OFF — ligar só no cutover. */
function isStevoSendEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.STEVO_SEND_ENABLED?.trim() || "");
}

/** Gate do interativo (botões/listas). Default OFF — ligar só no go-live. */
function isStevoInteractiveEnabled(): boolean {
  return /^(1|true|yes)$/i.test(process.env.STEVO_INTERACTIVE_ENABLED?.trim() || "");
}

/** Janela de debounce (ms) pra juntar rajada de texto. 0 = desliga.
 *  Default OFF (0) — ligar via STEVO_DEBOUNCE_MS=4000 no go-live supervisionado.
 *  Assim deployar NÃO muda o timing das respostas até a gente validar junto. */
function getDebounceMs(): number {
  const raw = parseInt(process.env.STEVO_DEBOUNCE_MS?.trim() || "0", 10);
  return Number.isFinite(raw) && raw >= 0 ? raw : 0;
}

/**
 * Decide se ESTA invocação ainda deve responder, ou se foi superada (rajada do
 * rep) / já respondida (vencedor concorrente). Reusada no PRÉ-LLM (early-out
 * barato durante o debounce) e no PRÉ-ENVIO (reprocessa stragglers que chegaram
 * durante a geração — Pedro 2026-05-21). Critério, na ÚLTIMA msg do rep nesse hub:
 *   - role 'agent'  → alguém já respondeu o lote → bail (anti-duplicação).
 *   - ghl_message_id ≠ o meu → há msg de USER mais nova → ela (ou a invocação
 *     dela) responde o lote completo (resolveBurstTurn junta a rajada).
 * Inclui hub_location_id (paridade com getSparkbotHistory).
 */
async function shouldStillRespond(
  sb: ReturnType<typeof createAdminClient>,
  repId: string,
  hubLocationId: string,
  myMessageId: string,
): Promise<"proceed" | "bail"> {
  const { data: last } = await sb
    .from("sparkbot_messages")
    .select("role, ghl_message_id")
    .eq("rep_id", repId)
    .eq("hub_location_id", hubLocationId)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (last?.role === "agent") return "bail";
  if (last?.ghl_message_id && last.ghl_message_id !== myMessageId) return "bail";
  return "proceed";
}

/**
 * Constrói o RepInput a partir do conteúdo parseado do Stevo. O binário já
 * vem decriptado em base64 (doc/imagem/áudio), então convertemos pra Buffer e
 * reusamos os mesmos parsers do painel web / webhook GHL.
 *
 * Retorna `null` se o conteúdo não pôde ser convertido (ex: file-processor
 * rejeitou o tipo, transcrição falhou). Caller decide abortar nesse caso —
 * na fase 1 não respondemos erro pro rep ainda.
 */
async function buildRepInput(parsed: ParsedStevoMessage): Promise<RepInput | null> {
  if (parsed.kind === "text") {
    return { kind: "text", text: parsed.text };
  }

  // Tap em botão/lista → o rep "disse" o label/título. Trata como texto normal;
  // o miolo (gate H8, coherence) age igual. AMARRA o tap à pergunta original
  // (quotedText) pra o LLM saber EXATAMENTE qual ação confirmar quando há várias
  // pendentes (stress test 2026-05-20: "Sim"/"Confirmar" se ligava na ação errada).
  if (parsed.kind === "interactive") {
    const txt = parsed.quotedText
      ? `${parsed.text} — (resposta à pergunta: "${parsed.quotedText}")`
      : parsed.text;
    return { kind: "text", text: txt };
  }

  if (parsed.kind === "audio") {
    try {
      const buffer = Buffer.from(parsed.base64, "base64");
      const { text } = await transcribeAudioFromBuffer(buffer, parsed.mimetype);
      return { kind: "audio", transcribed_text: text };
    } catch (err) {
      console.warn(
        "[stevo-handler] transcrição de áudio falhou:",
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  // document | image → buffer decriptado → file-processor unificado.
  try {
    const buffer = Buffer.from(parsed.base64, "base64");
    const result = await processFile({
      buffer,
      mime: parsed.mimetype,
      filename:
        parsed.kind === "document" ? parsed.fileName || "arquivo" : "imagem",
    });
    // Anexa o caption do Stevo (rep pode mandar texto junto do arquivo/imagem).
    const caption = parsed.caption || undefined;
    const repInput = result.repInput;
    if (
      repInput.kind === "image" ||
      repInput.kind === "document" ||
      repInput.kind === "tabular"
    ) {
      return { ...repInput, caption };
    }
    return repInput;
  } catch (err) {
    // file-processor lança FileProcessError com `code` user-friendly em alguns
    // casos (HEIC, PDF vazio, file too large). Na fase 1 só logamos — o envio
    // dessas mensagens de erro pro rep entra na fase 2.
    const code = (err as { code?: string })?.code;
    console.warn(
      `[stevo-handler] processFile falhou (code=${code ?? "?"}):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

/**
 * Snapshot textual do input do rep pra persistir em sparkbot_messages.content.
 * Mesma convenção do webhook-handler.ts (emoji por tipo, nunca content="").
 */
function userMsgContent(input: RepInput): string {
  if (input.kind === "text") return input.text.trim() || "[mensagem vazia]";
  if (input.kind === "audio") return `🎤 "${input.transcribed_text}"`;
  if (input.kind === "image") return input.caption || "[imagem]";
  if (input.kind === "document") {
    return `📎 ${input.filename}${input.extracted_text ? `\n${input.extracted_text.substring(0, 500)}` : ""}`;
  }
  if (input.kind === "tabular") {
    return `📊 ${input.tabular.filename} (${input.tabular.total_rows} linhas)${input.caption ? `\n${input.caption}` : ""}`;
  }
  return "(input)";
}

/**
 * Processa um inbound do Stevo. Idempotente por messageId. Não lança — captura
 * tudo e loga; o caller chama via waitUntil e sempre responde 200 pro Stevo.
 */
export async function handleStevoInbound(parsed: ParsedStevoMessage): Promise<void> {
  // 1. Resolve o hub ativo (locationId + agentId).
  const hub = await resolvePrimaryHub();
  if (!hub || !hub.locationId) {
    console.error("[stevo-handler] nenhum hub Sparkbot ativo — abortando.");
    // Hardening 2026-06-17: estado de config que MATA 100% do inbound do SparkBot
    // — antes só console (mudo). Vira signal crítico pra não repetir apagão silencioso.
    reportError({
      title: "SparkBot: hub não resolvido no inbound Stevo (bot mudo)",
      feature: "sparkbot-inbound-stevo",
      severity: "critical",
      description: "resolvePrimaryHub() não retornou hub/locationId — nenhum SparkBot ativo. TODO inbound do rep é abortado em silêncio.",
      metadata: { phone: parsed.phone },
    });
    return;
  }
  const { locationId: hubLocationId, agentId } = hub;
  if (!agentId) {
    // resolvePrimaryHub pode cair no fallback env (agentId vazio). Sem agentId
    // não conseguimos cobrar/logar corretamente — aborta com log claro.
    console.error(
      `[stevo-handler] hub ${hubLocationId} sem agentId resolvido (fallback env?) — abortando.`,
    );
    reportError({
      title: "SparkBot: hub não resolvido no inbound Stevo (bot mudo)",
      feature: "sparkbot-inbound-stevo",
      severity: "critical",
      description: `Hub ${hubLocationId} sem agentId (fallback env?) — inbound do rep abortado em silêncio.`,
      metadata: { phone: parsed.phone, hub_location_id: hubLocationId },
    });
    return;
  }

  // Mantém stevo_instances fresca: serverUrl + token desta instância por hub.
  // É o que os PROATIVOS (deliverProactiveMessage) usam pra enviar via Stevo
  // quando não há inbound de onde puxar. Fire-and-forget — não bloqueia o turno
  // nem falha o handler se o upsert der erro.
  if (parsed.serverUrl && parsed.instanceToken) {
    void upsertStevoInstance({
      hubLocationId,
      serverUrl: parsed.serverUrl,
      instanceToken: parsed.instanceToken,
      instanceName: parsed.instanceName || null,
    });
  }

  // 2. Dedup upfront por messageId (retry do Stevo com mesmo ID não reprocessa).
  try {
    const existing = await findByGhlMessageId(parsed.messageId);
    if (existing) {
      console.log(
        `[stevo-handler] dedupe: messageId ${parsed.messageId} já processado — skipping`,
      );
      return;
    }
  } catch (err) {
    console.warn(
      "[stevo-handler] dedup lookup falhou — segue (UNIQUE constraint pega):",
      err instanceof Error ? err.message : err,
    );
  }

  // 3. Identifica o rep pelo telefone (busca ou cria).
  const rep = await identifyRep(parsed.phone);
  if (rep === "scan_failed") {
    // Varredura quebrou em 100% das locations (token GHL caído). O reportError
    // crítico já disparou dentro do identifyRep. Stevo fase 1 não responde a
    // número não-identificado (evita spam a randoms) — só loga e sai; o sinal
    // crítico avisa o Pedro.
    console.warn(
      `[stevo-handler] identifyRep scan_failed pra ${parsed.phone} — token GHL provavelmente caído (signal crítico já gravado).`,
    );
    return;
  }
  if (!rep) {
    console.warn(
      `[stevo-handler] telefone ${parsed.phone} não cadastrado em nenhuma location — ignorando (fase 1 não envia aviso).`,
    );
    // Sweep 2026-06-17: sinal LOW pra visibilidade de onboarding (mesmo title
    // estável do webhook-handler → clusteriza os 2 canais numa row só). Não
    // empurra push (low), mas se MUITOS números forem rejeitados o occ sobe.
    reportError({
      title: "SparkBot: número não cadastrado (rep não encontrado)",
      feature: "sparkbot-stevo",
      severity: "low",
      description: "identifyRep (Stevo) varreu as locations e não achou esse phone em nenhum GHL user.",
      metadata: { phone: parsed.phone },
    });
    return;
  }

  // 4. Monta o RepInput multimodal.
  const repInput = await buildRepInput(parsed);
  if (!repInput) {
    console.warn(
      `[stevo-handler] não consegui montar RepInput pra messageId ${parsed.messageId} (kind=${parsed.kind}) — abortando.`,
    );
    return;
  }

  // 4b. H47-F2 (2026-07-10): TAP DETERMINÍSTICO. O reply de lista/botão carrega o
  // selection_id, mas o LLM só via o TÍTULO truncado (24ch) — quando ambíguo
  // ("Victor Alves"), ele RE-PERGUNTAVA a mesma lista (caso E1/Guilherme Dias).
  // Agora: busca a opção ORIGINAL (persistida na metadata da msg do agent) pelo
  // selection_id e injeta label completo + description + contact_id como PISTA
  // re-validável (padrão H45 — nunca id cego).
  if (parsed.kind === "interactive" && parsed.selectionId && repInput.kind === "text") {
    try {
      const sb = createAdminClient();
      const { data: recent } = await sb
        .from("sparkbot_messages")
        .select("metadata")
        .eq("rep_id", rep.id)
        .eq("role", "agent")
        .not("metadata->interactive_options", "is", null)
        .gte("created_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
        .order("created_at", { ascending: false })
        .limit(5);
      for (const row of recent || []) {
        const opts = ((row.metadata as Record<string, unknown>)?.interactive_options || []) as Array<{
          id?: string; label?: string; description?: string | null; contact_id?: string | null;
        }>;
        const hit = Array.isArray(opts) ? opts.find((o) => o?.id === parsed.selectionId) : undefined;
        if (hit) {
          const bits = [
            `opção escolhida na lista: "${hit.label ?? ""}"`,
            hit.description ? `(${hit.description})` : "",
            hit.contact_id
              ? `— contact_id ${hit.contact_id} como PISTA: valide com get_contact antes de agir, NÃO re-pergunte qual contato`
              : "",
          ].filter(Boolean).join(" ");
          repInput.text = `${repInput.text}\n[${bits}]`;
          break; // usa a msg mais recente que contém esse selection_id
        }
      }
    } catch (err) {
      console.warn("[stevo-handler] enriquecimento do tap falhou (segue sem):", err instanceof Error ? err.message : err);
    }
  }

  // 6. Persiste a msg do rep ANTES de processar (assim se LLM crashar, o
  //    próximo turno ainda tem o histórico). Captura 23505 = dedup signal.
  const insertedUser = await insertSparkbotMessage({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: agentId,
    active_location_id: rep.active_location_id || null,
    role: "user",
    content: userMsgContent(repInput),
    channel: "whatsapp",
    ghl_message_id: parsed.messageId,
    metadata: {
      input_kind: repInput.kind,
      source: "stevo",
      push_name: parsed.pushName || null,
      // Audit do tap interativo (rep tocou botão/lista em vez de digitar).
      ...(parsed.kind === "interactive"
        ? {
            interactive_reply: parsed.interactiveType,
            selection_id: parsed.selectionId,
            reply_to_stanza: parsed.replyToStanzaId,
          }
        : {}),
    },
  });
  // insertSparkbotMessage devolve null em qualquer erro (inclusive 23505). Se a
  // msg já existia (race com webhook GHL fallback), o dedup upfront geralmente
  // pega; aqui é defesa extra mas seguimos pra processar de qualquer forma —
  // pior caso, gera 1 turno duplicado raríssimo (Stevo não faz multi-provider).
  if (!insertedUser) {
    console.warn(
      `[stevo-handler] insert da user msg falhou (messageId ${parsed.messageId}) — seguindo mesmo assim.`,
    );
  }

  // Silence reset: qualquer inbound do rep limpa counter + pausa proativa.
  // H52: pausa do loop-guard NÃO é limpa (ver resetSilenceTracking).
  try {
    const { resetSilenceTracking } = await import("@/lib/repositories/rep-identities.repo");
    await resetSilenceTracking(rep.id, new Date().toISOString());
  } catch (err) {
    console.warn(
      "[stevo-handler] silence reset falhou (não-bloqueante):",
      err instanceof Error ? err.message : err,
    );
  }

  // ===== DEBOUNCE (Pedro 2026-05-20): junta rajada de texto numa resposta só =====
  // O path Stevo processava cada msg na hora → 2 msgs em 3s viravam 2 respostas
  // fragmentadas (visto no fluxo 15:34 EDT). Estratégia "latest-wins": espera uma
  // janela; se chegou msg mais nova do mesmo rep, esta invocação BAILA (a mais
  // nova processa o lote). Só pra TEXTO/interativo — mídia (áudio/imagem/doc)
  // segue na hora (vem isolada e é cara de reprocessar). STEVO_DEBOUNCE_MS=0 desliga.
  const debounceMs = getDebounceMs();
  const isTextLike = repInput.kind === "text";
  // PRÉ-LLM: durante a janela de debounce, se já chegou msg mais nova / alguém
  // respondeu, baixa ANTES de gastar o LLM (early-out barato; coalesce rajada
  // rápida). Com debounceMs=0 (desligado) não roda — a checagem PRÉ-ENVIO abaixo
  // cobre o straggler que chega durante a geração.
  if (isTextLike && debounceMs > 0) {
    await new Promise((r) => setTimeout(r, debounceMs));
    try {
      const decision = await shouldStillRespond(
        createAdminClient(),
        rep.id,
        hubLocationId,
        parsed.messageId,
      );
      if (decision === "bail") {
        console.log(
          `[stevo-handler] debounce pré-LLM: ${parsed.messageId} superada/já respondida — bail (lote vai pela msg mais nova)`,
        );
        return;
      }
    } catch (err) {
      console.warn(
        "[stevo-handler] debounce check falhou — segue processando:",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // Carrega histórico DEPOIS do debounce (pega o lote completo) e resolve o
  // turno: combina rajada de texto num input só / exclui a mídia atual do
  // histórico. Lógica pura testável em core/debounce.ts.
  let conversationHistory: ConversationTurn[] = [];
  let finalInput: RepInput = repInput;
  try {
    const prior = await getSparkbotHistory(rep.id, hubLocationId, SPARKBOT_HISTORY_TURNS);
    const chrono = prior.reverse().filter((m) => (m.content || "").trim().length > 0);
    const resolved = resolveBurstTurn(chrono, isTextLike, repInput);
    finalInput = resolved.input;
    conversationHistory = resolved.history;
    if (finalInput !== repInput) {
      console.log("[stevo-handler] debounce: rajada de texto combinada num turno.");
    }
  } catch (err) {
    console.warn(
      "[stevo-handler] leitura de histórico falhou (segue sem histórico):",
      err instanceof Error ? err.message : err,
    );
  }

  // 7. Processa via pipeline padrão (mesma config default do webhook GHL).
  let result;
  try {
    result = await processIncoming({
      rep,
      input: finalInput,
      agentId,
      conversationHistory,
      channel: "whatsapp",
      config: {
        confirmation_mode: "high_only",
        enabled_kbs: ["national_life_group", "agency_brazillionaires"],
        enable_audio_transcription: true,
        enable_image_analysis: true,
        enable_pdf_reading: true,
      },
    });
  } catch (err) {
    console.error(
      "[stevo-handler] processIncoming lançou:",
      err instanceof Error ? err.message : err,
    );
    // Sweep F49 2026-06-05: pipeline lançou → rep não recebe resposta via WhatsApp.
    reportError({ title: "Stevo: processIncoming lançou (SparkBot não respondeu)", feature: "sparkbot-inbound-stevo", severity: "high", error: err });
    return;
  }

  // ===== REPROCESSA SE CHEGOU MSG NOVA ANTES DE ENVIAR (Pedro 2026-05-21) =====
  // Filosofia "mais natural": processa na hora (debounce curto/zero) e, ANTES de
  // enviar, checa se o rep mandou outra msg DURANTE a geração. Se sim, descarta
  // esta resposta (já estaria "velha") — a invocação da msg mais nova responde o
  // lote inteiro (resolveBurstTurn junta a rajada de mensagens não-respondidas).
  //
  // SEGURANÇA (crítico): só descarta turno SEM efeito colateral — texto puro,
  // ZERO tools executadas E sem interativo. Confirmação pendente NÃO é descartada
  // porque a tool bloqueada pelo gate H8 fica registrada em tools_executed
  // (llm-client empurra TODA tool call, mesmo a barrada). Se executou qualquer
  // tool, pediu confirmação ou montou botão/lista → ENVIA normal: a msg nova vira
  // follow-up e enxerga o resultado/pergunta no histórico. Assim NUNCA duplica
  // ação (ex: create_contact 2×) nem quebra o fluxo de "Confirma?".
  const noSideEffects =
    (result.tools_executed?.length ?? 0) === 0 && !result.interactive;
  if (isTextLike && noSideEffects) {
    try {
      const decision = await shouldStillRespond(
        createAdminClient(),
        rep.id,
        hubLocationId,
        parsed.messageId,
      );
      if (decision === "bail") {
        console.log(
          `[stevo-handler] pré-envio: ${parsed.messageId} superada por msg mais nova — ` +
            `descartando resposta conversacional; a invocação mais nova responde o lote.`,
        );
        return; // não envia + não persiste agent (turno descartado)
      }
    } catch (err) {
      console.warn(
        "[stevo-handler] checagem pré-envio falhou — envia mesmo assim (fail-open):",
        err instanceof Error ? err.message : err,
      );
    }
  }

  // ===== 8. ENVIO (fase 2) — gated por STEVO_SEND_ENABLED =====
  // Default OFF: enquanto o cutover não acontece, o path Stevo só processa +
  // persiste (igual fase 1) e o envio segue saindo pelo GHL — assim deployar
  // este código NÃO muda o comportamento de prod. Quando STEVO_SEND_ENABLED=1
  // (cutover supervisionado), a resposta sai pelo Stevo, pela MESMA instância
  // que recebeu (parsed.serverUrl + parsed.instanceToken). Env é só fallback.
  const sendEnabled = isStevoSendEnabled();
  const interactiveEnabled = isStevoInteractiveEnabled();
  const replyText = result.text || "";
  const interactive = result.interactive;
  // Canal real do envio (audit): "buttons" | "list" | "text" | null.
  let sentKind: "buttons" | "list" | "text" | null = null;
  // Erro do envio interativo (preservado mesmo quando cai pro fallback texto).
  let interactiveError: string | null = null;
  let sendResult: StevoSendResult | null = null;

  if (sendEnabled && (replyText.trim() || interactive)) {
    const serverUrl = parsed.serverUrl || process.env.STEVO_API_BASE?.trim() || "";
    const apiKey =
      parsed.instanceToken ||
      process.env.STEVO_SEND_APIKEY?.trim() ||
      process.env.STEVO_INSTANCE_TOKEN?.trim() ||
      "";

    // Interativo (botão/lista) quando o gate tá ligado e o turno tem payload.
    // Se o envio interativo falhar, cai pro texto (o fallback já traz as opções
    // numeradas) — rep nunca fica sem resposta.
    if (interactiveEnabled && interactive) {
      if (interactive.kind === "buttons") {
        sentKind = "buttons";
        sendResult = await sendStevoButton({
          serverUrl,
          apiKey,
          number: parsed.phone,
          title: interactive.title,
          body: interactive.body,
          footer: interactive.footer,
          buttons: interactive.options.map((o) => ({ id: o.id, label: o.label })),
        });
      } else {
        sentKind = "list";
        sendResult = await sendStevoList({
          serverUrl,
          apiKey,
          number: parsed.phone,
          title: interactive.title,
          body: interactive.body,
          footer: interactive.footer,
          buttonText: interactive.buttonText || "Ver opções",
          sections: [
            {
              rows: interactive.options.map((o) => ({
                rowId: o.id,
                title: o.label,
                description: o.description,
              })),
            },
          ],
        });
      }
      if (!sendResult.ok && replyText.trim()) {
        interactiveError = sendResult.error ?? null;
        console.warn(
          `[stevo-handler] envio ${sentKind} falhou (${interactiveError}) — fallback texto.`,
        );
        sentKind = "text";
        sendResult = await sendStevoText({ serverUrl, apiKey, number: parsed.phone, text: replyText });
      }
    } else {
      sentKind = "text";
      sendResult = await sendStevoText({ serverUrl, apiKey, number: parsed.phone, text: replyText });
    }

    if (sendResult.ok) {
      console.log(
        `[stevo-handler] resposta enviada via Stevo pra ${parsed.phone} (${sentKind}; ${sendResult.sent}/${sendResult.total}).`,
      );
    } else {
      console.error(
        `[stevo-handler] envio via Stevo FALHOU pra ${parsed.phone} (${sentKind}): ${sendResult.error}`,
      );
      // Hardening 2026-06-17: o LLM rodou (tokens+billing), o rep foi processado,
      // mas a RESPOSTA não chegou — antes só console.error. Vira signal (dedup por title).
      reportError({
        title: "SparkBot: envio da resposta via Stevo falhou",
        feature: "sparkbot-inbound-stevo",
        severity: "high",
        description: `Resposta gerada mas o Stevo não entregou (${sentKind}; ${sendResult.sent}/${sendResult.total}): ${sendResult.error}`,
        metadata: { phone: parsed.phone, sent_kind: sentKind, send_error: sendResult.error },
      });
    }
  } else {
    console.log(
      `[stevo-handler] resposta gerada (envio ${sendEnabled ? "vazio" : "OFF — STEVO_SEND_ENABLED desligado"}) ` +
        `pra ${parsed.phone}: "${replyText.slice(0, 200)}"`,
    );
  }

  // 9. Persiste a resposta do agente (com o status real do envio).
  await insertSparkbotMessage({
    rep_id: rep.id,
    hub_location_id: hubLocationId,
    agent_id: agentId,
    active_location_id: rep.active_location_id || null,
    role: "agent",
    content: result.text || "(sem resposta)",
    channel: "whatsapp",
    metadata: {
      source: "stevo",
      model: result.model_used,
      tools: result.tools_executed,
      // H47-F0 (telemetria 2026-07-10): funil de resolução de contato re-rodável
      // (confidence × método × score por search_contacts do turno).
      contact_resolution: result.contact_resolution ?? null,
      // B0 (Onda B 2026-07-21): anatomia real do turno — a rota Stevo é ~97% do tráfego
      // (o review pegou: só o webhook-handler persistia e o B0 ficava cego em prod).
      call_usage: result.call_usage ?? null,
      // H47-F2 (2026-07-10): opções COMPLETAS da lista/botões enviados — o tap
      // volta com selection_id e o handler resolve DETERMINISTICAMENTE qual
      // opção/contato o rep escolheu (ver enriquecimento 4b no inbound).
      interactive_options: result.interactive
        ? result.interactive.options.map((o) => ({
            id: o.id,
            label: o.label,
            description: o.description ?? null,
            contact_id: o.contact_id ?? null,
          }))
        : null,
      prompt_tokens: result.tokens?.prompt,
      completion_tokens: result.tokens?.completion,
      cached_tokens: result.tokens?.cached,
      llm_failed: result.llm_failed,
      // Status de envio: sent_via="stevo" quando a resposta saiu de fato.
      // not_sent=true quando o gate estava off OU o envio falhou (audit claro).
      sent_via: sendResult?.ok ? "stevo" : null,
      sent_kind: sentKind,
      interactive_via: result.interactive_via ?? null,
      interactive_error: interactiveError,
      not_sent: !sendResult?.ok,
      send_error: sendResult?.error ?? null,
      send_bubbles: sendResult ? `${sendResult.sent}/${sendResult.total}` : null,
    },
  });
}
