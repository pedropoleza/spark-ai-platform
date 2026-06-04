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
