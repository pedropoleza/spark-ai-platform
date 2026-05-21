/**
 * scope-manager.ts — Onda 2 (2026-05-20): governança de escopo GHL.
 *
 * Quando uma tool detecta erro de escopo (403) ou endpoint IAM não suportado
 * (5xx permanente), este módulo:
 *  1. Registra a cobertura de escopo da location em `location_scope_coverage`
 *     (covered:false) para o painel admin saber quais locations precisam
 *     reconectar / reconfigurar o app GHL.
 *  2. Emite um signal de severidade "high" no painel admin via recordSignalAsync,
 *     com título acionável ("Location precisa reconectar / endpoint não suportado").
 *
 * Design:
 *  - Não-fatal: todo erro interno é capturado e logado como warn.
 *  - Idempotente: upsert no DB por location_id (PK).
 *  - Fire-and-forget: chamado via .catch() no executeTool.
 */

import { createAdminClient } from "@/lib/supabase/admin";
import { recordSignalAsync } from "@/lib/admin-signals/recorder";

/**
 * Registra um problema de escopo/IAM pra uma location.
 *
 * @param locationId   ID da location GHL afetada.
 * @param companyId    ID da company GHL (pode ser null em contextos sem company).
 * @param action       Nome da tool/ação que falhou (ex: "delete_appointment").
 * @param code         Código de classificação: "unsupported_endpoint" | "scope_or_location".
 * @param detail       Mensagem de erro original (sanitizada antes de sair da types.ts).
 */
export async function flagScopeIssue(
  locationId: string,
  companyId: string | null,
  action: string,
  code: string,
  detail: string,
): Promise<void> {
  try {
    const supabase = createAdminClient();

    // ACUMULA as ações que falharam (fix 2026-05-21: o upsert antigo sobrescrevia
    // missing_scopes com [action] → nunca dava pra detectar padrão). Lê o atual,
    // faz union, regrava.
    const { data: existing } = await supabase
      .from("location_scope_coverage")
      .select("missing_scopes")
      .eq("location_id", locationId)
      .maybeSingle();
    const prevActions = Array.isArray(existing?.missing_scopes)
      ? (existing!.missing_scopes as string[])
      : [];
    const mergedActions = Array.from(new Set([...prevActions, action]));

    await supabase.from("location_scope_coverage").upsert(
      {
        location_id: locationId,
        company_id: companyId ?? null,
        covered: false,
        missing_scopes: mergedActions,
        last_action: action,
        detail: detail.slice(0, 500),
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "location_id" },
    );

    // Escalonamento (fix 2026-05-21): um 403 ISOLADO não é desconexão (caso
    // b1ttBRVEnm5joFvP2UXO — 1× remove_tag, location 100% funcional). Só grita
    // HIGH "reconectar" quando há PADRÃO: ≥3 ações DISTINTAS com 403 (desconexão
    // real derruba vários tools). 403 solto → medium "pontual" (investigar se recorre).
    const RECONNECT_THRESHOLD = 3;
    const baseMeta = {
      location_id: locationId,
      company_id: companyId,
      action,
      code,
      detail: detail.slice(0, 300),
    };

    if (code === "unsupported_endpoint") {
      recordSignalAsync({
        type: "error",
        severity: "high",
        source: "bot_auto",
        title: `Location ${locationId}: endpoint não suportado pelo IAM (${action})`,
        description: `Ação '${action}' retornou erro permanente de IAM. O endpoint não está disponível com o token OAuth atual. Admin deve verificar os escopos do app GHL Marketplace ou aguardar suporte GHL.`,
        metadata: baseMeta,
      });
    } else if (mergedActions.length >= RECONNECT_THRESHOLD) {
      recordSignalAsync({
        type: "error",
        severity: "high",
        source: "bot_auto",
        title: `Location ${locationId}: precisa reconectar ao Spark Leads (${mergedActions.length} ações com 403)`,
        description: `${mergedActions.length} ações distintas retornaram 403 nesta location (${mergedActions.join(", ")}). Padrão de DESCONEXÃO — admin deve reconectar a integração Spark Leads (refazer o fluxo OAuth).`,
        metadata: { ...baseMeta, failed_actions: mergedActions },
      });
    } else {
      // 403 pontual — NÃO alarma como "reconectar". Medium, pra triagem.
      recordSignalAsync({
        type: "error",
        severity: "medium",
        source: "bot_auto",
        title: `Location ${locationId}: 403 pontual em ${action}`,
        description: `Ação '${action}' retornou 403 (escopo/recurso pontual — pode ser recurso de outra location ou refresh momentâneo). Só vira "reconectar" se ≥${RECONNECT_THRESHOLD} ações distintas falharem. Detalhe: ${detail.slice(0, 200)}`,
        metadata: { ...baseMeta, distinct_failed: mergedActions.length },
      });
    }
  } catch (err) {
    // Não-fatal: problema de governança não deve quebrar o fluxo do rep.
    console.warn("[scope-manager] flagScopeIssue falhou (non-fatal):", err instanceof Error ? err.message : err);
  }
}
