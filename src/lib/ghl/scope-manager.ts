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

    // Upsert: marca a location como sem cobertura completa de escopo.
    // missing_scopes acumula as ações que falharam (array dedup feito pela query abaixo).
    const { error: upsertError } = await supabase
      .from("location_scope_coverage")
      .upsert(
        {
          location_id: locationId,
          company_id: companyId ?? null,
          covered: false,
          missing_scopes: [action],
          last_action: action,
          detail: detail.slice(0, 500),
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        {
          onConflict: "location_id",
          // Merge: não substitui missing_scopes — concatena com array_append no DB.
          // Como supabase-js upsert não suporta array_append diretamente,
          // usamos uma segunda update pra appender sem duplicar.
          ignoreDuplicates: false,
        },
      );

    if (upsertError) {
      // Tenta update parcial: só atualiza campos de status sem tocar missing_scopes
      await supabase
        .from("location_scope_coverage")
        .update({
          covered: false,
          last_action: action,
          detail: detail.slice(0, 500),
          last_checked_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .eq("location_id", locationId);
    }

    // Signal acionável pro painel admin.
    const title =
      code === "unsupported_endpoint"
        ? `Location ${locationId}: endpoint não suportado pelo IAM (${action})`
        : `Location ${locationId}: precisa reconectar ao Spark Leads (${action})`;

    recordSignalAsync({
      type: "error",
      severity: "high",
      source: "bot_auto",
      title,
      description:
        code === "unsupported_endpoint"
          ? `Ação '${action}' retornou erro permanente de IAM. O endpoint não está disponível com o token OAuth atual. Admin deve verificar os escopos do app GHL Marketplace ou aguardar suporte GHL.`
          : `Ação '${action}' retornou 403 — token da location não tem acesso. Admin deve reconectar a integração Spark Leads para esta location (refazer o fluxo OAuth).`,
      metadata: {
        location_id: locationId,
        company_id: companyId,
        action,
        code,
        detail: detail.slice(0, 300),
      },
    });
  } catch (err) {
    // Não-fatal: problema de governança não deve quebrar o fluxo do rep.
    console.warn("[scope-manager] flagScopeIssue falhou (non-fatal):", err instanceof Error ? err.message : err);
  }
}
