/**
 * "AI Status: Inactive" no cadastro do contato desliga a IA pra ELE.
 *
 * Fix bug observado em prod 2026-09-03 (caso Márcia/Five Star, queixa de 02/09:
 * "mesmo com a ia desativada, ela continuou mandando mensagem", contato
 * +1 305 363-9705). A conta tem dois campos de picklist no contato — "AI Status"
 * e "Follow Up Status", ambos Active/Inactive — e a equipe usa eles pra tirar a
 * IA de um lead que passou a ser atendido no braço. O runtime NUNCA leu esses
 * campos: em 7 dias, 42 dos 104 contatos que a IA respondeu estavam marcados
 * `Inactive`, somando 233 mensagens que não deviam ter saído.
 *
 * Mesma classe do F27 (targeting salvo e ignorado) e do H73 (post_booking que só
 * existia no prompt): controle que o cliente vê e usa, sem gate atrás.
 *
 * Desenho:
 *  - Só BLOQUEIA com valor explícito `Inactive`. Campo ausente, vazio, `Active`
 *    ou location sem esses campos = comportamento de antes (fail-open).
 *  - O contato já é buscado no turno, então o custo é ler o que já veio; só o
 *    mapa de definições da location é buscado (com cache do filter-engine).
 */
import type { GHLClient } from "@/lib/ghl/client";
import { getCustomFields } from "@/lib/account-assistant/filter-engine/cache";

/** Sufixos de fieldKey que identificam os campos, independentemente do id. */
const CHAVE_AI = "ai_status";
const CHAVE_FOLLOWUP = "follow_up_status";

export interface IdsDosCampos {
  aiStatusId?: string;
  followUpStatusId?: string;
}

/** Descobre os ids dos campos nesta location (cacheado). Fail-open: erro = vazio. */
export async function resolveIdsDeStatus(
  ghl: GHLClient,
  locationId: string,
): Promise<IdsDosCampos> {
  try {
    const campos = await getCustomFields(ghl, locationId);
    const acha = (sufixo: string) =>
      campos.find((c) => String(c.fieldKey ?? "").toLowerCase().endsWith(sufixo))?.id;
    return { aiStatusId: acha(CHAVE_AI), followUpStatusId: acha(CHAVE_FOLLOWUP) };
  } catch {
    return {};
  }
}

/** O valor do picklist marca "desligado"? Só `Inactive` conta. PURO. */
export function ehInativo(valor: unknown): boolean {
  return String(valor ?? "").trim().toLowerCase() === "inactive";
}

/**
 * Lê o valor de um campo na lista que veio junto do contato. O Spark Leads
 * devolve `{ id, value }` (sem fieldKey), por isso o casamento é por id. PURO.
 */
export function valorDoCampo(
  customFields: Array<{ id?: string; value?: unknown }> | undefined,
  campoId: string | undefined,
): unknown {
  if (!campoId || !Array.isArray(customFields)) return undefined;
  return customFields.find((c) => c?.id === campoId)?.value;
}

/** A IA está desligada PRA ESTE CONTATO? PURO — decide sobre dados já buscados. */
export function iaDesligadaNoContato(
  customFields: Array<{ id?: string; value?: unknown }> | undefined,
  ids: IdsDosCampos,
): boolean {
  return ehInativo(valorDoCampo(customFields, ids.aiStatusId));
}

/** O follow-up está desligado PRA ESTE CONTATO? PURO. */
export function followUpDesligadoNoContato(
  customFields: Array<{ id?: string; value?: unknown }> | undefined,
  ids: IdsDosCampos,
): boolean {
  return ehInativo(valorDoCampo(customFields, ids.followUpStatusId));
}
