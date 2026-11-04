/**
 * Link repetido (H118, caso Bruno/vídeo da carreira, laboratório de 03/11/2026).
 *
 * As instruções mandam o link do vídeo "no máximo 1 vez a cada 2 respostas",
 * e no teste o link saiu em 3 respostas seguidas. Regra de prompt sobre CONTAR
 * envios falha; contar é com o código. Se a resposta traz um link que a IA já
 * mandou em uma das 2 últimas respostas, a frase com o link sai (o link
 * continua lá em cima na conversa). Exceção: o lead pediu o link de novo.
 *
 * Puro e testável.
 */

const RE_URL = /https?:\/\/[^\s)]+/gi;

function urls(texto: string): string[] {
  return (texto.match(RE_URL) || []).map((u) => u.replace(/[.,;:!?]+$/, "").toLowerCase());
}

/** O lead pediu o link/vídeo de novo ou disse que não abriu? */
export function leadPediuLink(mensagemDoLead: string): boolean {
  return /\b(link|v[íi]deo)\b[^.?!]*\b(de novo|novamente|outra vez|n[ãa]o (abr|carreg|cheg|funcion|ach|vi)|manda|envia|cad[êe]|onde)|\b(manda|envia|reenvia|repete)\b[^.?!]*\b(link|v[íi]deo)\b|\bn[ãa]o (abriu|carregou|chegou|funcionou|achei)\b/iu.test(
    mensagemDoLead || "",
  );
}

export interface LinkRepeatResult {
  messages: string[];
  removidos: string[];
}

export function tirarLinkRepetido(
  bolhas: string[],
  ultimasRespostasDaIa: string[],
  mensagemDoLead: string,
): LinkRepeatResult {
  const recentes = new Set(ultimasRespostasDaIa.slice(-2).flatMap(urls));
  if (recentes.size === 0 || leadPediuLink(mensagemDoLead)) return { messages: bolhas, removidos: [] };
  const removidos: string[] = [];
  const out = bolhas
    .map((b) => {
      const repetidos = urls(b).filter((u) => recentes.has(u));
      if (repetidos.length === 0) return b;
      removidos.push(...repetidos);
      // tira a FRASE que carrega o link; o resto da bolha fica
      const frases = b.split(/(?<=[.!?])\s+/);
      return frases
        .filter((f) => !urls(f).some((u) => recentes.has(u)))
        .join(" ")
        .trim();
    })
    .filter((b) => b.length > 0);
  return { messages: out.length > 0 ? out : bolhas, removidos: out.length > 0 ? removidos : [] };
}
