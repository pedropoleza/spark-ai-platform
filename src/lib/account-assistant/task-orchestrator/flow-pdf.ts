/**
 * Geração de PDF do fluxo (Pedro 2026-06-20). Plano: EXECUCAO.md (F4).
 *
 * pdf-lib (puro-JS, fontes-padrão embutidas) — escolhido por ser à prova de
 * serverless/Vercel: sem leitura de fonte em runtime, sem React/layout-engine
 * pra bundlar. Helvetica padrão cobre acentos PT-BR (WinAnsi); pdf-lib LANÇA em
 * char fora do WinAnsi (emoji), então sanitizamos antes de desenhar.
 *
 * Retorna a URL REAL (assinada) do arquivo no bucket agent-media — nunca "gerei".
 */
import { PDFDocument, StandardFonts, rgb, type PDFFont } from "pdf-lib";
import { createAdminClient } from "@/lib/supabase/admin";
import type { DraftSnapshot } from "./core";

const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;
const MARGIN = 50;
const MAX_W = PAGE_W - MARGIN * 2;

/** Remove chars fora do WinAnsi (emoji etc) que fariam o pdf-lib lançar. Mantém acentos. */
export function sanitizeForPdf(s: string): string {
  return (s || "")
    .replace(/\r\n/g, "\n")
    .replace(/[^\t\n\r\x20-\x7E\xA0-\xFF]/g, ""); // ASCII imprimível + Latin-1 (acentos)
}

/** Quebra em linhas que cabem em maxW; quebra HARD palavras maiores que a largura (URLs). */
function wrapLines(text: string, font: PDFFont, size: number, maxW: number): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    if (para.trim() === "") { out.push(""); continue; }
    let line = "";
    for (const word of para.split(/\s+/)) {
      const candidate = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= maxW) {
        line = candidate;
        continue;
      }
      if (line) { out.push(line); line = ""; }
      // palavra sozinha maior que a largura (ex: URL longa) → quebra por char
      if (font.widthOfTextAtSize(word, size) > maxW) {
        let chunk = "";
        for (const ch of word) {
          if (font.widthOfTextAtSize(chunk + ch, size) > maxW) { out.push(chunk); chunk = ch; }
          else chunk += ch;
        }
        line = chunk;
      } else {
        line = word;
      }
    }
    if (line) out.push(line);
  }
  return out;
}

/** Renderiza o snapshot do fluxo em PDF (1 bloco por passo, paginação automática). */
export async function renderFlowPdf(snapshot: DraftSnapshot): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const gray = rgb(0.4, 0.4, 0.4);
  const blue = rgb(0.09, 0.46, 0.95);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const ensure = (need: number) => {
    if (y - need < MARGIN) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; }
  };
  const draw = (text: string, f: PDFFont, size: number, color = rgb(0, 0, 0)) => {
    for (const line of wrapLines(sanitizeForPdf(text), f, size, MAX_W)) {
      ensure(size + 4);
      page.drawText(line, { x: MARGIN, y: y - size, size, font: f, color });
      y -= size + 4;
    }
  };

  draw(snapshot.title || "Fluxo de follow-up", bold, 18);
  y -= 4;
  const tgt =
    snapshot.target.contact_name || snapshot.target.contact_phone || snapshot.target.tag || "(alvo a definir)";
  draw(`Contato: ${tgt}  -  ${snapshot.step_count} mensagem(ns)  -  status: ${snapshot.status}`, font, 10, gray);
  y -= 14;

  for (const s of snapshot.steps) {
    ensure(46);
    draw(`Passo ${s.n}  -  ${s.day_label} as ${s.send_time}`, bold, 12);
    if (s.has_media && s.media_url) draw(`[midia] ${s.media_url}`, font, 9, blue);
    draw(s.message_text || "(sem texto)", font, 11);
    y -= 10;
  }

  draw(`Gerado pelo SparkBot - ${snapshot.step_count} passos`, font, 8, gray);
  return doc.save();
}

export type FlowPdfResult =
  | { ok: true; signed_url: string; path: string; expires_in: number; bytes: number }
  | { ok: false; error: string };

/** Gera o PDF, sobe no bucket agent-media e devolve a URL assinada REAL. */
export async function generateAndUploadFlowPdf(
  snapshot: DraftSnapshot,
  locationId: string,
  repId: string,
): Promise<FlowPdfResult> {
  let bytes: Uint8Array;
  try {
    bytes = await renderFlowPdf(snapshot);
  } catch (e) {
    return { ok: false, error: `Falha ao gerar o PDF: ${e instanceof Error ? e.message : String(e)}` };
  }
  const supabase = createAdminClient();
  const path = `${locationId}/${repId}/${crypto.randomUUID()}.pdf`;
  const { error: upErr } = await supabase.storage
    .from("agent-media")
    .upload(path, Buffer.from(bytes), { contentType: "application/pdf", upsert: false });
  if (upErr) return { ok: false, error: `Falha ao salvar o PDF no storage: ${upErr.message}` };

  const TTL = 3600; // 1h — folga pra entrega não expirar (decisão F4)
  const { data: signed, error: sErr } = await supabase.storage.from("agent-media").createSignedUrl(path, TTL);
  if (sErr || !signed?.signedUrl) return { ok: false, error: `PDF salvo mas falhou gerar o link: ${sErr?.message}` };

  return { ok: true, signed_url: signed.signedUrl, path, expires_in: TTL, bytes: bytes.length };
}
