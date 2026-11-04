/**
 * Meta-linguagem no texto do lead (H120, laboratório da Alves Cury 04/11/2026).
 *
 * "O sistema ainda não registrou a visualização do vídeo": a IA explica a
 * engrenagem em vez de falar com a pessoa. As instruções proíbem "sistema",
 * "registro" e "etiqueta", e a regra vazou em produção e no laboratório (o
 * próprio texto de runtime da agenda travada usava "o sistema registra").
 * Aqui a FRASE que fala da engrenagem sai inteira; o resto da bolha fica.
 * Padrões estreitos, para não pegar "sou registrada como auxiliar". Puro.
 */

const PADROES: RegExp[] = [
  /(?<![\p{L}])(o\s+)?sistema(?![\p{L}])[^.!?\n]*(registr|mostr|apont|aparec|identific|confirm|consta|atualiz|liber)/iu,
  /(?<![\p{L}])n[ãa]o\s+(foi\s+)?registr/iu,
  /(?<![\p{L}])registr\w*\s+(a\s+|o\s+)?(sua\s+)?(visualiza|v[íi]deo|que\s+voc[eê]\s+(viu|assistiu))/iu,
  /(?<![\p{L}])ainda\s+n[ãa]o\s+(apareceu|aparece|consta)\s+(aqui|pra\s+mim|para\s+mim)/iu,
  /(?<![\p{L}])do\s+meu\s+lado(?![\p{L}])/iu,
  /(?<![\p{L}])(etiqueta|tag)s?(?![\p{L}])/iu,
];

export interface MetaGuardResult {
  messages: string[];
  removidas: string[];
}

export function tirarMetaLinguagem(bolhas: string[]): MetaGuardResult {
  const removidas: string[] = [];
  const out = bolhas
    .map((b) => {
      const frases = b.split(/(?<=[.!?])\s+/);
      const ficam = frases.filter((f) => {
        const ruim = PADROES.some((p) => p.test(f));
        if (ruim) removidas.push(f.trim());
        return !ruim;
      });
      return ficam.join(" ").trim();
    })
    .filter((b) => b.length > 0);
  if (out.length === 0) return { messages: bolhas, removidas: [] };
  return { messages: out, removidas };
}
