/**
 * Parser de input multimodal do webhook do SparkBot.
 *
 * Extraído de webhook-handler.ts na V2.2 (decomposição do god-file, ver
 * _planning/_review-2026-05-19/B1-arquitetura.md §4). É a parte mais pura do
 * handler — recebe o body cru do webhook + o texto, e devolve um RepInput
 * tipado (text/audio/image/document/tabular). Sem acesso a DB, sem envio.
 *
 * Comportamento preservado BYTE-A-BYTE em relação ao `extractRepInput` que
 * morava no handler — só mudou de arquivo.
 */

import { transcribeAudioFromUrl, extractAudioUrl } from "@/lib/ai/audio-transcriber";
import { extractMediaAttachments } from "@/lib/ai/media-extractor";
import { validateExternalUrl } from "@/lib/utils/url-allowlist";
import type { RepInput } from "@/types/account-assistant";

/** Acumulador de telemetria de áudio extraído (pra billing posterior). */
export interface AudioMeta {
  audio_seconds: number;
  model: string;
}

/**
 * Extrai RepInput do webhook body (áudio → whisper, imagem → base64, doc → extract).
 *
 * C4 fix: caller pode passar `audioMetaSink` pra capturar audio_seconds e
 * cobrar Whisper depois. Antes deste fix, extractRepInput transcrevia áudio
 * mas NUNCA cobrava — Sparkbot WhatsApp rodava Whisper free.
 */
export async function extractRepInput(args: {
  body: Record<string, unknown>;
  messageBody: string;
  audioMetaSink?: { current: AudioMeta | null };
}): Promise<RepInput> {
  const { body, messageBody, audioMetaSink } = args;

  const audioInfo = extractAudioUrl(body);
  if (audioInfo?.url) {
    try {
      const transcribed = await transcribeAudioFromUrl(audioInfo.url);
      if (transcribed?.text) {
        if (audioMetaSink && transcribed.audio_seconds > 0) {
          audioMetaSink.current = {
            audio_seconds: transcribed.audio_seconds,
            model: transcribed.model,
          };
        }
        return { kind: "audio", transcribed_text: transcribed.text, original_url: audioInfo.url };
      }
    } catch (err) {
      console.warn("[Sparkbot] audio transcription failed:", err instanceof Error ? err.message : err);
    }
  }

  const attachments = extractMediaAttachments(body);

  // Fix Pedro 2026-05-19: detecta documento "fantasma" — body é só o filename
  // (ex: "planilha.csv") + contentType text/plain + SEM URL de mídia em
  // lugar nenhum (nem webhook nem API GHL). Acontece quando documento chega
  // via WhatsApp Business API da Meta com a conta em estado problemático
  // (locked/sem permissão de media), ou canal que não baixa o binário.
  //
  // Em vez de virar texto (filename) e o LLM tentar analyze_tabular_data e
  // falhar com "Não consegui ler", devolve mensagem CLARA pro rep com
  // alternativas. Detecção: body bate padrão de filename de doc/planilha,
  // contentType não-rico, e zero attachments extraídos.
  if (attachments.length === 0) {
    const bodyText = String(body.body || body.message || "").trim();
    const ctype = String(body.contentType || "").toLowerCase();
    const isFilenameOnly =
      /^[\w\s().\-]+\.(csv|xlsx?|pdf|docx?)$/i.test(bodyText) &&
      bodyText.length < 120 &&
      (ctype === "text/plain" || ctype === "");
    if (isFilenameOnly) {
      console.warn(
        `[Sparkbot] DOC SEM URL: body="${bodyText}" ctype="${ctype}" — arquivo não veio do canal (Meta locked / sem media). Avisa rep.`,
      );
      return {
        kind: "text",
        text:
          `__FILE_ERROR__:Recebi o nome do arquivo (*${bodyText}*) mas o conteúdo não chegou junto — ` +
          `isso costuma rolar quando o WhatsApp não anexa o arquivo direito.\n\n` +
          `Tenta uma destas:\n` +
          `• *Reenvia* o arquivo (às vezes na 2ª vez vai)\n` +
          `• *Cola os dados aqui* como texto (nome e telefone, um por linha)\n` +
          `• Manda uma *foto/print* da planilha`,
      };
    }
  }

  if (attachments.length > 0) {
    // Pega o PRIMEIRO anexo suportado e processa via file-processor unificado
    // (mesmo parser que o painel web usa). Imagem/PDF/CSV/XLSX viram RepInput
    // do tipo apropriado.
    for (const att of attachments) {
      try {
        // SSRF guard (fix CRITICAL stress test 2026-05-03):
        // attachment.url vem de webhook GHL que pode ser forjado se
        // GHL_WEBHOOK_SECRET não for strict em prod. Allowlist de hosts.
        const urlVal = validateExternalUrl(att.url);
        if (!urlVal.ok) {
          console.warn(`[Sparkbot] SSRF guard rejected attachment URL: ${urlVal.reason} (${att.url.slice(0, 80)})`);
          continue;
        }
        const res = await fetch(att.url, { signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
          console.warn(`[Sparkbot] failed to fetch attachment ${att.url}: ${res.status}`);
          continue;
        }
        const buffer = Buffer.from(await res.arrayBuffer());
        const { processFile } = await import("../file-processor");
        const result = await processFile({
          buffer,
          mime: att.contentType,
          filename: att.fileName || "arquivo",
        });

        // Anexa caption do messageBody (rep pode mandar texto + arquivo)
        const repInput = result.repInput;
        if (repInput.kind === "image") {
          return { ...repInput, caption: messageBody || undefined };
        }
        if (repInput.kind === "document") {
          return { ...repInput, caption: messageBody || undefined };
        }
        if (repInput.kind === "tabular") {
          return { ...repInput, caption: messageBody || undefined };
        }
      } catch (err) {
        console.warn(
          "[Sparkbot] file processing failed for", att.url, ":",
          err instanceof Error ? err.message : err,
        );
        // Fix Track 8 H-MM-2 + H-MM-6 (review 2026-05-05): se erro tem
        // código user-friendly (HEIC, PDF vazio), propaga PRO REP em vez
        // de silenciar e responder texto. Antes: bot respondia só com
        // base no caption text — rep pensava que bot leu o arquivo mas
        // não, confusão.
        const code = (err as { code?: string })?.code;
        const userFacingCodes = ["heic_not_supported", "pdf_empty", "file_too_large"];
        if (code && userFacingCodes.includes(code)) {
          // Devolve como text especial pro processor montar resposta direta
          return {
            kind: "text",
            text: `__FILE_ERROR__:${err instanceof Error ? err.message : "Falha processando arquivo."}`,
          };
        }
        // Tenta próximo anexo
      }
    }
  }

  return { kind: "text", text: messageBody };
}
