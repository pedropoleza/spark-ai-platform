# Review de Prontidão pra Produção — Spark AI Hub
### Relatório Executivo · 2026-06-05

**Método:** swarm de **79 agentes** read-only (Explore), **16 subsistemas**, pipeline `auditoria → verificação adversarial cética` + crítico de completude. 163 funcionalidades avaliadas, 5.7M tokens, ~18min.
**Dados completos:** `01-DADOS-COMPLETOS.md` (todos os scores + bom/ruim/melhorar por funcionalidade + todos os blockers com veredicto).

---

## Veredicto geral: **7,13 / 10** — sólido, mas com bloqueadores reais antes de produção

- **31 production blockers CONFIRMADOS** (4 critical, 23 high, 4 medium) · 20 parciais · **11 refutados** (falso-positivo) · 34 structural issues high/critical · 16 lacunas de cobertura.
- A base é boa (motor de tools, dedup do webhook, schema). Os pontos fracos concentram-se em **2 lugares**: o **sistema de follow-up (4,5/10)** e a **camada multi-tenant/RLS + observabilidade silenciosa**.

---

## ⭐ Os 2 gates que você pediu (veredicto)

### Gate 1 — SparkBot só p/ locations com o app: ❌ **QUEBRADO** (HIGH, confirmado)
`/api/sparkbot/check-admin` valida que o user é **admin**, emite o JWT e libera o widget — **mas NUNCA checa se a location tem um agente `account_assistant` ativo** (o "app instalado"). Como você injeta o loader no nível da **agência**, o widget do SparkBot **vaza pra qualquer location** onde o user seja admin, mesmo sem o app.
- **Evidência:** `src/app/api/sparkbot/check-admin/route.ts:39-203` — emite JWT (181-187) sem nenhum check de agente ativo na location.
- **Fix (pequeno, P0):** depois de confirmar `isAdmin`, query `agents` por `account_assistant` ativo na `locationId`; se não houver, retornar `{ok:false, reason:"no_app"}` → o loader não injeta.

### Gate 2 — Agent controls (robô + 👍👎) só p/ quem tem agente ativo: ✅ **OK**
`/api/agents/contact-agents` retorna `hasAnyAgent:false` quando a location não tem agente lead-facing ativo → o loader esconde o pill (`acHidePill`) e o feedback só anexa em mensagem de agente. **Satisfeito.**
- Ressalva separada (P2): **contactId authorization gap** — os endpoints aceitam `contactId` do client e validam só `token.location_id`, não que o contato pertence à location (read/write oracle teórico). `contact-pause/contact-agents/contact-activate`.

---

## Scorecard por subsistema (pior → melhor)

| Score | Subsistema | Status |
|------:|------------|--------|
| **4.5** | Follow-up (lead-facing) | 🔴 Pior. F47 duplica sequência a cada turno; erros silenciosos; 2 sistemas paralelos |
| **4.8** | DB multi-tenant / RLS / segurança | 🔴 RLS é "security theater" (service-role bypassa); deletes globais sem filtro de location |
| **6.4** | Planejamento vs implementado | 🟡 Prospecção 2.0 com flags OFF; polling reativo stub (só post_meeting) |
| **6.5** | Lead awareness / handoff / targeting | 🟡 Handoff ignorado se lead_history off; cache stale; rep errado |
| **6.9** | Prompt motor & plataforma modular | 🟡 Custom agent CRASHA com AGENT_MOTOR_UNIFIED=1; módulos incompletos |
| **6.9** | Observabilidade & erros | 🟡 ~95 falhas silenciosas (console.error sem reportError); bridge Sentry frágil |
| **7.2** | Pipeline queue-processor | 🟢 Robusto; race GU-6×F52; sem retry no fetch de contato |
| **7.2** | SparkBot processor & loop | 🟢 Bom; histórico pode ter msg vazia; loop-breaker hardcoded |
| **7.3** | Filter engine & bulk | 🟢 Forte; cache não multi-process; weekly cap não enforçado no schedule |
| **7.5** | Auth & segurança | 🟢 Sólido; sem alerta de brute-force; rotação de JWT quebra sessão |
| **7.5** | Proatividade & crons | 🟢 Guards bons; 10/14 regras são dead code (stub) |
| **7.8** | Billing / onboarding / termos | 🟢 Bom; billing de imagem/Vision faltando; cap usa UTC |
| **7.9** | GHL UI loader & gates | 🟢 Gate 2 OK; **Gate 1 vaza** (acima) |
| **8.0** | DB schema & migrations | 🟢 Maduro; falta TTL cron (sparkbot_messages, filter_executions); JSONB sem validação |
| **8.3** | SparkBot webhook & dedup | 🟢 Forte (7 camadas); Stevo-only race em 1 camada |
| **8.6** | Tools registry & gates | 🟢 Melhor. Confirmation/test gate sólidos |

---

## Plano priorizado pra produção

### 🔴 P0 — bloqueia o launch (corrigir antes)
1. **Gate 1 do SparkBot (vaza p/ location sem app)** — add hub-check em `check-admin`. *(teu pedido)*
2. **Follow-up: erros silenciosos do supabase-js (padrão F46)** — `follow-up-scheduler.ts` e `followup/*` fazem `update()/insert()` sem checar `{error}` → perda de dado invisível. Auditar e tratar todos. `follow-up-scheduler.ts:31-53,425`.
3. **F47 — sequência duplicada a cada turno** — `scheduleFollowUps()` cancela+recria N follow-ups por mensagem (contato com 8 turnos = 8 sequências). Já era pendente; o swarm confirma como crítico. `follow-up-scheduler.ts:31-71`.
4. **Handoff ignorado quando lead_history off** — `queue-processor.ts:808` exige `handoffPol.enabled && leadHistory`; se admin liga só o handoff, nunca entrega pro humano. Mudar pra `if (handoffPol.enabled)`.
5. **DELETE global sem filtro de location** — `inbound-webhook-capture.ts:40-54` apaga a 100ª linha mais antiga **globalmente** (cross-location). Add `.eq('location_id', …)`.

### 🟠 P1 — alto (corrigir no hypercare / antes de escalar)
6. **Custom agent CRASHA com `AGENT_MOTOR_UNIFIED=1`** — `assembler.ts:100-105` lança erro; `queue-processor.ts:870` nunca passa `moduleKeys`. **Não ligue a flag até corrigir** (você ia ligar pra modular).
7. **Lead history cache:** (a) chave omite `include_tags` → data loss silencioso (`lead-history.ts:147`); (b) `invalidateLeadHistoryCache()` exportado mas **nunca chamado** → dados velhos até timeout.
8. **Handoff notifica rep errado** — falta `opp.assignedTo` (`handoff-notify.ts:45-50`).
9. **Histórico do SparkBot pode ter msg vazia** → Claude 400 (`processor.ts:436`). Filtrar `content.trim()`.
10. **Billing de imagem/Vision não cobrado** (`processor.ts:690`, `webhook-handler.ts:862`) + **cap mensal usa UTC** não o fuso da location (`charge.ts:250`).
11. **~95 falhas silenciosas** (`console.error` sem `reportError`) — contradiz teu F49 ("todos os erros identificáveis"). Sweep nas rotas `/api`.
12. **Falta TTL cron** pra `sparkbot_messages` e `filter_executions` (acúmulo 30d+).
13. **Race GU-6 × F52** (convState stale, `queue-processor.ts:303 vs 622`) · **coherence loop-breaker com string hardcoded** (`processor.ts:594`) · **timing-match bloqueia silencioso** (`webhook-handler.ts:548`).
14. **Weekly cap não enforçado no schedule** do bulk (só warning no preview, `bulk-messages-v2.ts:445`).
15. **Auth:** sem alerta de brute-force; rotação de `JWT_SECRET` derruba sessões (sem rolling-key).

### 🟡 P2 — estrutural / pós-launch
- **Consolidar os 2 sistemas de follow-up** (A `scheduled_followups` × B `followup_sequences`) — sem exclusão mútua, double-scheduling possível.
- **RLS "security theater"**: 50+ tabelas com RLS mas o app roda como service-role (bypassa tudo). Documentar a fronteira REAL (filtro de location no código) e auditar queries sem `location_id`.
- **JSONB sem validação + CHECKs faltando** (billing aceita negativo; `cron_expression` sem validação).
- **Polling reativo (10 regras stub)** + flags de Prospecção 2.0 OFF — completar ou remover o dead code.
- **Filter cache não multi-process** · **contactId authorization gap** · **xlsx CVE** (`file-processor.ts`).
- **CI pros testes de paridade** (hoje são `tsx` manuais).

---

## Lacunas de cobertura (crítico de completude — não auditadas a fundo, revisar)
Media/Whisper/Vision codec edge cases · rate-limit in-memory (não cross-instance) · cutover Stevo/Evolution (gates OFF) · **xlsx CVE conhecido** · refresh de token (sem endpoint) · outbound channel routing (default SMS sempre) · carrier RAG (VOYAGE_API_KEY missing → throw) · race de inbound concorrente (mutex só intra-lambda).

---

## O que você NÃO precisa se preocupar (refutados pela verificação adversarial)
`claimUnbilledBatch` filtro de location (OK) · drift de exclusão mútua follow-up (não confirmado) · risk levels de `delete_appointment/opportunity` (verificados OK) · cache cross-location bleed do filter (OK) · "motor modular OFF" (intencional) · WhatsApp V2 simulado (intencional MVP).

---

**Próximo passo sugerido:** atacar o **P0** já (são 5 itens, todos pequenos/médios e bem localizados). Posso começar pelo **Gate 1** (teu pedido, ~15 linhas) + os erros silenciosos do follow-up + F47 num lote, com tsc/build/deploy gated.
