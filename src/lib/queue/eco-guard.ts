/**
 * Eco robótico no começo da resposta (H119, revisão adversarial 04/11/2026,
 * NAT-20: "Florida, perfeito!" em 14 de 14 conversas da Alves Cury).
 *
 * O lead responde curto ("Florida", "Orlando", "motorista") e a IA abre
 * repetindo a palavra dele + um elogio vazio ("Florida, ótimo." / "Orlando,
 * boa!"). Regra de prompt não segurou (o próprio prompt ensinava com o exemplo
 * "Orlando, ótimo!"). Aqui o prefixo sai: a resposta começa direto na próxima
 * frase. Só quando a mensagem do lead é curta (até 4 palavras) e a 1ª bolha
 * começa com ela + interjeição. Puro e testável.
 */

function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const INTERJEICAO =
  /^(perfeito|otimo|ótimo|boa|que bom|legal|show|maravilha|excelente|bacana|entendi|certo|beleza|top|massa|que otimo|que ótimo|lindo|interessante)\b/i;

export interface EcoGuardResult {
  messages: string[];
  removido: string | null;
}

export function tirarEcoDoInicio(bolhas: string[], mensagemDoLead: string): EcoGuardResult {
  const lead = norm(mensagemDoLead || "");
  if (!lead || lead.split(" ").length > 4 || bolhas.length === 0) return { messages: bolhas, removido: null };
  const primeira = bolhas[0];
  // "Florida, ótimo." / "Orlando, boa! " / "Motorista de aplicativo, que bom."
  const m = /^\s*([^,.!?]{2,60})\s*[,!.]\s*([^.!?]{0,40}?)([.!?]+|,)\s*/u.exec(primeira);
  if (!m) return { messages: bolhas, removido: null };
  const eco = norm(m[1]);
  const resto = m[2].trim();
  // eco = a(s) palavra(s) do lead: igual, ou contida inteira na mensagem curta dele ("moro em Orlando" → "Orlando")
  const contida = eco.length >= 3 && ` ${lead} `.includes(` ${eco} `);
  if (eco !== lead && !contida && !(lead.length >= 4 && (eco.startsWith(lead) || lead.startsWith(eco)))) return { messages: bolhas, removido: null };
  // depois do eco, só interjeição (ou nada) até o fim da frase
  const interj = resto === "" ? "" : norm(resto);
  if (interj && !INTERJEICAO.test(interj)) return { messages: bolhas, removido: null };
  if (!interj && m[3] !== "!" && m[3] !== ".") return { messages: bolhas, removido: null };
  let sobra = primeira.slice(m[0].length).trim();
  if (!sobra) {
    // a bolha era só o eco: sai inteira (se houver outra bolha)
    if (bolhas.length > 1) return { messages: bolhas.slice(1), removido: primeira.trim() };
    return { messages: bolhas, removido: null };
  }
  sobra = sobra.replace(/^(e\s+)/i, (x) => x); // "E hoje, você..." fica como está
  sobra = sobra[0].toUpperCase() + sobra.slice(1);
  return { messages: [sobra, ...bolhas.slice(1)], removido: m[0].trim() };
}
