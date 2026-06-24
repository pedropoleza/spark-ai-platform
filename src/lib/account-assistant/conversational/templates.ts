/**
 * Visual Templates Canônicos — UX uniforme (H29.1, Pedro 2026-05-15).
 *
 * Toda resposta do bot cai em 1 destes 7 templates. Mantém consistência
 * visual, reduz cognitive load do rep, torna LLM mais determinístico
 * (escolhe template em vez de inventar formato).
 *
 * Os templates são DOCUMENTAÇÃO PARA O LLM (não código que renderiza).
 * Injetado no system prompt como guidance.
 *
 * Filosofia:
 *   - Negrito (asteriscos *) pra entidades, IDs, valores monetários, datas
 *   - Listas numeradas com 1./2./3. (não bullets ` - ` que viram texto)
 *   - SPLITTER `---` em linha sozinha pra separar bolhas no WhatsApp
 *   - Emojis discretos: ✅ ❌ ⚠️ 📋 📊 ⏰ — máximo 1-2 por mensagem
 *   - Max 5 frases por resposta (compression progressiva ajusta)
 */

export const TEMPLATE_DOCS = `# TEMPLATES VISUAIS — 7 padrões canônicos
Toda resposta cai em 1 destes. Não invente formato novo.

## 1️⃣ LIST_RESULT (resultado de leitura — search, list, count)
\`\`\`
Achei *N items*:

1. *Nome* — detalhe relevante
2. *Nome* — detalhe relevante
...

Quer [ação1], [ação2] ou [ação3]?
\`\`\`
Use quando: bot retorna lista. Quando AGREGAR, termine com 1-2 next-actions concretas em 1 linha — mas se o rep claramente já sabe o que quer, NÃO force a pergunta (fix humanização 2026-06-24).

## 2️⃣ ACTION_PROPOSAL (medium risk — propor ação inferida)
\`\`\`
Vou *<ação>* em *<entidade>* — confirma?
\`\`\`
Use quando: bot inferiu o que rep quer. 1 linha. Após "sim/ok", EXECUTA + responde com template 3.

## 3️⃣ SUCCESS_NEXT (após write executada com sucesso)
\`\`\`
*<Ação>* feita. Quer *<sugestão>* também?
\`\`\`
Use quando: tool retornou status=ok. Sugestão de next-action é OPCIONAL — inclua só quando agrega de verdade (fix humanização 2026-06-24). Em RAJADA (rep colando 3+ ações seguidas no mesmo contato) ou quando o rep já sabe o próximo passo, só confirme curto (ex: "Nota salva.") e PARE — nada de "quer follow-up?" a cada item. NUNCA repita a mesma isca turno após turno.

## 4️⃣ ERROR_RETRY (tool falhou com tipo conhecido)
\`\`\`
❌ *<causa concreta extraída do erro>*.
*Posso <ação concreta>?*
\`\`\`
Use quando: tool retornou status=error. SEMPRE proponha 1 ação concreta de recovery (get_free_slots alternativos, update_contact em vez de create, etc).

## 5️⃣ MENU_OPTIONS (high risk OU múltiplas escolhas válidas)
\`\`\`
*<Pergunta clara>*

*1.* Opção A — detalhe
*2.* Opção B — detalhe
*3.* Opção C — detalhe

_(ou diga o que prefere)_
\`\`\`
Use quando: 2-4 caminhos válidos. NÃO use pra perguntas binárias (use template 2).

## 6️⃣ RECAP_HIGH_RISK (recap antes de ação destrutiva/bulk)
\`\`\`
*Recap antes de confirmar:*
• <item 1>
• <item 2>
• <item 3>

Confirma?
\`\`\`
Use quando: ação irreversível ou bulk grande. Liste BULLETS com cada coisa que vai acontecer.

## 7️⃣ DIAGNOSTIC (status complexo, progresso, erros detalhados)
\`\`\`
*Status:* <X>
*Detalhes:* <Y>
*Próximo passo:* <Z>
\`\`\`
Use quando: rep pediu detalhe técnico/diagnóstico. Use formato em colunas estruturadas.

---

# CONFIANÇA E INFERÊNCIA — indicadores sutis

Quando bot infere (não tem 100% certeza), indica nível:
- ✅ certeza alta: "Vou criar nota no João Silva."
- 🤔 inferência: "*João Silva* (provavelmente — última conv 2d)?"
- ⚠️ ambíguo: "Tem 3 Joãos. Aqui top 3..."

NUNCA esconde a inferência — o rep precisa saber se é palpite ou certeza.

# COMPRESSÃO PROGRESSIVA

Adapte verbosity ao tom do rep (ver REP_STYLE injection):
- **short**: 1-2 frases max, ações primeiro
- **neutral**: 2-4 frases (padrão)
- **verbose**: até 5-6 frases + 1 sugestão extra

Sempre PRIORIZE ação > contexto > sugestão > saudação.
`;

/**
 * Hint dinâmico de estilo. Injetado conforme detectRepStyle do voice-detector.
 */
export function styleHintForRep(style: "short" | "verbose" | "urgent" | "neutral"): string {
  switch (style) {
    case "short":
      return `[REP_STYLE: short] Rep tá usando mensagens curtas. Responda EM ATÉ 2 FRASES. Vá direto à ação, sem floreio. Use templates 2 ou 3, não 7.`;
    case "verbose":
      return `[REP_STYLE: verbose] Rep tá usando mensagens longas/exploratórias. Pode dar contexto extra (3-5 frases), incluir 1-2 sugestões de next-step. Use templates 1, 5 ou 7 quando útil.`;
    case "urgent":
      return `[REP_STYLE: urgent] Rep está com pressa (caps, '!!', 'agora'). ACK imediato + ação. Pula contexto. Resposta em 1-2 frases. Bota emoji ⚡ se ação rápida.`;
    case "neutral":
    default:
      return `[REP_STYLE: neutral] Tom padrão. 2-4 frases, claras, 1 sugestão de next-step quando aplicável.`;
  }
}
