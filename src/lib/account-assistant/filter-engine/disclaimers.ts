/**
 * Filter Engine — disclaimer tier system (H28).
 *
 * Pedro 2026-05-15:
 *   "Threshold (Ponto 3): pode ser acima de 50 se forem contatos quentes;
 *    se for uma lista fria, pode ser menos."
 *   "Disclaimer: é importante, pois é a nossa forma de ficar seguro,
 *    então pode fazer como você achar melhor."
 *
 * Estratégia: bot DEVE perguntar "lista quente ou fria?" antes de
 * disparar bulk. Threshold de risk varia:
 *   - Lista QUENTE (rep confirma que contatos interagiram antes): risk
 *     disclaimer só dispara em > 50 contatos
 *   - Lista FRIA (rep não tem certeza OU não confirma): risk disclaimer
 *     em > 10 contatos (conservador — pequeno batch obrigatório)
 *
 * Sempre dispara:
 *   - lista_quente_required: confirma natureza da lista antes de mandar
 *
 * Bot DEVE exibir disclaimers em mensagens separadas (SPLITTER `---`),
 * pedir confirmação textual de CADA UM antes de avançar.
 */

export type DisclaimerKey =
  | "lista_quente_required"
  | "risk_high_volume_warm"   // > 50 quentes
  | "risk_any_volume_cold"    // > 10 frios
  | "first_bulk_ever";        // primeira vez do rep fazendo bulk

export interface Disclaimer {
  key: DisclaimerKey;
  /** Texto pro bot exibir EXATAMENTE pro rep */
  text: string;
  /** Flag de aceite que tool de schedule exige */
  required_flag: string;
  /** Severidade (impacta ordem de exibição) */
  severity: "info" | "warn" | "critical";
}

export interface DisclaimerInput {
  total_contacts: number;
  /** Rep já confirmou que é lista quente nesta turn/sessão? */
  list_temperature?: "warm" | "cold" | "unknown";
  /** Quantos bulks o rep já fez antes (futuro: detectar primeira vez) */
  prior_bulks_count?: number;
}

/**
 * Computa quais disclaimers devem ser exibidos pro rep ANTES do disparo.
 * Tool retorna esta lista no preview; bot itera + exibe + colhe confirms.
 */
export function computeDisclaimers(input: DisclaimerInput): Disclaimer[] {
  const list: Disclaimer[] = [];
  const total = input.total_contacts;
  const temp = input.list_temperature || "unknown";

  // 1) SEMPRE pergunte temperatura ANTES de risk-tier (a menos que rep já confirmou)
  if (temp === "unknown" && total >= 1) {
    list.push({
      key: "lista_quente_required",
      severity: "critical",
      required_flag: "confirmed_warm_list",
      text:
        "⚠️ Antes de disparar em massa, preciso saber: essa é uma *lista quente* (pessoas que JÁ INTERAGIRAM com você no WhatsApp antes — te mandaram msg, responderam algo, são clientes ativos)? " +
        "Ou é uma *lista fria* (números coletados de forma indireta, sem interação prévia)?\n\n" +
        "Disparar pra lista fria = risco alto de denúncia e *banimento do número WhatsApp*. Pra fria, o cap seguro é ~10 msgs/dia. Pra quente, dá pra mandar mais.\n\n" +
        "Me confirma: *quente* ou *fria*?",
    });
  }

  // 2) Lista cold + qualquer volume substancial → risk
  if (temp === "cold" && total > 10) {
    list.push({
      key: "risk_any_volume_cold",
      severity: "critical",
      required_flag: "confirmed_risk_cold",
      text:
        `⚠️ Você confirmou que é *lista fria*. Mandar ${total} mensagens pra contatos que não te conhecem = risco muito alto de bloqueio do WhatsApp. ` +
        `Recomendação forte: reduza pra ≤10 contatos por dia OU use email/SMS legítimo (E.164 verificado). ` +
        `Você entende o risco e quer prosseguir mesmo assim?`,
    });
  }

  // 3) Lista warm + alto volume → risk (mas threshold maior)
  if (temp === "warm" && total > 50) {
    list.push({
      key: "risk_high_volume_warm",
      severity: "warn",
      required_flag: "confirmed_risk_volume",
      text:
        `⚠️ ${total} contatos é volume alto mesmo em lista quente. Recomendação: ` +
        `(a) dispare em batches de 30-40 por janela de 1h, ` +
        `(b) verifique que o intervalo entre msgs é ≥90s, ` +
        `(c) considere fazer em 2-3 dias se possível. ` +
        `Você entende e quer prosseguir?`,
    });
  }

  // 4) Primeira vez do rep
  if (input.prior_bulks_count === 0 && total > 0) {
    list.push({
      key: "first_bulk_ever",
      severity: "info",
      required_flag: "confirmed_first_bulk",
      text:
        "ℹ️ Esse é seu *primeiro disparo em massa* pela SparkBot. Como funciona: " +
        "vou enfileirar as mensagens com intervalo de ~90s entre cada uma (anti-ban), " +
        "respeitando suas quiet hours, com variação leve em cada texto pra evitar pattern detection. " +
        "Você pode pausar/cancelar a qualquer momento. Tudo bem?",
    });
  }

  return list;
}

/**
 * Verifica se todos os flags requeridos foram passados no schedule.
 * Retorna lista de flags faltantes (pra erro pro bot).
 */
export function validateDisclaimerFlags(
  disclaimers: Disclaimer[],
  flags: Record<string, boolean>,
): string[] {
  const missing: string[] = [];
  for (const d of disclaimers) {
    if (flags[d.required_flag] !== true) missing.push(d.required_flag);
  }
  return missing;
}

/**
 * Helper pro bot formatar disclaimers numa única mensagem com SPLITTER.
 * Útil quando rep envia "sim" muito rápido — bot mostra os disclaimers
 * em sequência separados por `---`.
 */
export function formatDisclaimersForWhatsApp(disclaimers: Disclaimer[]): string {
  if (disclaimers.length === 0) return "";
  return disclaimers.map((d) => d.text).join("\n---\n");
}

/**
 * Combined disclaimer format (H31.2, Pedro 2026-05-15).
 * Quando há 2+ disclaimers, combina em CHECKLIST único pra rep dar
 * "tudo ok" como aceite global (reduz turns).
 */
export function formatDisclaimersChecklist(disclaimers: Disclaimer[]): string {
  if (disclaimers.length === 0) return "";
  if (disclaimers.length === 1) return disclaimers[0].text;

  const lines: string[] = ["*Antes de confirmar, preciso de OK em ${disclaimers.length} pontos:*", ""];
  for (let i = 0; i < disclaimers.length; i++) {
    const d = disclaimers[i];
    // Extrai 1 linha resumida do disclaimer pra checklist (não o texto longo)
    const summary = extractDisclaimerSummary(d);
    lines.push(`☐ *${i + 1}.* ${summary}`);
  }
  lines.push("");
  lines.push(`Responda *"tudo ok"* pra aceitar todos, ou aponte o que mudar.`);
  return lines.join("\n").replace("${disclaimers.length}", String(disclaimers.length));
}

function extractDisclaimerSummary(d: Disclaimer): string {
  // Cada key tem summary curto pré-definido
  const summaries: Record<DisclaimerKey, string> = {
    lista_quente_required:
      "Confirma que a lista é QUENTE (já interagiram com você antes)?",
    risk_high_volume_warm:
      "Volume alto (>50 contatos) — confirma que entende o risco?",
    risk_any_volume_cold:
      "Lista FRIA + volume alto = risco MUITO alto. Confirma mesmo assim?",
    first_bulk_ever:
      "Primeiro disparo seu pela SparkBot — confirma que entende o fluxo (intervalo 90s, pode pausar/cancelar)?",
  };
  return summaries[d.key] || d.text.split("\n")[0].slice(0, 100);
}
