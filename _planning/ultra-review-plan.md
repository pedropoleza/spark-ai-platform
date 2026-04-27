# Ultra Review do Sparkbot V2 — Plano

**Data:** 2026-04-27
**Solicitado por:** Pedro
**Objetivo:** Avaliação profunda end-to-end do Sparkbot e do código relacionado pra:
1. Encontrar inconsistências
2. Entender como o agente está funcionando na prática
3. Mapear fluxo (o que tem vs o que falta)
4. Plano de ação pra V2 → V3

## Escopo

- ✅ Sparkbot V2 (tools, dispatcher, prompts, UI, cron)
- ✅ Schema DB e migrations recentes (00029, 00030, 00031, 00032)
- ✅ Comparativo com sales/recruitment (consistência arquitetural)
- ✅ Synthetic testing com personas reais
- ✅ Gap analysis V2 → V3 (WhatsApp real)

## Fases

### 1. Setup de testing (15 min)
Criar endpoint sintético `/api/agents/account-assistant/synthetic-test` com auth via Bearer (CRON_SECRET). Permite rodar conversas de teste sem precisar de sessão de admin no browser. Cria sessão de teste e rep sintético sob demanda.

### 2. Análise estática (30 min — paralelo)
Explore agent dedicado com brief detalhado pra:
- Mapear cada uma das 41 tools (signature, validações, GHL endpoints corretos)
- Avaliar prompt-builder (qualidade, tom, regras absolutas, cache hit)
- Avaliar dispatcher (cooldown logic, quiet hours, race conditions)
- Avaliar UI (acessibilidade, edge cases, polling, performance)
- Avaliar runner de reminders (atomic claim, advance, recursion bug)

### 3. Synthetic chat tests (30 min)
8 personas / cenários:
1. **Manhã produtiva** — "bom dia, o que tenho hoje?"
2. **Pedido vago com ambiguidade** — "olha aquele João lá"
3. **Multi-step orchestration** — "cria nota e task pra Maria"
4. **Reminder simples** — "me lembra em 2h de ligar pro Pedro"
5. **Reminder recorrente** — "todo dia útil 18h me manda os fechamentos"
6. **Áudio** — input simulado de áudio transcrito
7. **Imagem** — input com imagem mock (base64 small)
8. **Erro de GHL** — pedido com ID inventado, ver desambiguação

Cada cenário:
- Mando via endpoint
- Capturo: response, tools usadas, tokens, duração
- Avalio: tom, exatidão, uso correto de tools, recovery de erros

### 4. DB review (20 min)
- Schema consistency (FKs, types, NOT NULLs)
- RLS policies (deny_anon coerente?)
- Indexes faltando em queries hot
- Dados órfãos (FKs quebradas, status inconsistentes)
- Migration history coesa

### 5. Cross-system review (20 min)
Diff de patterns entre Sparkbot e sales/recruitment:
- Tool registry (Sparkbot tem 41, sales tem 0 — diferença de filosofia)
- Prompt structure (cache static vs dynamic)
- Session management (test sessions reusadas — coerente)
- Billing tracking (proactive vs reactive)
- Error handling (retry, fallback)

### 6. Gap analysis V2 → V3 (20 min)
Quando WhatsApp real for habilitado:
- Mode 'real' no dispatcher (atualmente stub)
- WhatsApp Cloud API + Evolution coexist no mesmo número
- Reminder runner mode 'real' (atualmente só simulated)
- Webhook routing pra detecção de eventos (no_show, opportunity_stale)

### 7. Report final (20 min)
- Sumário executivo
- Top issues por severidade (🔴 / 🟡 / 🟢)
- Sugestões priorizadas (effort vs impact)
- Roadmap V3

## Output esperado

`_planning/ultra-review-findings.md` com seções por fase e plano de ação consolidado no final.
