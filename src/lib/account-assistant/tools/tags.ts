/**
 * Tools de Tags em contatos. Add e Remove separados (2 tools distintas).
 */

import type { ToolEntry } from "./types";
import { validateGhlId, ghlErrorToResult } from "./types";
import { addTagsToContact, removeTagsFromContact } from "@/lib/ghl/operations";
import { resolveTagsForWrite, resolveTagsForRemoval, tagKey } from "@/lib/ghl/tag-resolver";

const addTag: ToolEntry = {
  def: {
    name: "add_tag",
    description:
      "Adiciona uma ou mais tags a UM contato. Pra aplicar/remover em MUITOS contatos de uma " +
      "vez, use bulk_update_tags (NUNCA chame esta em loop). O nome é casado com as tags que a conta JÁ TEM " +
      "(caixa/acento/hífen não distinguem), então `added` pode vir escrito diferente do que você " +
      "pediu — narre SEMPRE a partir de `added`, nunca do que você mandou. Quando vier " +
      "`created_tags`, a tag não existia e foi criada agora: avise o rep, principalmente se " +
      "`similar` mostrar que a conta já tinha algo parecido (automação amarrada na outra grafia " +
      "não dispara). Depois de aplicar, a tool RELÊ o contato: se vier " +
      "`removidas_logo_apos_aplicar`, uma automação da conta consumiu a tag segundos depois — " +
      "narre ISSO pro rep (a tag entrou, disparou a automação e foi removida; sugira conferir o " +
      "workflow), NUNCA um 'adicionada ✅' seco.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        tags: { type: "array", items: { type: "string" }, description: "Lista de tags." },
      },
      required: ["contact_id", "tags"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const tags = Array.isArray(args.tags) ? (args.tags as string[]).filter(Boolean) : [];
    if (tags.length === 0) return { status: "error", message: "tags obrigatórias (array de strings)", retryable: false };

    try {
      // H75: grava a grafia que a CONTA usa, não a que o modelo escreveu.
      const resolved = await resolveTagsForWrite(ctx.ghlClient, ctx.locationId, tags);
      const used = resolved.map((r) => r.used);
      await addTagsToContact(ctx.ghlClient, contactId, used);

      // H79 (fix bug observado em prod 2026-08-20, caso Rafael/Jussara): o POST
      // aceita a tag e um workflow da conta pode consumi-la em segundos (padrão
      // gatilho-que-se-consome: dispara → re-etiqueta → remove). O bot dizia
      // "adicionada ✅" e a realidade desfazia — falso positivo pro rep. Relê o
      // contato ~2,5s depois e devolve o que sumiu; releitura falhando não vira
      // erro (best-effort), só perde a verificação.
      let sumiram: string[] = [];
      let releu = false;
      try {
        await new Promise((r) => setTimeout(r, 2500));
        const re = await ctx.ghlClient.get<{ contact?: { tags?: string[] } }>(
          `/contacts/${contactId}`,
        );
        const atuais = new Set((re.contact?.tags || []).map(tagKey));
        sumiram = used.filter((t) => !atuais.has(tagKey(t)));
        releu = true;
      } catch {
        // sem releitura, segue com o resultado do POST
      }

      const renamed = resolved.filter((r) => r.status === "normalized");
      const created = resolved.filter((r) => r.status === "created");
      return {
        status: "ok",
        data: {
          added: used,
          ...(releu && sumiram.length
            ? {
                removidas_logo_apos_aplicar: sumiram,
                atencao:
                  "O Spark Leads aceitou a tag mas ela JÁ NÃO ESTÁ no contato segundos depois — " +
                  "alguma automação da conta removeu (padrão comum: workflow dispara na tag e a " +
                  "remove no fim). Avise o rep disso e sugira conferir o workflow; não afirme só " +
                  "que a tag foi adicionada.",
              }
            : {}),
          ...(releu && !sumiram.length ? { verificada_no_contato: true } : {}),
          ...(renamed.length
            ? { matched_existing: renamed.map((r) => ({ pedida: r.asked, usada: r.used })) }
            : {}),
          ...(created.length
            ? {
                created_tags: created.map((r) => ({
                  nome: r.used,
                  ...(r.similar ? { similar: r.similar } : {}),
                })),
              }
            : {}),
        },
      };
    } catch (err) {
      return ghlErrorToResult(err, "adição de tag");
    }
  },
};

/**
 * Tag em massa (2026-08-14, caso Claudia Fehribach): "remove as tags X e Y dos
 * 95 contatos da lista" não tinha caminho — o LLM tentava search_contacts 25×
 * num turno, estourava o budget e travava a rep em "problema técnico" por DUAS
 * SEMANAS. Esta tool faz o loop no SERVIDOR, com orçamento de tempo e retorno
 * parcial honesto (padrão create_appointments_batch/H42).
 */
const BULK_TAGS_TIME_BUDGET_MS = 40_000;
const BULK_TAGS_MAX_IDS = 200;
const BULK_TAGS_FILTER_CAP = 500;

const bulkUpdateTags: ToolEntry = {
  def: {
    name: "bulk_update_tags",
    description:
      "Adiciona ou remove tag(s) de MUITOS contatos numa chamada só (loop roda no servidor). " +
      "USE SEMPRE que o pedido for em massa: 'tira a tag X desses N contatos', 'adiciona Y em " +
      "todo mundo que tem a tag Z'. NUNCA faça isso com N chamadas de add_tag/remove_tag — " +
      "estoura o tempo do turno e trava a conversa. Alvo: passe `contact_ids` (lista que você " +
      "já tem) OU `filter` (mesmo FEL do get_contacts_filtered, ex. todos com uma tag). O nome " +
      "da tag é casado com as tags existentes da conta (caixa/acento/hífen não distinguem). " +
      "Retorno é HONESTO: narre a partir de `updated`/`not_attempted` — se `truncated_by_budget` " +
      "vier true, diga quantos ficaram de fora e ofereça rodar de novo pros restantes (a tool é " +
      "idempotente: re-aplicar nos já feitos não duplica tag).",
    risk: "high",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "remove"], description: "Adicionar ou remover as tags." },
        tags: { type: "array", items: { type: "string" }, description: "Tags a aplicar/remover." },
        contact_ids: {
          type: "array",
          items: { type: "string" },
          description: `IDs dos contatos-alvo (máx ${BULK_TAGS_MAX_IDS}). Alternativa: use 'filter'.`,
        },
        filter: {
          type: "object",
          description:
            "FEL (mesmo formato do get_contacts_filtered) que define os contatos-alvo. " +
            'Ex: {"field":"tag","op":"eq","value":"revisao anual"}. Alternativa: use contact_ids.',
        },
      },
      required: ["action", "tags"],
    },
  },
  handler: async (ctx, args) => {
    const action = String(args.action || "");
    if (action !== "add" && action !== "remove") {
      return { status: "error", message: "action deve ser 'add' ou 'remove'", retryable: false };
    }
    const tags = Array.isArray(args.tags) ? (args.tags as string[]).filter(Boolean) : [];
    if (tags.length === 0) {
      return { status: "error", message: "tags obrigatórias (array de strings)", retryable: false };
    }

    const rawIds = Array.isArray(args.contact_ids) ? (args.contact_ids as string[]).filter(Boolean) : [];
    const hasFilter = args.filter && typeof args.filter === "object";
    if (rawIds.length === 0 && !hasFilter) {
      return {
        status: "error",
        message: "Passe contact_ids OU filter — preciso saber os contatos-alvo.",
        retryable: false,
      };
    }
    if (rawIds.length > 0 && hasFilter) {
      return {
        status: "error",
        message: "Passe SÓ um alvo: contact_ids OU filter, não os dois.",
        retryable: false,
      };
    }

    // Resolve o alvo.
    let targetIds: string[] = [];
    if (rawIds.length > 0) {
      if (rawIds.length > BULK_TAGS_MAX_IDS) {
        return {
          status: "error",
          message: `Máximo ${BULK_TAGS_MAX_IDS} contact_ids por chamada (vieram ${rawIds.length}). Divida em lotes.`,
          retryable: false,
        };
      }
      for (const id of rawIds) {
        const invalid = validateGhlId(id, "contact");
        if (invalid) return invalid;
      }
      targetIds = rawIds;
    } else {
      try {
        const { executeContactsFilter } = await import("../filter-engine");
        const { toEngineCtx } = await import("./filter-tools");
        const result = await executeContactsFilter(
          args.filter as never,
          toEngineCtx(ctx, "bulk_update_tags"),
          { limit: BULK_TAGS_FILTER_CAP },
        );
        if (result.status !== "ok") {
          return {
            status: "error",
            message: `filter inválido: ${result.message || "erro no Filter Engine"}`,
            retryable: false,
          };
        }
        targetIds = (result.items || []).map((c) => c.id).filter(Boolean);
      } catch (err) {
        return ghlErrorToResult(err, "resolução do filtro de contatos");
      }
      if (targetIds.length === 0) {
        return {
          status: "ok",
          data: { action, tags, total: 0, updated: 0, failed: 0, not_attempted: 0, note: "Filtro não casou nenhum contato." },
        };
      }
    }

    // H75: resolve a grafia UMA vez (vale pra location inteira, não por contato).
    let tagsAlvo: string[];
    try {
      tagsAlvo =
        action === "add"
          ? (await resolveTagsForWrite(ctx.ghlClient, ctx.locationId, tags)).map((r) => r.used)
          : await resolveTagsForRemoval(ctx.ghlClient, ctx.locationId, tags);
    } catch {
      tagsAlvo = tags; // fail-open, igual ao resolver
    }

    // Loop server-side com orçamento — o excedente volta como not_attempted.
    const startedAt = Date.now();
    let updated = 0;
    const failedSample: Array<{ contact_id: string; error: string }> = [];
    let failed = 0;
    let cursor = 0;
    for (; cursor < targetIds.length; cursor++) {
      if (Date.now() - startedAt > BULK_TAGS_TIME_BUDGET_MS) break;
      const id = targetIds[cursor];
      try {
        if (action === "add") await addTagsToContact(ctx.ghlClient, id, tagsAlvo);
        else await removeTagsFromContact(ctx.ghlClient, id, tagsAlvo);
        updated++;
      } catch (err) {
        failed++;
        if (failedSample.length < 3) {
          failedSample.push({
            contact_id: id,
            error: err instanceof Error ? err.message.slice(0, 120) : String(err),
          });
        }
      }
    }
    const notAttempted = targetIds.length - cursor;

    return {
      status: "ok",
      data: {
        action,
        tags_used: tagsAlvo,
        total: targetIds.length,
        updated,
        failed,
        not_attempted: notAttempted,
        truncated_by_budget: notAttempted > 0,
        ...(failedSample.length ? { failed_sample: failedSample } : {}),
        ...(notAttempted > 0
          ? {
              note:
                `Orçamento de tempo do turno acabou: ${notAttempted} contato(s) ficaram de fora. ` +
                `Diga isso ao rep e ofereça continuar — chame de novo com os restantes.`,
              remaining_contact_ids: targetIds.slice(cursor, cursor + BULK_TAGS_MAX_IDS),
            }
          : {}),
      },
    };
  },
};

const removeTag: ToolEntry = {
  def: {
    name: "remove_tag",
    description:
      "Remove uma ou mais tags de um contato. Tira TODAS as grafias equivalentes (no-show, " +
      "no show, No_Show) — quem pede pra tirar a tag quer o conceito fora do contato.",
    risk: "medium",
    parameters: {
      type: "object",
      properties: {
        contact_id: { type: "string" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["contact_id", "tags"],
    },
  },
  handler: async (ctx, args) => {
    const contactId = String(args.contact_id || "");
    const invalid = validateGhlId(contactId, "contact");
    if (invalid) return invalid;
    const tags = Array.isArray(args.tags) ? (args.tags as string[]).filter(Boolean) : [];
    if (tags.length === 0) return { status: "error", message: "tags obrigatórias", retryable: false };

    try {
      // H75: tira as variantes junto (senão a irmã órfã fica no contato).
      const alvos = await resolveTagsForRemoval(ctx.ghlClient, ctx.locationId, tags);
      await removeTagsFromContact(ctx.ghlClient, contactId, alvos);
      return { status: "ok", data: { removed: alvos } };
    } catch (err) {
      return ghlErrorToResult(err, "remoção de tag");
    }
  },
};

export const TAGS_TOOLS: ToolEntry[] = [addTag, removeTag, bulkUpdateTags];
