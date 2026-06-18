# Targeting v2 — ativação por CONTEÚDO da mensagem + grupos E/OU

> Pedro 2026-06-17/18. "No tipo de ativação por mensagem, filtro extra sobre QUAL
> mensagem; regras com E (todas batem) e OU (qualquer bate); no filtro de texto,
> 'contém tal palavra' ou 'é exatamente igual a'." → "Sim, deixa tudo certo."

## O que mudou

Ativação de agente lead-facing (`agent_configs.targeting_rules`) ganhou:

1. **Folha `type:"message"`** — filtra pelo CONTEÚDO da mensagem do lead, com
   operadores de texto: `contains`, `not_contains`, `eq`, `starts_with`,
   `ends_with`, `in` (contém qualquer da lista), `matches_regex`. Flag
   `case_sensitive` (default false). Kernel puro reaproveitável em
   `src/lib/account-assistant/filter-engine/text-ops.ts` (`matchTextOp`).
2. **Composição E/OU** — `TargetingRuleSet` v2 `{version:2, match, groups:[{id,
   match, rules}]}`. Cada grupo combina suas regras com E (`all`) ou OU (`any`);
   os grupos entre si idem. Back-compat: array flat legado = 1 grupo `all` (=
   AND, idêntico ao runtime F27). `normalizeTargeting()` em
   `src/lib/queue/targeting.ts` cobre os dois formatos.

## Camadas

| Camada | Arquivo | Estado |
|--------|---------|--------|
| Tipos | `src/types/agent.ts` (`MessageMatchOp`, `TargetingGroup`, `TargetingRuleSet`, `TargetingRules`) | ✅ |
| Kernel de texto | `src/lib/account-assistant/filter-engine/text-ops.ts` | ✅ |
| Avaliador | `src/lib/queue/targeting.ts` (`evaluateTargetingSet`, `evalGroup`, `evalLeaf`, `normalizeTargeting`) | ✅ |
| Gate runtime | `src/lib/queue/queue-processor.ts` (passa `{messageText, isProactive}`) | ✅ |
| Roteador webhook | `src/app/api/webhooks/inbound-message/route.ts` (failMode "closed", messageText) | ✅ |
| Trigger reativo | `src/lib/account-assistant/proactive/reactive-trigger.ts` (achata v2→folhas) | ✅ |
| Validação (PUT) | `src/lib/utils/validation.ts` (`targetingRulesUnion`) | ✅ |
| UI editor | `src/app/hub/agents/[agentId]/agent-detail-view.tsx` (Cat "Ativação" → modo "Avançado (E/OU)" + `GroupsEditor`/`LeafEditor`) | ✅ |
| Testes | `scripts/test-targeting-message.ts` (37/37) | ✅ |

## Semântica importante (não esquecer)

- **Folha `message` é NEUTRA** quando: (a) não há texto de mensagem, ou (b) é
  disparo PROATIVO (`isProactive`). Isso evita que a folha case a própria
  instrução sintética do proativo. Em set v2 com `match:"all"`, neutra = passa;
  com `match:"any"`, neutra NÃO conta como match.
- **Gate roda a CADA inbound** (queue-processor:386). Logo, uma folha `message`
  como ÚNICA condição faz o agente ficar QUIETO nas mensagens que não baterem —
  inclusive respostas no meio da conversa. O editor avança avisa isso e sugere
  combinar com tag/funil (perfil) + mensagem (gatilho), grupos com E. **Footgun
  conhecido — RV-C2 (silent-agent).**
- `in` aqui = **contém-qualquer** (`list.some(v => t.includes(v))`), divergente
  do `in` do FEL (set-equality). Divergência intencional, documentada no
  text-ops.ts.
- **failMode**: gate (queue-processor) = "open" (erro → assume match, pior caso
  responde a mais); roteador (webhook) = "closed".

## Paridade wizard ↔ detail-view (cross-check obrigatório — anti-pattern CLAUDE.md)

Campos de ativação no **detail-view** (`CatActivation`): inbound · tag ·
custom_field · pipeline_stage · bulk/outreach · **advanced (E/OU + message)**.

Campos no **wizard** (`agent-wizard.tsx` `IntakeMode`): inbound · keyword (→
contexto no prompt, NÃO vira regra) · tag · stage · outreach · `advancedRules`
(só tag/custom_field/pipeline_stage).

**Deltas e classificação:**
1. Wizard não tem modo "Avançado (E/OU)" nem folha `message`. → **(c) follow-up
   intencional.** O wizard é guiado/criação; a composição complexa de E/OU +
   conteúdo é feita no detail-view (edição), que é onde o Pedro pediu. Adicionar
   grupos E/OU ao wizard conversacional incharia o fluxo. O agente nasce simples
   e o rep refina depois.
2. Wizard "keyword" → contexto no prompt, não folha `message`. → **(a) decisão
   intencional.** Virar filtro hard de mensagem reintroduziria o footgun do gate
   por-mensagem (agente mudo no 2º turno). Mantido como contexto. Se algum dia
   virar regra, tem que ser combinado com perfil (tag/stage) — não sozinho.

## Pendências (precisam do Pedro)

- (Opcional) Levar o editor E/OU pro wizard de criação, se reps pedirem compor
  na criação em vez de editar depois.
- (Opcional) Modo "ativar só no 1º contato" pra folha message poder ser usada
  sozinha sem matar conversa multi-turno (exige estado de 1º-contato no gate).
