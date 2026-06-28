/**
 * Detector de "contato-grupo" (H46, 2026-06-28). Fonte ÚNICA da verdade.
 *
 * Descoberta-chave (GET ao vivo): um grupo de WhatsApp É um contato normal no
 * Spark Leads/GHL — o `email` carrega o JID do grupo (`<id>@g.us`), o nome
 * termina em "GRUPO", e o envio é pela rota de contato (`/conversations/messages`).
 * Este módulo RECONHECE quais contatos são grupos pra tratá-los com regras
 * especiais (pular opt-out/DND, não normalizar phone, falar pelo nome).
 *
 * PURO, sem I/O, 100% testável. Anti-falso-positivo: SÓ o email `@g.us` é critério
 * de SEGURANÇA (decide pular opt-out/DND e habilita o ENVIO via JID). Nome/tag são
 * sinais fracos de DESCOBERTA/listagem, nunca de classificação de segurança.
 */
import { deburr } from "@/lib/account-assistant/contact-resolver/normalize";

export type GroupConfidence = "certain" | "likely" | "weak";
export type GroupReason = "email_jid" | "name_suffix" | "tag" | "none";

export interface GroupContactSignal {
  /** true só quando há sinal forte de grupo (email JID, ou nome-sufixo). */
  isGroup: boolean;
  /** JID normalizado (lower) validado `@g.us`, ou null se não veio do email. NULL = NÃO disparável. */
  jid: string | null;
  confidence: GroupConfidence;
  reason: GroupReason;
}

export interface DetectableContact {
  email?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  name?: string | null;
  contactName?: string | null;
  tags?: Array<string | { name?: string }> | null;
}

// JID de grupo: dígitos/hífen/ponto/underscore + "@g.us" no FIM (âncora $ barra
// "x@g.us.evil.com"). DM individual é "@s.whatsapp.net"/"@c.us" → não casa.
const GROUP_JID_RE = /^[\w.-]+@g\.us$/i;

/** Extrai+valida o JID do grupo a partir do email. null se não for `@g.us`. */
export function extractGroupJid(email: string | null | undefined): string | null {
  if (!email) return null;
  const e = String(email).trim().toLowerCase();
  return GROUP_JID_RE.test(e) ? e : null;
}

/**
 * Critério de SEGURANÇA (S1): SÓ o email `@g.us` decide se um contato é tratado
 * como grupo (pular opt-out/DND, não normalizar phone). Nome/tag NÃO entram aqui —
 * um contato-pessoa com sobrenome "Grupo" NÃO pode pular opt-out.
 */
export function isGroupContact(contact: { email?: string | null } | null | undefined): boolean {
  return extractGroupJid(contact?.email) !== null;
}

function fullName(contact: DetectableContact): string {
  return [contact.contactName, contact.name, contact.firstName, contact.lastName]
    .filter((v): v is string => typeof v === "string" && v.trim() !== "")
    .join(" ");
}

function tagStrings(contact: DetectableContact): string[] {
  if (!Array.isArray(contact.tags)) return [];
  return contact.tags
    .map((t) => (typeof t === "string" ? t : t?.name || ""))
    .filter((t): t is string => !!t);
}

/**
 * Classifica um contato. Precedência (curto-circuita na 1ª que casa):
 *  1. email `@g.us` → certain, jid=email, reason=email_jid (ÚNICO confiável p/ ENVIO).
 *  2. nome termina em "grupo"/"grupos" → likely, jid=null (só listagem; não disparável sem JID).
 *  3. tag em groupTagHints → weak, isGroup=FALSE (filtro de busca, exige co-sinal p/ virar grupo).
 */
export function detectGroupContact(
  contact: DetectableContact | null | undefined,
  opts?: { groupTagHints?: string[] },
): GroupContactSignal {
  if (!contact) return { isGroup: false, jid: null, confidence: "weak", reason: "none" };

  const jid = extractGroupJid(contact.email);
  if (jid) return { isGroup: true, jid, confidence: "certain", reason: "email_jid" };

  // \b antes de "grupo" evita casar "meugrupo"; $ exige sufixo.
  if (/\bgrupos?$/.test(deburr(fullName(contact)))) {
    return { isGroup: true, jid: null, confidence: "likely", reason: "name_suffix" };
  }

  const hints = (opts?.groupTagHints || []).map((t) => deburr(t)).filter(Boolean);
  if (hints.length) {
    const tags = tagStrings(contact).map((t) => deburr(t));
    if (tags.some((t) => hints.some((h) => t.includes(h)))) {
      return { isGroup: false, jid: null, confidence: "weak", reason: "tag" };
    }
  }

  return { isGroup: false, jid: null, confidence: "weak", reason: "none" };
}
