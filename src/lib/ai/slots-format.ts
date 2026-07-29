/**
 * Formata os free-slots do GHL pro prompt do agente (sales/recruitment/custom).
 *
 * F48 (Fix bug observado em prod 2026-06-04 — smoke test Five Star Ricos):
 * antes, queue-processor E a rota de teste truncavam cada dia em `slice(0, 8)`.
 * Calendários com muitos horários (esse tinha ~20/dia, 9h–23h a cada 30min) só
 * expunham os 8 primeiros (manhã + início de tarde). Resultado: quando o lead
 * perguntava "qual o último horário?" ou "tem 10 da noite?", o agente respondia
 * com base na lista CORTADA e MENTIA ("o último é 3:30 PM") apesar de haver slot
 * até 23h. Não era alucinação do modelo — era dado truncado pelo sistema.
 *
 * Agora: mostra até `maxPerDay` horários por dia e, se truncar, SEMPRE inclui o
 * ÚLTIMO horário real do dia (com marcador "…"), pra a pergunta "qual o último?"
 * ser sempre respondível. Custo de token é baixo (~300 tok p/ uma semana cheia).
 *
 * Centralizado aqui pra garantir paridade entre o runtime (queue-processor) e o
 * test chat — antes a lógica era duplicada e divergia.
 */
export function formatAvailableSlots(
  slotsResp: Record<string, unknown>,
  tz: string,
  maxPerDay = 30,
): string {
  const lines: string[] = [];
  for (const [key, value] of Object.entries(slotsResp)) {
    if (key === "traceId" || !value) continue;

    let slots: string[] = [];
    if (typeof value === "object" && value !== null) {
      const v = value as Record<string, unknown>;
      if (Array.isArray(v.slots)) slots = v.slots as string[];
      else if (Array.isArray(value)) slots = value as string[];
    }
    if (slots.length === 0) continue;

    const dateFormatted = new Date(key + "T12:00:00").toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric",
      timeZone: tz,
    });
    const fmt = (s: string) =>
      new Date(s).toLocaleTimeString("en-US", {
        hour: "numeric",
        minute: "2-digit",
        hour12: true,
        timeZone: tz,
      });

    let body: string;
    if (slots.length <= maxPerDay) {
      body = slots.map(fmt).join(", ");
    } else {
      // Trunca o miolo mas SEMPRE mostra o último horário real do dia.
      const head = slots.slice(0, maxPerDay - 1).map(fmt);
      body = `${head.join(", ")}, … (último: ${fmt(slots[slots.length - 1])})`;
    }
    lines.push(`${dateFormatted}: ${body}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// H58 (caso Jussara 2026-07-26) — expediente
// ---------------------------------------------------------------------------

import { horaLocal, EXPEDIENTE_PADRAO, type JanelaExpediente } from "@/lib/ai/booking-guard";

/**
 * Corta os horários fora do expediente ANTES de o modelo ver.
 *
 * Por que na origem: o calendário do Spark Leads não conhece o expediente da
 * agente (aceita 8h numa operação que atende 9h-21h), então o free-slots devolve
 * 8h e o modelo oferece de boa fé — foi assim que a Valeria recebeu "segunda às
 * 8h da manhã" e a Lena acabou marcada 28/07 às 08:00 (e sumiu). Instrução de
 * prompt não conserta dado errado na entrada; filtrar aqui, sim: o modelo passa
 * a não ter como oferecer fora da janela.
 *
 * Efeito colateral desejado: a lista que alimenta o slot-guard do booking também
 * fica limitada ao expediente, então um start_time às 8h nem chega a ser aceito.
 *
 * Dia que fica sem nenhum horário é REMOVIDO (dia vazio no prompt sugeriria
 * agenda cheia, que é outra mentira).
 */
export function filterSlotsToBusinessHours(
  slotsResp: Record<string, unknown>,
  tz: string,
  janela: JanelaExpediente = EXPEDIENTE_PADRAO,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(slotsResp)) {
    if (key === "traceId") {
      out[key] = value;
      continue;
    }
    if (!value || typeof value !== "object") continue;
    const v = value as Record<string, unknown>;
    const slots = Array.isArray(v.slots)
      ? (v.slots as string[])
      : Array.isArray(value)
        ? (value as string[])
        : [];
    const dentro = slots.filter((s) => {
      const h = horaLocal(s, tz);
      // Hora ilegível → mantém (fail-open, mesma postura dos outros guardas).
      return h === null || (h >= janela.inicio && h <= janela.fim);
    });
    if (dentro.length > 0) out[key] = { ...v, slots: dentro };
  }
  return out;
}
