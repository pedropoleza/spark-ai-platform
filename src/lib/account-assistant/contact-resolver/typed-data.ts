/**
 * O que o rep DIGITOU na conversa (H108, caso Ana Gusmão #456, 2026-10-26).
 *
 * A Ana pediu "marca com o Filipe Sonoplasta", a busca voltou 3 candidatos com
 * confiança baixa, e ela respondeu com o telefone do Filipe: "+1 (843) 602-4037".
 * No turno seguinte o bot chamou create_contact com +1 954-818-9811, o telefone
 * do PRIMEIRO candidato da busca (outra pessoa). Quem trava isso é código: o
 * telefone ou e-mail que o rep escreveu vence o que veio de um contato do CRM.
 *
 * Funções puras. A fonte é `ctx.repMessage`, que o processor monta com as últimas
 * falas do rep já sem o eco de menu (`stripOptionEcho` por mensagem).
 */
import { stripOptionEcho } from "../weekday-guard";
import { phoneDigits } from "./normalize";

/** Uma sequência com cara de telefone: dígitos com espaço, ponto, hífen e parênteses. */
const TELEFONE_RE = /\+?\d[\d\s().-]{7,}\d/g;
const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;

/** Tira eco de menu linha a linha, sem cortar as falas seguintes. */
function semEco(texto: string | null | undefined): string {
  return String(texto || "")
    .split("\n")
    .map((l) => stripOptionEcho(l))
    .join("\n");
}

/**
 * Telefones que aparecem na fala do rep, sem repetição: "+<dígitos>" quando o rep
 * escreveu com "+", só os dígitos quando não escreveu. Fica com 10 a 15 dígitos:
 * abaixo disso é data, hora, valor ou documento curto.
 */
export function extractTypedPhones(texto: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of semEco(texto).matchAll(TELEFONE_RE)) {
    const d = phoneDigits(m[0]);
    if (d.length >= 10 && d.length <= 15) out.add(m[0].trim().startsWith("+") ? `+${d}` : d);
  }
  return [...out];
}

/** E-mails que aparecem na fala do rep, em minúsculas, sem repetição. */
export function extractTypedEmails(texto: string | null | undefined): string[] {
  const out = new Set<string>();
  for (const m of semEco(texto).matchAll(EMAIL_RE)) out.add(m[0].toLowerCase());
  return [...out];
}

/**
 * Mesmo telefone? Compara os últimos 10 dígitos (absorve +1, +55 e formatação).
 * Número com menos de 10 dígitos só bate se for idêntico.
 */
export function mesmoTelefone(a: unknown, b: unknown): boolean {
  const da = phoneDigits(a);
  const db = phoneDigits(b);
  if (!da || !db) return false;
  if (da.length < 10 || db.length < 10) return da === db;
  return da.slice(-10) === db.slice(-10);
}
