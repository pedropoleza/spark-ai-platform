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
1. **[iter-1, em curso]** Reduzir ruído de observabilidade (painel afogado) — ver abaixo.
2. Coherence reruns "reminder/message sem tool" (bot às vezes afirma sem tool) — investigar casos.
3. `update_appointment: horário ocupado/bloqueado` (5×) + **blocked-slots/Google Calendar** (pedido do Pedro: SparkBot ver bloqueios de calendário p/ contexto) — viabilidade.
4. "Task orchestrator: materialização parcial revertida" (6×).
5. "Anti-repeat guard: loop verbatim quebrado" (28×) — tunar.

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
