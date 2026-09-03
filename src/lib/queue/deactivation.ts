/**
 * "A IA está desligada PRA ESTE CONTATO?" — uma resposta só, pros três lugares
 * que precisam dela: o webhook (antes de enfileirar), o processor (antes do
 * LLM) e o runner de follow-up (antes de mandar um toque).
 *
 * Fonte da regra: `agent_configs.deactivation_rules` — configurável no Hub
 * ("Regras de desligamento": tag adicionada, tag removida, campo = valor),
 * por agente, com casamento EXATO por id/fieldKey e valor.
 *
 * H89 (fix bug observado em prod 2026-09-03, caso Márcia/Five Star): a conta
 * desliga a IA por lead com o picklist "AI Status: Inactive" do cadastro (três
 * workflows ativos só pra manter o campo) e a regra só era honrada no webhook
 * — o runner mandava os toques já agendados assim mesmo, e mensagens que
 * entravam por outra rota passavam direto. Medido: 42 dos 104 contatos
 * respondidos em 7 dias estavam Inactive (233 mensagens indevidas). A primeira
 * versão do fix criou um gate paralelo casando fieldKey por SUFIXO na frota
 * inteira; o review derrubou (mecanismo duplicado, invisível na UI, sufixo
 * frouxo). Esta é a forma certa: a regra que o cliente vê é a que o runtime
 * aplica, nos três pontos.
 *
 * Fail-open em tudo: sem regra, sem contato ou erro = comportamento de antes.
 */
import type { DeactivationRule } from "@/types/agent";

/** O que precisamos do contato que o Spark Leads devolve no GET /contacts/{id}. */
export interface ContatoParaRegras {
  tags?: Array<string | { name?: string }> | null;
  customFields?: Array<{ id?: string; key?: string; fieldKey?: string; value?: unknown }> | null;
  /** Shape legada do mesmo campo — o targeting já tolera as duas. */
  customField?: Array<{ id?: string; key?: string; fieldKey?: string; value?: unknown }> | null;
}

function nomesDasTags(contato: ContatoParaRegras): string[] {
  const raw = Array.isArray(contato.tags) ? contato.tags : [];
  return raw
    .map((t) => (typeof t === "string" ? t : t?.name || ""))
    .filter(Boolean)
    .map((t) => t.toLowerCase());
}

function valorDoCampo(contato: ContatoParaRegras, chave: string): string | undefined {
  const lista = Array.isArray(contato.customFields)
    ? contato.customFields
    : Array.isArray(contato.customField)
      ? contato.customField
      : [];
  const f = lista.find((c) => c?.id === chave || c?.key === chave || c?.fieldKey === chave);
  return f?.value != null ? String(f.value) : undefined;
}

/**
 * Qual regra desliga a IA pra este contato? `null` = nenhuma. PURO.
 * Tag é comparada sem diferença de caixa (o Spark Leads normaliza tags pra
 * minúsculas ao gravar); valor de campo é comparado exato, como no webhook.
 */
export function regraQueDesliga(
  contato: ContatoParaRegras | null | undefined,
  regras: DeactivationRule[] | null | undefined,
): DeactivationRule | null {
  if (!contato || !Array.isArray(regras) || regras.length === 0) return null;
  const tags = nomesDasTags(contato);
  for (const r of regras) {
    if (!r) continue;
    if (r.type === "tag_added" && r.tag && tags.includes(r.tag.toLowerCase())) return r;
    if (r.type === "tag_removed" && r.tag && !tags.includes(r.tag.toLowerCase())) return r;
    if (r.type === "custom_field_equals" && r.field_key) {
      const v = valorDoCampo(contato, r.field_key);
      if (v !== undefined && v === (r.field_value ?? "")) return r;
    }
  }
  return null;
}

/** Descrição curta da regra pro execution_log. */
export function descreveRegra(r: DeactivationRule): string {
  if (r.type === "custom_field_equals") return `campo ${r.field_key} = ${r.field_value ?? ""}`;
  if (r.type === "tag_removed") return `sem a tag "${r.tag ?? ""}"`;
  return `tag "${r.tag ?? ""}"`;
}
