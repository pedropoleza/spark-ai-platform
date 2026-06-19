/**
 * Advisor de spam pra campanha de grupo (Pedro 2026-06-18, copy aprovada).
 *
 * 100% DETERMINÍSTICO (regex em código, NÃO LLM-call) — barato, previsível,
 * testável. Só SUGERE reescrita (warning); bloqueio DURO só em score extremo
 * (combo de promessa financeira garantida + urgência + link/spam clássico), que
 * é exatamente o padrão que derruba números no WhatsApp.
 *
 * Categorias e gatilhos: _planning/group-campaigns-whatsapp/COPY.md §4.
 */

export type SpamLevel = "low" | "medium" | "high" | "extreme";

export interface SpamHit {
  category: string;
  snippet: string;
}

export interface SpamScore {
  score: number;
  level: SpamLevel;
  hits: SpamHit[];
  /** true se o nível exige bloqueio duro (não só warning). */
  block: boolean;
}

/** lowercase + sem acento (mantém %, dígitos, $). */
function norm(text: string): string {
  return (text || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}

interface Category {
  key: string;
  weight: number;
  patterns: RegExp[];
}

const CATEGORIES: Category[] = [
  {
    key: "promessa_retorno_garantido",
    weight: 3,
    patterns: [
      /\brende\s+\d+\s*%/,
      /\b(retorno|lucro|ganho)\s+garantid/,
      /\d+\s*%\s*(ao|por)\s*(mes|ano|dia)/,
      /\bretira\s+a\s+qualquer\s+momento/,
      /\b(sem\s+risco|risco\s+zero)\b/,
    ],
  },
  {
    key: "renda_facil_esquema",
    weight: 3,
    patterns: [
      /\brenda\s+extra\s+garantid/,
      /\bdinheiro\s+facil/,
      /\bfique\s+rico/,
      /\btrabalhe\s+de\s+casa\s+e\s+ganhe/,
      /\bganhe\s+ate\s+r?\$?\s*\d/,
      /\bmultiplique\s+seu\s+dinheiro/,
    ],
  },
  {
    key: "urgencia_escassez",
    weight: 2,
    patterns: [
      /\bultim[ao]s?\s+vagas?/,
      /\bso\s+hoje\b/,
      /\bagora\s+ou\s+nunca/,
      /\bultima\s+chance/,
      /\bvagas?\s+limitad/,
    ],
  },
  {
    key: "spam_classico",
    weight: 2,
    patterns: [/\bclique\s+(aqui|no\s+link)/, /\bchama\s+no\s+zap/, /\bme\s+chama\s+no\s+whats/],
  },
];

/** Conta links http(s) no texto. >2 = gatilho de spam clássico. */
function countLinks(text: string): number {
  const m = text.match(/https?:\/\/\S+/gi);
  return m ? m.length : 0;
}

/** Razão de letras MAIÚSCULAS (no texto original, ≥10 letras pra contar). */
function capsRatio(text: string): number {
  const letters = (text || "").replace(/[^a-zA-ZÀ-ÿ]/g, "");
  if (letters.length < 10) return 0;
  const upper = letters.replace(/[^A-ZÀ-Þ]/g, "").length;
  return upper / letters.length;
}

export function scoreSpamRisk(text: string): SpamScore {
  const n = norm(text);
  const hits: SpamHit[] = [];
  let score = 0;

  for (const cat of CATEGORIES) {
    for (const re of cat.patterns) {
      const m = n.match(re);
      if (m) {
        hits.push({ category: cat.key, snippet: m[0] });
        score += cat.weight;
        break; // 1 hit por categoria (não soma várias do mesmo tipo)
      }
    }
  }

  // Spam clássico extra: muitos links.
  if (countLinks(text) > 2) {
    if (!hits.some((h) => h.category === "spam_classico")) {
      hits.push({ category: "spam_classico", snippet: ">2 links" });
      score += 2;
    }
  }

  // CAPS/pontuação gritada (peso baixo).
  if (capsRatio(text) > 0.4 || /!{3,}/.test(text)) {
    hits.push({ category: "caps_pontuacao", snippet: capsRatio(text) > 0.4 ? "muito CAPS" : "!!!" });
    score += 1;
  }

  // Combo EXTREMO (bloqueio duro): promessa financeira garantida + urgência +
  // (link OU spam clássico). É o padrão que mais derruba número.
  const hasFinancial = hits.some(
    (h) => h.category === "promessa_retorno_garantido" || h.category === "renda_facil_esquema",
  );
  const hasUrgency = hits.some((h) => h.category === "urgencia_escassez");
  const hasSpamOrLink = hits.some((h) => h.category === "spam_classico") || countLinks(text) > 0;
  const extreme = hasFinancial && hasUrgency && hasSpamOrLink;

  let level: SpamLevel;
  if (extreme) level = "extreme";
  else if (score >= 5) level = "high";
  else if (score >= 2) level = "medium";
  else level = "low";

  return { score, level, hits, block: level === "extreme" };
}
