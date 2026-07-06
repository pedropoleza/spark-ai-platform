# Loop de Qualidade Diário — SparkBot / Spark Hub

> Pedro 2026-06-29. Todo dia: olhar erros/sinais/reports/ideias → escolher **1** melhoria de QUALIDADE de alto ROI → implementar de um jeito que **só melhore e nunca piore** (reversível + testes + paridade). **Sem features novas** — só qualidade: confiabilidade, naturalidade, observabilidade, correção de bug.

## Rotina diária (cada iteração)
1. **Coletar sinais (read-only):** `admin_signals` (48h, status open, por severidade×ocorrência); saúde do inbound (`sparkbot_messages` role=user, 2h/24h); trackers — "não achei" (H45), falsas confirmações/coherence, fallback gpt-4.1, cache (H44); ideias (`admin_signals` type=idea + `_planning`).
1b. **LER as conversas reais da semana (não só os sinais) — caça a "erros NÃO computados":** puxar `sparkbot_messages` (role user+agent) dos últimos 7 dias, agrupado por (rep, conversa), em ordem cronológica, e LER de verdade (em lotes; no volume atual cabe — ~centenas de msgs/semana). Procurar problemas que **nenhum detector pegou**: tom robótico/cerimonioso, contexto de contato errado, **confirmação falsa que não tripou o coherence-gate** ("agendei/anotei" sem tool), intenção mal-entendida, agendamento errado (dia/hora/fuso), repetição, bot pedindo dado que já tinha, "não sei/não consigo" indevido, resposta fora de escopo. **Cruzar:** conversa COM problema mas SEM sinal = o gap mais valioso. Para cada achado: anota o trecho (rep, horário, msg) na fila.
3. **Escolher 1** (alto ROI, baixo risco, reversível). O resto vai pra fila.
4. **Planejar com rede de segurança:** flag/gate quando tocar comportamento; testes (tsc + parity + unit/stress da área); rollback claro.
5. **Implementar** (mudança de comportamento exige aprovação) → rodar TODOS os guards → commit em branch.
6. **Garantir "só melhora":** parity verde (output idêntico onde não deve mudar), nenhum teste quebrado, mudança arriscada atrás de flag OFF.
7. **Registrar:** o que melhorou + fila + métrica a re-medir amanhã.

## Regras "nunca piore" (invioláveis)
- Mudança de comportamento do bot → **atrás de flag OFF + validação de 1 conversa real**.
- Sempre rodar: `tsc`, `test-motor-parity`, `test-sales-parity`, e os testes da área tocada.
- Reversível: branch + commit isolado; **nunca `--no-verify`**.
- Se não houver melhoria CLARA e segura no dia → **não mexer** (no-op > regressão).
- Mudança de observabilidade (o que vira sinal/log) ≠ mudança de runtime do bot → risco baixo, mas ainda testar.
- **Fechar o gap de detecção:** quando a leitura das conversas (1b) achar uma CLASSE de erro que nenhum detector pega, o ideal é não só corrigir o caso, mas **adicionar/ajustar um detector** (coherence-gate, repeat-guard, signal novo) pra que essa classe vire "computada" e o loop dos próximos dias a pegue sozinho. Detector novo entra como sinal (não muda o runtime do bot) → baixo risco.

## Fila priorizada (atualizada a cada iteração)
1. **[iter-2, feito, flag OFF]** Coherence gate: família `pipeline_add` p/ pegar falsa confirmação "adicionada ao funil/stage" (caso Leidy) — ver iteração 2026-07-06.
2. **👤 Validar + ligar `COHERENCE_PIPELINE_FAMILY=1`** (1 conversa real de "adiciona fulano no funil X") → depois medir se falsas confirmações de pipeline caem.
3. **Coherence "message sem tool" FALSO-POSITIVO** (achado iter-2): a regex da família `message` casa "mensagem agendada"/"mensagens agendadas" mesmo quando o bot (a) mostra rascunho ("Vou ajustar a mensagem agendada…"), (b) LISTA mensagens já agendadas (tools de read chamadas) ou (c) descreve um auto-send passado → rerun desnecessário (queima token/custo, H44). Tunar `isNegatedOrPreviewContext` ou exigir 1ª pessoa p/ a família message. **CUIDADO:** afrouxar pode deixar passar falsa confirmação real — precisa de teste + flag.
4. `update_appointment: horário ocupado/bloqueado` + **blocked-slots/Google Calendar** — viabilidade.
5. "Task orchestrator: materialização parcial revertida" (6×).
6. "Anti-repeat guard: loop verbatim quebrado" (42× e ainda subindo, last_seen 07-06) — tunar.
7. **Ruído de observabilidade ainda vivo:** dead-man `inbound MUDO` CRÍTICO (1907×, falso — inbound vivo 07-06) + `nenhum agente casou targeting` medium 56658× (ainda dispara 07-06 — iter-1 fixou o irmão `location sem agente` que parou em 07-01, mas o targeting continua). Rebaixar/suprimir.

## ⚠️ Nota de custo
Pedro atingiu o limite de gasto mensal (aviso 2026-06-29). Loop diário automatizado consome tokens todo dia. Opções: rodar **manual** (eu rodo quando o Pedro pedir), **cloud schedule** (durável, mas gasta), ou **só nos dias úteis / 1×/semana**. Escolha do Pedro no agendamento.

---

# Iteração 2026-06-29 (primeira)

## Estado
- H45 (resolução de contato) + H44 (custo Fase 1) deployados na main (`52a7a24`).
- Inbound **vivo** (15 msgs/24h, baixo volume — **não é apagão**; último 09:49).

## Triagem dos sinais (48h)
**RUÍDO (afoga o painel — alvo de qualidade de OBSERVABILIDADE):**
- `inbound MUDO` **CRÍTICO 1191×** — falso-alarme: dead-man super-sensível em baixo volume (inbound está vivo). `cron/signals-alert/route.ts`.
- `location sem agente lead-facing` **60.812×** + `nenhum agente casou targeting` **53.960×** — comportamento ESPERADO logado como erro. `inbound-message/route.ts:596,716`.
- `location com muitos IPs únicos` **3350×** — provável pool de IP do GHL. `rate-limit.ts:103`.

**REAL / acionável (qualidade do bot) — buried sob o ruído:**
- Coherence rerun `reminder/message sem tool` (12+9×, open) — bot ainda às vezes afirma sem tool.
- `Task orchestrator: materialização parcial revertida` (6×, open).
- `update_appointment: horário ocupado/bloqueado` (5×) — conecta com blocked-slots/Google Calendar.
- `Anti-repeat guard: loop verbatim quebrado` (28×).

## Escolha da iteração 1: **REDUÇÃO DE RUÍDO DE OBSERVABILIDADE**
**Por quê:** ~115k sinais de ruído afogam ~20 reais. Sem painel limpo o PRÓPRIO loop não funciona (não dá pra achar o que melhorar). Qualidade pura (observabilidade), risco ~zero (muda só o que vira **sinal**, não toca o runtime do bot), reversível.

**O que (escopo desta iteração — o maior pedaço, contido em 1 arquivo):**
- `inbound-message/route.ts:596` e `:716`: os 2 emissores de 115k. São casos ESPERADOS (location sem agente lead / contato não casa targeting) → **rebaixar de `admin_signals` pra debug-log** (ou amostrar/agrupar por location), sem perder visibilidade real.

**Fila (próximas iterações de ruído):**
- Dead-man inbound (`signals-alert`): só CRÍTICO se SEND também falhar OU sessão Stevo down — não em baixo volume legítimo.
- IPs únicos: confirmar pool GHL → whitelist/suprimir.

**Segurança:** muda só a camada de emissão de sinal, não o fluxo de resposta ao lead. Testar: tsc + (se houver) testes do webhook. Reversível por commit. Re-medir amanhã: contagem de `admin_signals` desses tipos deve cair ~a zero, e os sinais reais sobem na lista.

---

# Iteração 2026-07-06 (segunda — semanal)

## Estado / sinais (7d)
- Inbound **vivo**: 2 msgs/2h, 37/24h, 703/7d, último 15:36. → CRÍTICO `inbound MUDO` (1907×) é **falso-alarme** de novo (dead-man super-sensível).
- Coherence gate **funcionando**: reruns/rewrites computados de `reminder/message/appointment/task/tag sem tool` (bot afirmou sem tool → gate re-executou). Amostra de 25 confirmações reais lidas: 100% com tool de lastro em `metadata.tools`.
- Ruído: `location sem agente lead-facing` (63872×) **parou** em 07-01 (iter-1 provavelmente deployou); `nenhum agente casou targeting` (56658×) **ainda dispara** (07-06).

## Leitura das conversas (1b) — erros NÃO computados achados
1. **[ESCOLHIDO] Falsa confirmação de pipeline (caso Leidy, 2026-07-03, rep 2dbd9d0a):** user "adicione ela a prospects e new leads" → bot "Feito! ✅ *Leidy Eder 3T* adicionada ao funil *1- Prospects*, stage *New Leads*." com **tools=[]**. Nada foi escrito no CRM. **Nenhum detector pegou** — a família opportunity_* não conhece a palavra user-facing "funil" e é noun-first; o catch-all genérico só cobre 1ª pessoa ("adicionei", não "adicionada"). Empírico 30d: 5 confirmações reais (todas c/ create/move_opportunity → OK) + 1 falsa (Leidy) + 4 proativos "movimentar o pipeline" (infinitivo, não casam). **FP observado = 0.**
2. **Falso-POSITIVO da família `message`** (não é erro do bot, é do detector): "mensagem/mensagens agendada(s)" casa a regex mesmo em rascunho/listagem/descrição de auto-send → rerun desnecessário (custo). → item 3 da fila.

## Escolha da iteração 2: **fechar o gap de detecção da falsa confirmação de pipeline**
Nova família `pipeline_add` no `coherence-gate.ts` (regex participle-first + palavra "funil"), atrás da flag **`COHERENCE_PIPELINE_FAMILY` (default OFF)** — regra "nunca piore" (é mudança de runtime: quando LIGADA, dispara rerun/rewrite nessa classe). `satisfying_tools = create/move/update_opportunity + update_opportunity_status`. Teste `test-coherence-gate.ts` 19/19 (inclui o BUG Leidy pego com flag ON, os FP proativo/negação/confirmação-real NÃO pegos, e paridade flag-OFF = comportamento de hoje). tsc limpo · motor-parity 7/7 · sales-parity 5/5.

**👤 Pra ligar:** setar `COHERENCE_PIPELINE_FAMILY=1` na Vercel + validar 1 conversa real ("adiciona o fulano no funil X, stage Y" e conferir que, se o bot afirmar sem executar, o gate re-roda). Re-medir semana que vem: falsas confirmações de "adicionada ao funil" com tools=[] devem virar rerun (ou sumir).
