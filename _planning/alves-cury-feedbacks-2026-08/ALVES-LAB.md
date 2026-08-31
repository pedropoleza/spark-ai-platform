# Alves Lab — teste pré-religa pro time da Alves Cury (2026-08-31)

Pedido do Pedro pós-H88: plataforma temporária estilo Marina Lab pro Marcos e
time testarem a Bruna e o Bruno reformados — "pra aumentar a moral".

- **URL**: https://spark-ai-platform.vercel.app/alves
- **Acesso**: PIN de 4 dígitos (env `ALVES_LAB_PIN` na Vercel; valor atual com o Pedro).
  Cookie 14d. Rate limit 8 tentativas/15min por IP. Fail-closed sem env.
- **Kill-switch**: `ALVES_LAB_ENABLED=0` + redeploy (default ligado).
- **Nada envia pra lead**: chat via `/api/agents/test` (execute_actions:false),
  auth alternativa escopada aos 2 agentes da conta (token, nunca body).

O que tem:
1. **Conversar** — seletor Bruna/Bruno; chips com as perguntas difíceis da
   bateria; botão "😈 provocar" no meio da conversa; 👍/👎 + "eu diria assim"
   em cada resposta → `agent_feedback` (context `alves-lab`) → entra no prompt
   no turno seguinte.
2. **"📅 E se o lead sumisse agora?"** — `/api/alves/followup-preview` gera os
   3 toques REAIS da conversa atual com o gerador+guards de produção
   (anti-repetição H88, day-guard, sanitizer, condense); toque descartado pelo
   guard aparece como "🤫 o sistema descartou este toque" (feature, não bug).
3. **Melhorias** — cada reclamação real do Marcos → o que mudou (a moral).
4. **Ideias** — recado livre → `marina_lab_feedback` (tabela genérica do lab
   apesar do nome; filtrar por location `YuR0LCZomFzrfkDK2ezo`).

Smoke e2e em prod (31/08): auth 401/ok ✓ · página 200 ✓ · chat Bruna ✓ ·
escopo (agente de outra conta) 401 ✓ · preview 3 toques sem repetição ✓ ·
feedback ✓ (linha de fumaça deletada do agent_feedback depois).

Pra encerrar o lab quando acabar: `ALVES_LAB_ENABLED=0` na Vercel (ou remover
`ALVES_LAB_PIN`).
