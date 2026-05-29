/**
 * Targeting rules enforcement — F27 (Pedro 2026-05-28).
 *
 * Bug histórico: o wizard e o detail-view permitem configurar
 * `targeting_rules` (tag / custom_field / pipeline_stage) mas o
 * runtime NUNCA avaliava. Resultado: agente respondia a TODOS os
 * contatos da location, ignorando o filtro salvo. Esse módulo fecha
 * o gap — checa se o contato bate AS regras antes de responder.
 *
 * Combina com AND lógico (todas as regras precisam passar). Sem
 * regras = sempre OK (responde a todos, comportamento legado preservado).
 *
 * 3 tipos suportados:
 *  - tag: contato tem que ter A tag listada
 *  - custom_field: campo precisa ter o valor exato (ou qualquer valor se
 *    custom_field_value for vazio)
 *  - pipeline_stage: contato precisa ter opp na pipeline+stage
 *
 * Fail-OPEN em erro de fetch GHL: pior cenário = agente responde a
 * 1 contato que não devia (recuperável). Fail-closed = agente mudo
 * silencioso (UX ruim, gera ticket de suporte).
 */
import type { TargetingRule } from "@/types/agent";
import { GHLClient } from "@/lib/ghl/client";

export interface TargetingMatch {
  ok: boolean;
  reason?: string;
}

interface GhlContact {
  tags?: Array<string | { name?: string }>;
  customFields?: Array<{ id?: string; key?: string; value?: unknown }>;
  customField?: Array<{ id?: string; key?: string; value?: unknown }>;
}

interface GhlOpp {
  pipelineId?: string;
  pipelineStageId?: string;
  stageId?: string;
}

function extractTags(contact: GhlContact | null | undefined): string[] {
  if (!contact?.tags) return [];
  return contact.tags
    .map((t) => (typeof t === "string" ? t : t?.name || ""))
    .filter(Boolean) as string[];
}

function extractCustomField(
  contact: GhlContact | null | undefined,
  key: string,
): string {
  const fields = contact?.customFields || contact?.customField || [];
  if (!Array.isArray(fields)) return "";
  const found = fields.find((f) => f?.id === key || f?.key === key);
  return found?.value != null ? String(found.value) : "";
}

/**
 * Verifica se um contato bate as regras de targeting do agente.
 *
 * @param contactId GHL contact id
 * @param rules `agent_configs.targeting_rules`
 * @param companyId pra GHLClient
 * @param locationId pra GHLClient
 */
export async function checkContactMatchesTargeting(
  contactId: string,
  rules: TargetingRule[] | null | undefined,
  companyId: string,
  locationId: string,
): Promise<TargetingMatch> {
  if (!rules || rules.length === 0) return { ok: true };
  if (!contactId || !companyId || !locationId) {
    // Sem dados suficientes pra checar — fail-open.
    return { ok: true };
  }

  try {
    const client = new GHLClient(companyId, locationId);
    const needsContact = rules.some(
      (r) => r.type === "tag" || r.type === "custom_field",
    );
    const needsOpps = rules.some((r) => r.type === "pipeline_stage");

    const [contactRes, oppsRes] = await Promise.all([
      needsContact
        ? client.get(`/contacts/${contactId}`).catch(() => null)
        : Promise.resolve(null),
      needsOpps
        ? client
            .get(
              `/opportunities/search?contactId=${contactId}&locationId=${locationId}&limit=100`,
            )
            .catch(() => null)
        : Promise.resolve(null),
    ]);

    const contact: GhlContact | null =
      contactRes &&
      typeof contactRes === "object" &&
      "contact" in (contactRes as Record<string, unknown>)
        ? ((contactRes as { contact: GhlContact }).contact ?? null)
        : (contactRes as GhlContact | null);

    const opps: GhlOpp[] =
      oppsRes &&
      typeof oppsRes === "object" &&
      "opportunities" in (oppsRes as Record<string, unknown>)
        ? ((oppsRes as { opportunities: GhlOpp[] }).opportunities ?? [])
        : Array.isArray(oppsRes)
          ? (oppsRes as GhlOpp[])
          : [];

    for (const rule of rules) {
      if (rule.type === "tag") {
        if (!rule.tag) continue;
        const tags = extractTags(contact);
        if (!tags.includes(rule.tag)) {
          return { ok: false, reason: `tag:${rule.tag} ausente` };
        }
      } else if (rule.type === "custom_field") {
        if (!rule.custom_field_key) continue;
        const value = extractCustomField(contact, rule.custom_field_key);
        if (!rule.custom_field_value) {
          // Sem valor esperado = só precisa existir / ser não-vazio.
          if (!value)
            return {
              ok: false,
              reason: `custom_field:${rule.custom_field_key} vazio`,
            };
        } else if (
          value.trim().toLowerCase() !==
          rule.custom_field_value.trim().toLowerCase()
        ) {
          return {
            ok: false,
            reason: `custom_field:${rule.custom_field_key} ≠ ${rule.custom_field_value}`,
          };
        }
      } else if (rule.type === "pipeline_stage") {
        if (!rule.pipeline_stage_id) continue;
        const match = opps.some((o) => {
          const stageOk =
            (o.pipelineStageId || o.stageId) === rule.pipeline_stage_id;
          const pipelineOk =
            !rule.pipeline_id || o.pipelineId === rule.pipeline_id;
          return stageOk && pipelineOk;
        });
        if (!match) {
          return {
            ok: false,
            reason: `pipeline_stage:${rule.pipeline_stage_id} ausente`,
          };
        }
      }
    }

    return { ok: true };
  } catch (err) {
    // Fail-OPEN: erro em fetch GHL não deve silenciar o agente.
    console.warn(
      "[targeting] check falhou (fail-open):",
      err instanceof Error ? err.message.slice(0, 200) : err,
    );
    return { ok: true };
  }
}
