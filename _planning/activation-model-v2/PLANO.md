# H51 — Modelo de Ativação V2 (gatilho ≠ membership ≠ gate)

> Status: **PLANO** (aguarda implementação). Pedro escolheu **opção 3** (opener ativa
> na hora + tag como rede de segurança), sobre o fix fundamental de membership.
> Origem: caso Marina (recrutamento IG DM), agente `3976b4b6-0345-4f25-b964-138bb7960058`,
> location `A62s5EQj1hldOuvBEowv`. Escrito 2026-07-16.

---

## 1. Problema (aterrado em prod)

A IA da Marina é ativada por uma **tag "ia - em atendimento"** adicionada por uma
automação do Spark Leads que reage à mensagem de abertura do lead
("Olá Marina, queria entender melhor sobre essa carreira"). Sintomas relatados:

1. **Não ativa** — a IA não recebe/responde a mensagem de abertura.
2. **Ativação avançada (msg OU tag) não responde.**
3. **Ativação por conteúdo de mensagem** responde a 1ª e morre nos follow-ups
   ("o corpo das próximas não é mais a frase que ativou").

### Causa-raiz — o sistema confunde 3 conceitos

O código tem duas camadas de decisão:
- **Roteador** (`inbound-message/route.ts:626`) — se existe `conversation_state` do
  contato, escolhe o agente e **pula o targeting**; senão, avalia as `targeting_rules`.
- **Gate do processor** (`queue-processor.ts:421`) — re-checa o targeting por mensagem.

Três defeitos estruturais:

**D1 — Corrida da tag (o "não ativa").** A automação adiciona a tag reagindo à MESMA
mensagem que dispara nosso webhook. Lemos o contato via API **antes da tag ser
gravada** → roteador não vê a tag → dropa (`no_agent_matched_targeting`) → **nenhum
`conversation_state` criado**. Abertura perdida. O próprio código já documenta isso
como esperado e tem recuperação pronta (reactive `tag_added`), **mas está desligada**:
`reactive_trigger_fired` = **0 em 14 dias, todas as locations** (`PROACTIVE_EVENTS_ENABLED` OFF).

**D2 — Membership só nasce após a 1ª resposta.** `conversation_state` só é escrito
**depois** de uma resposta bem-sucedida (`action-executor.ts:517`). Se a 1ª resposta
falha (LLM/timeout), ou se a ativação foi por mensagem e a 1ª caiu, não há estado →
follow-up (corpo diferente) volta a ser avaliado contra o gatilho → dropa. É o
sintoma nº3.

**D3 — Tag como gate contínuo, não gatilho.** O processor re-checa a tag a CADA
mensagem. Se a automação remover a tag no meio (mudança de etapa) → IA **emudece no
meio da conversa**, silenciosamente.

### Evidência

- **618 conversas, 205 resumidas MANUALMENTE** (rep clicou "IA assume") = workaround
  humano pra ativação quebrada.
- Config real: `targeting_rules = [{tag:"ia - em atendimento", type:"tag"}]`, canal
  Instagram, sem working-hours mutando.
- GHLClient GET **não cacheia** corpo → o check contínuo é fresco; a corrida é só no
  1º instante.

---

## 2. Modelo correto

| Conceito | O que é | Avalia | Hoje |
|---|---|---|---|
| **Gatilho de ativação** | "lead entrou no funil" (abriu com a frase OU ganhou a tag OU entrou na etapa) | **1 vez** | misturado no targeting |
| **Membership** | "essa conversa é da IA até pausar/handoff" | escrito na ativação, lido sempre | só nasce após 1ª resposta ⚠️ (D2) |
| **Gate contínuo** (opcional) | "só responder enquanto atributo X" | toda mensagem | tag vira isso por acidente ⚠️ (D3) |

Princípio: **uma vez ativado, o dono é o membership — não o gatilho.** Targeting é
preocupação de PRIMEIRO contato. Follow-up é decidido por membership.

---

## 3. Plano — 3 frentes

### Frente A — Membership durável na ativação (fix fundamental) — CÓDIGO, baixo risco

Escrever `conversation_state` (com `agent_id` + `status='active'`) **assim que o gate
de targeting passa**, ANTES do trabalho de LLM, em `queue-processor.ts` (logo após a
linha ~457). Idempotente (upsert `onConflict agent_id,contact_id`, sem tocar
`message_count`/`last_ai_response_at`/`ai_paused_at` se já existir — só garante a
linha-dono). Efeito: follow-up nunca mais órfão, mesmo se a 1ª resposta falhar.
Mata D2. Não altera `conversationActive` do turno atual (lido no topo, antes).

- **Cuidado**: não escrever no ROTEADOR (escreveria pra inbounds que o processor
  depois pula por handoff/canal). Escrever no processor, pós-gate.
- **Teste**: simular 1ª resposta que falha → 2ª mensagem (corpo diferente) ainda roteia.

### Frente B — Opener como gatilho + separar gatilho de gate — CÓDIGO + 1 decisão

**B1. Config da Marina vira OR de gatilhos** (não mais tag-gate único):
```
targeting_rules (set v2, match "any"):
  grupo "abertura":  { type:"message", message_operator:"contains",
                        message_value:"carreira", case_sensitive:false }
                     (ou starts_with "olá marina" — ver §5)
  grupo "tag":       { type:"tag", tag:"ia - em atendimento" }
```
O leaf `message` já vira NEUTRO quando `conversationActive` (só ativa no 1º contato) —
com a Frente A segurando os follow-ups, o opener passa a funcionar de ponta a ponta.

**B2. Tag como GATILHO, não gate** (resolve D3). Decisão de design (ver §4): tornar a
neutralização-quando-ativa (hoje só do leaf `message`) aplicável também ao leaf `tag`
**quando a config opta por modo-gatilho**. Recomendo campo novo por-config
`activation_mode: 'trigger_once' | 'gate_ongoing'` (default `gate_ongoing` = comportamento
atual, zero regressão). Marina = `trigger_once`: uma vez ativa (membership), o gate do
processor **não re-avalia** o targeting — o dono é o membership até pausa/handoff.

### Frente C — Rede de segurança: reactive `tag_added` — PRECISA DE VOCÊ 👤 + smoke

Ligar o mecanismo que JÁ existe (`reactive-trigger.ts`) pra recuperar quem escapar do
opener e entregar literalmente "ativar quando a tag estiver no contato" (por EVENTO,
sem corrida):
1. 👤 `PROACTIVE_EVENTS_ENABLED=1` na Vercel + `PROACTIVE_EVENTS_LOCATIONS` incluindo
   `A62s5EQj1hldOuvBEowv`.
2. 👤 Assinar o webhook de ContactUpdate/Tag no app GHL apontando pro mesmo endpoint
   de inbound (verificar se `isProactiveEventType` cobre o messageType que chega).
3. Smoke supervisionado: 1 conversa real (lead abre → tag entra → reactive dispara →
   agente começa lendo `lead_history`). Confirmar `reactive_trigger_fired` no
   `execution_log`.
4. Guarda anti-duplicata: reactive só dispara se NÃO houver `conversation_state` do
   agente (já implementado, linha 17-24 do módulo) → não colide com o opener (Frente B).

---

## 4. Decisão pendente (design de B2)

Como representar gatilho-vs-gate sem regredir outros agentes:
- **(rec.) `activation_mode` por-config** — opt-in, default = atual. Simples, seguro.
- Alternativa: `role:'trigger'|'gate'` por-regra — mais granular, mais superfície de UI
  e migração. Fica pra V2 se surgir caso de "tag gatilho + campo gate" no mesmo agente.

## 5. Decisão pendente (match do opener)

Quão literal os leads mandam a frase? Se ~exato → `contains "carreira"` ou
`starts_with "olá marina"` cobrem com folga. Se variam muito → OR de 2-3 folhas
message. A Frente C (tag) é a rede pros que não casarem o opener de jeito nenhum.

---

## 6. Fases / ordem (anti-risco)

1. **Frente A** (membership durável) — sozinha, deploy, observar (baixo risco, corrige D2 já).
2. **Frente B** (opener + `activation_mode=trigger_once` na Marina) — deploy, validar 1 conversa.
3. **Frente C** (reactive tag) — flags + webhook + smoke supervisionado, por último.

Paridade/guard-rails: teste novo em `scripts/` cobrindo (a) 1ª resposta falha → follow-up
roteia; (b) opener ativa + follow-up com corpo diferente responde; (c) `gate_ongoing`
default inalterado (regressão). tsc/build verdes + conferir deploy Vercel `Ready`.

## 7. Fora de escopo (por ora)

- UI pra editar gatilho-vs-gate (fica no default; Marina configurada via script).
- Reactive por `stage_changed`/`custom_field` pra Marina (só tag_added no MVP).
- Migração retroativa dos 205 manual-resume (seguem funcionando via GU-6).
