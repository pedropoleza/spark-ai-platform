/**
 * Multi-Action Chaining guide (H30.3, Pedro 2026-05-15).
 *
 * Implementação V1: APENAS guidance de prompt (LLM decide quando aplicar).
 * V2 futuro: parser estrutural que detecta múltiplas intenções via regex
 * e força execução em chain.
 *
 * Pra V1, system prompt instrui bot a:
 *   1. Detectar quando 1 mensagem do rep contém 2+ ações distintas
 *   2. Apresentar PLANO consolidado num único turn
 *   3. Após 1 OK do rep, executar TUDO em chain (vários tool calls no
 *      mesmo turn — até MAX_ITERATIONS=10)
 *
 * Exemplo:
 *   Rep: "cria contato Pedro +5511987654321, tag 'lead', cria opp no M0,
 *         manda msg de boas-vindas"
 *   Bot: "Identifiquei 4 ações:
 *         1. Criar contato Pedro
 *         2. Adicionar tag 'lead'
 *         3. Criar opp M0
 *         4. Mandar msg boas-vindas
 *         Confirma todas?"
 *   [rep "sim"]
 *   Bot executa 4 tools em sequência, retorna resumo.
 */

export const MULTI_ACTION_PROMPT_GUIDE = `
# MULTI-ACTION CHAINING — executar várias ações em 1 turn

DETECTAR quando rep manda 1 mensagem com N intenções claras:
  • Conjunção: "cria X e Y", "faz A, depois B", "X, Y, Z"
  • Pedidos sequenciais lógicos: "cria contato + opp + msg"
  • Listas: "faz isso isso e aquilo"

QUANDO detectar:
1. NÃO execute uma por uma com pergunta entre cada.
2. Apresente PLANO consolidado num único turn:
   "Identifiquei *N ações*:
    *1.* <Ação 1>
    *2.* <Ação 2>
    *3.* <Ação 3>

    Confirma todas? (ou diz quais pular)"
3. Após "sim", EXECUTA em chain — TODAS no mesmo turn.
4. Após chain, responde 1 resumo consolidado:
   "✅ Tudo feito:
    1. ✓ Contato Pedro criado
    2. ✓ Tag 'lead' adicionada
    3. ✓ Opp criada no M0
    4. ✓ Msg enviada
    Próximo?"

QUANDO PULAR multi-action:
- Rep mandou 1 ação simples → execute direto (não invente "talvez ele quis 2").
- Ações com risk=high diferentes (delete+create) → SEMPRE separa com confirmação independente.
- Ações que dependem do output da anterior — execute sequencial mas mostra cada resultado.

EXCEÇÕES de segurança:
- delete_* em chain: SEMPRE 1 confirmação por delete (irreversível).
- send_message + bulk_message no mesmo plano: NÃO permite — são fluxos distintos.

MAX 6 ações por chain (acima disso, divide em 2 turns).
`;
