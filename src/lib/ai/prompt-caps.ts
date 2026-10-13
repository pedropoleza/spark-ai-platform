/**
 * Tetos de tamanho dos textos do admin no prompt lead-facing.
 *
 * Fonte única pra três lugares que já discordaram entre si:
 *  - runtime (`sales-prompt-builder.ts`): corta o que passar do teto;
 *  - zod do PUT (`validation.ts`): recusa o save acima do teto;
 *  - painel (`agent-detail-view.tsx`): `maxLength` do textarea.
 *
 * Fix bug observado em prod 2026-10-13: o runtime subiu pra 16000 em 31/08 (caso
 * Alves Cury) e o zod ficou em 8000, com o textarea em 10000. Todo agente que
 * cresceu além de 8000 (Bruna, Bruno, Jussara, Raíssa, Maria) não salvava mais
 * pelo painel, e acima de 10000 nem dava pra digitar.
 */

/** Instruções do administrador (`custom_instructions`). */
export const CUSTOM_INSTRUCTIONS_CAP = 16000;

/** Exemplos de conversa (`conversation_examples`). */
export const CONVERSATION_EXAMPLES_CAP = 8000;
