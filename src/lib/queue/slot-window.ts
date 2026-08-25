/**
 * H80 (caso Marina/Sandra 2026-08-25): janela de free-slots configurável por
 * agente. Agenda esparsa (~2 encontros/semana) com janela fixa de 7d deixava
 * "semana que vem" fora da lista (1 slot visível vs 4 em 14d, medido no
 * calendário real da Marina) → slot-guard bloqueava ou a IA prometia "o time
 * te chama no WhatsApp" (callback humano que ninguém pediu).
 *
 * NULL/ausente/inválido = 7 (comportamento antigo; frota intacta).
 * Teto 31: o free-slots do Spark Leads recusa range acima de 31 dias
 * ("Date range cannot be more than 31 days", medido em prod 25/08).
 */
export function slotWindowDays(
  config: { slot_window_days?: number | null } | null | undefined,
): number {
  const v = config?.slot_window_days;
  return typeof v === "number" && Number.isFinite(v) && v >= 1 && v <= 31
    ? Math.floor(v)
    : 7;
}
