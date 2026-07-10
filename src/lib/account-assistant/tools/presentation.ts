/**
 * Tool de APRESENTAÇÃO — `present_options`.
 *
 * Pedro 2026-05-20: deixa o LLM apresentar opções/confirmação pro rep TOCAR
 * (botão ≤3 / lista 4–10) em vez de digitar. É uma tool "terminal de
 * apresentação": o handler só confirma o recebimento; quem transforma os args
 * num payload interativo (e no texto-fallback) é o processor, via
 * core/interactive.ts `extractInteractiveFromToolCalls`. O envio canal-aware
 * (botão/lista no WhatsApp, texto no web/GHL) é decidido no stevo-handler.
 *
 * risk:"safe" — não escreve nada no CRM. O tap do rep volta normalizado pra
 * texto (stevo-parser), então o gate H8 / coherence continuam intactos.
 */

import type { ToolEntry } from "./types";

export const PRESENTATION_TOOLS: ToolEntry[] = [
  {
    def: {
      name: "present_options",
      description:
        "Apresenta opções TOCÁVEIS pro rep (botões até 3, ou lista de 4 a 10) em vez de ele digitar. " +
        "Use quando você daria opções pra escolher OU pediria uma confirmação sim/não. Exemplos: confirmar " +
        "uma ação (Confirmar/Cancelar), escolher entre contatos achados, escolher horário, escolher " +
        "pipeline/stage, lead quente/fria, aprovar um rascunho. Coloque TODO o texto da pergunta em `body` " +
        "(auto-contido — o rep também pode estar num canal que mostra só texto). Cada opção tem `id` curto e " +
        "estável (ex: 'confirm', 'cancel', 'opt_3') e `label` (o que aparece). Quando o rep tocar, você recebe " +
        "o label como se ele tivesse DIGITADO — e ele SEMPRE pode digitar em vez de tocar. " +
        "NÃO use pra texto livre (corpo de nota, nome, valor, data, mensagem pro cliente, pergunta aberta). " +
        "⚠️ NÃO repita as opções numeradas dentro do `body` — a lista já as mostra (repetir = opções em dobro na tela). " +
        "H47-F2: quando as opções são CONTATOS, passe `contact_id` em cada uma — o tap volta resolvido e você NUNCA re-pergunta a mesma lista.",
      parameters: {
        type: "object",
        properties: {
          body: {
            type: "string",
            description:
              "A pergunta/corpo, AUTO-CONTIDO. Ex: 'Vou criar a nota \"Ligar amanhã\" no contato do João. Confirma?'",
          },
          options: {
            type: "array",
            description: "2 a 10 opções. ≤3 viram botões; 4-10 viram lista.",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "ID curto e estável (ex: 'confirm', 'cancel', 'contact_1'). Volta no tap pra você correlacionar.",
                },
                label: {
                  type: "string",
                  description: "Texto visível e curto. Botão ≤20 chars; row de lista ≤24.",
                },
                description: {
                  type: "string",
                  description: "Descrição opcional (só aparece em lista, ≤72 chars). Pra contato: telefone/email aqui.",
                },
                contact_id: {
                  type: "string",
                  description:
                    "H47-F2: id do CONTATO que a opção representa (quando a escolha é entre contatos). " +
                    "O tap volta com esse id resolvido — elimina a re-pergunta.",
                },
              },
              required: ["id", "label"],
            },
          },
          title: { type: "string", description: "Header curto opcional (acima do corpo)." },
          footer: { type: "string", description: "Footer curto opcional." },
          button_text: {
            type: "string",
            description: "Só lista: label do botão que abre o menu (ex: 'Ver opções'). Default 'Ver opções'.",
          },
          style: {
            type: "string",
            enum: ["auto", "buttons", "list"],
            description: "Default 'auto' (≤3 = botão, 4+ = lista). Force só se precisar.",
          },
        },
        required: ["body", "options"],
      },
      risk: "safe",
    },
    handler: async (_ctx, args) => {
      const options = Array.isArray(args.options) ? args.options : [];
      return {
        status: "ok",
        data: {
          presented: true,
          count: options.length,
          note: "Opções enviadas ao rep. NÃO escreva mais texto — aguarde a escolha dele (ele pode tocar ou digitar).",
        },
      };
    },
  },
];
