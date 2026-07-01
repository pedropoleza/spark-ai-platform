# Estudo — Redução de custo dos agentes lead-facing (venda/recrutamento/custom)

> Pedro, 2026-07-01. Portar a lógica de economia via **cache de tokens** (H44, feita no SparkBot) para os **agentes que falam com o cliente**. Objetivo: **↓ custo por conversa sem perder qualidade** e, de quebra, ↑ efetividade. Aplicar a **todos os agentes de todas as contas**.
>
> Método: 100% baseado em dados reais de produção (30 dias) + leitura do código. Supabase `vyfkpdnwevtuxauacouj`, agentes lead-facing = `sales_agent`/`recruitment_agent`/`custom_agent`.

---

## STATUS

- **Fases 1+2 IMPLEMENTADAS** (2026-07-01), atrás da flag **`LEAD_CACHE_OPTIMIZED`** (default **OFF** = byte-idêntico ao de hoje).
- Arquivos: `sales-prompt-builder.ts` (reposiciona lead history + carrier RAG pro runtime quando otimizado), `queue-processor.ts` (flag + roteia carrier chunks + passa `cacheTtl:"1h"`), `openai-client.ts` (TTL 1h no prefixo estável + breakpoint de histórico, espelhando o SparkBot).
- Gates verdes: `tsc` ✅ · `test-sales-parity` 5/5 ✅ · **`test-lead-cache-parity` 10/10 ✅** (prova system byte-estável + nada perdido) · `test-motor-parity` 7/7 ✅ · `npm run build` ✅.
- **Falta (👤):** merge+deploy (código inerte com flag OFF) → ligar `LEAD_CACHE_OPTIMIZED=1` na Vercel → validar 1 conversa → re-medir (ver `BASELINE.md`).
- **Fase 3 (roteamento Haiku/Sonnet):** fora deste escopo (Pedro escolheu Fases 1+2). Fica pra um próximo ciclo.

---

## TL;DR (o achado principal)

O caminho lead-facing **já separa** system estável × runtime volátil (arquitetura correta do H44). MAS **um cache-buster reintroduz conteúdo volátil DENTRO do system prompt a cada turno** → o cache quebra em ~94% dos turnos → **hoje o cache está CUSTANDO dinheiro em vez de economizar** (paga o prêmio de *cache-write* de 1,25× em 80% do input e quase nunca relê).

- **Custo medido (30d, 9 agentes): $65,04.** Se **desligássemos o cache hoje: $56,78.** → **o cache atual custa +$8,26/mês (+15%).**
- Causa raiz: **carrier RAG** (`queue-processor.ts:833-839`) recupera chunks **pela mensagem do turno** e injeta no `knowledgeBase` → `buildKnowledgeBaseSection` → **system prompt** → muda todo turno. Somam-se: **lead history** (msgs recentes, opt-in) e interpolação de `contactName` no system.
- **Não é problema de TTL:** 85% dos turnos consecutivos da mesma conversa acontecem em **<5 min** (dentro da janela de 5m atual) e mesmo assim o hit é ~0%. Logo, é **volatilidade de conteúdo**, não janela curta.
- **O conserto é o MESMO padrão do H44 F1** ("reposicionar, não reescrever"): tirar o conteúdo volátil do system → runtime (user message). Aí o system fica byte-estável por-agente → cache passa a **acertar** → custo despenca e vira net-positivo.

---

## Evidência (produção, 30 dias, Claude Sonnet 4.6)

Todos os 9 agentes lead-facing **ativos** estão em `claude-sonnet-4-6` (os de OpenAI estão inativos), em **6 contas**. O caminho que importa é o `processWithClaude` (`openai-client.ts`) com `cache_control` explícito.

| Métrica | Valor | Leitura |
|---|---|---|
| Turnos (30d) | 1.301 | baixo volume |
| Input médio/turno | **12.484 tok** | prompt gigante |
| Output médio/turno | 220 tok | razão **57:1** input:output → **custo é input** |
| Cache **WRITE** (creation) | 13,82M (**80% do input**) | paga 1,25× |
| Cache **READ** | 0,78M (**4,8%**) | quase nunca relê |
| **READ/WRITE** | **0,06** | cada write é relido 0,06× → **desperdício** |
| cache_hit_ratio médio | **5,4%** | 94% dos turnos com hit ~0 |
| Custo 30d (real, `usage_records`) | **$65,04** | 80% é cache-write |

**Distribuição dos gaps entre turnos consecutivos (mesma conversa):** `<5m: 85%` · `5–60m: 8%` · `1–6h: 3%` · `>6h: 4%`. → **85% deveria pegar no cache de 5m e não pega.**

**Por agente (os 2 de maior volume dominam):**

| Agente | Turnos | Carrier RAG | Lead history | avg hit |
|---|---|---|---|---|
| Maria — Recrutamento | 904 | SIM (2) | ON | 5,5% |
| Jussara Lima — Vendas | 148 | SIM (2) | ON | 0,0% |
| Agente de Vendas (outra conta) | 57 | SIM (2) | ON | 16,1% |
| demais (6) | ~0–8 | SIM (2) | vários | 0–19% |

**Todos os 9 têm carrier RAG ligado** → o buster é universal.

### Decomposição do custo ($65 / 30d)
- cache-write 13,82M × $3,75/M ≈ **$51,8** ← dominante
- fresh ~2,67M × $3/M ≈ $8,0
- output 0,335M × $15/M ≈ $5,0
- cache-read 0,78M × $0,30/M ≈ $0,2

> O custo é **quase todo cache-write que nunca é lido**. É literalmente pagar 25% a mais pra escrever um cache que expira sem uso.

---

## Causa raiz (o cache-buster)

`buildSystemPrompt(ctx)` monta o system a partir de seções. A ordem tem seções **estáveis** (meta, framing, identidade, instruções do admin, exemplos, regras, agendamento, formato) e **voláteis** que NÃO deveriam estar ali:

1. **Carrier RAG (universal, o principal).** `queue-processor.ts:826-844`: se `enabled_kbs` está setado (todos os 9 têm), chama `retrieveCarrierKnowledge(enabledKbs, group.aggregatedBody, 3)` — **RAG pela mensagem do turno** — e dá `knowledgeBase.push(...)`. Esse array vai pro `buildKnowledgeBaseSection` → **system**. Cada turno tem chunks diferentes → system diferente → **miss garantido**. (Qualquer mudança no system = miss total, porque o único breakpoint fica no fim do bloco.)
2. **Lead history (opt-in, ON em vários).** `buildLeadHistorySection` (no system, via `buildSystemPrompt:125`) inclui `recent_messages.slice(0,10)` — se recarregado com as msgs novas, muda por-turno.
3. **`contactName` interpolado** no `buildCustomInstructionsSection` (system) — muda 1× quando o nome é aprendido (por-conversa, não por-turno) e **quebra reuso cross-conversa** de todo jeito.

Comparação com o SparkBot (H44): **mesma causa raiz** (volátil no prefixo cacheado), **buster diferente** (lá era o `conversationalLayer`; aqui é o carrier RAG + lead history). Diferença agravante: aqui o cache está **net-negativo hoje** (no SparkBot estava subaproveitado, mas não custava a mais).

---

## O conserto (fases)

### Fase 1 — Reposicionar o volátil (o coração, espelha H44 F1) 🎯
Tirar do **system** e mandar pro **runtime context** (user message), mantendo no system só o que é byte-estável por-agente:
- **Carrier RAG chunks** → do `buildKnowledgeBaseSection` para o `buildRuntimeContext`. A KB **estática do agente** (cadastrada, `knowledge_base` por `agent_id`) **fica** no system (estável, cacheável). Só os chunks recuperados-por-mensagem vão pro runtime. **Sem perda de qualidade** — os chunks continuam presentes, e ficam até mais perto da pergunta.
- **Lead history** → runtime (ou congelar por-conversa: carregar 1× e não reinjetar msgs novas no system).
- **`contactName`** → avaliar tokenizar ou mover a interpolação (menor prioridade; ganho é cross-conversa).

**Resultado:** system byte-estável por-agente → os 85% de turnos <5m viram **cache-READ** → e reuso **cross-conversa** (o mesmo agente atende N leads e reusa o prefixo). Cache passa de net-negativo a fortemente net-positivo.

### Fase 2 — TTL 1h no inbound + breakpoint de histórico (espelha H44 F3/F4)
Com o cache **funcionando**, portar o `cacheTtl "5m"|"1h"` do `llm-client.ts` pro `openai-client.ts`: **1h no inbound** pega os 8% de gaps 5–60min e amplia o reuso cross-conversa. Opcional: 2º breakpoint no fim do histórico estável (turns antigos byte-exatos).

### Fase 3 — Roteamento de modelo por turno (efetividade + custo) — **decisão do Pedro**
Output é minúsculo (220 tok) e input domina. Rotear turnos **simples** (saudação, coleta de 1 dado, confirmação) pro **Haiku 4.5** (input $1/M vs Sonnet $3/M = **3× mais barato** no que pesa) e manter **Sonnet** nos turnos **complexos** (objeção, agendamento, mídia). É a alavanca que também **melhora efetividade** (modelo forte onde importa). Risco de qualidade → atrás de flag + sinais.

### Fase 4 (opcional) — Enxugar o prompt
12,5K tok de input é muito. Trim de seções redundantes + KB por relevância (top-k) reduz o custo do fresh/read. Secundário (o cache resolve o grosso).

---

## Impacto estimado

Assumindo system estável ≈ 7K tok (≈56% do input) e variável ≈ 5,5K, com cache quente (85% dos turnos <5m):

- **Hoje:** ~$0,050/turno · **$65/mês** (net-negativo vs sem-cache).
- **Pós-Fase 1:** ~$0,029/turno · **≈ $38/mês** → **~42% de economia (~$27/mês)**, e vira net-positivo.
- **+ Fase 2 (1h + histórico) e Fase 3 (Haiku nos simples):** empurra pra **~$25–30/mês**.

E o mais importante: **escala**. É mudança de **código** (não por-conta) → vale pra todos os agentes de todas as contas no deploy, e a economia por-conversa **compõe** conforme a plataforma cresce (a 100 agentes: ~$300 → ~$175/mês só na Fase 1).

**Qualidade:** Fase 1 e 2 são neutras (o mesmo conteúdo, só reposicionado + cache) — protegidas por teste de **paridade** de conteúdo. Fase 3 é a única com risco, e fica atrás de flag + validação.

---

## Rollout & segurança (aplicar a todas as contas)

1. **Baseline:** snapshot das queries acima (hit ratio, $/mês, R/W) — `BASELINE.md`.
2. **Código, não dado:** conserto em `openai-client.ts` + `sales-prompt-builder.ts` + `queue-processor.ts`. Deploy único → **todos os 9 agentes / 6 contas** de uma vez (e futuros).
3. **Flag + paridade:** mudança de comportamento do prompt atrás de flag; `test-sales-parity.ts` garante que o CONTEÚDO entregue ao modelo é o mesmo (só muda de system→runtime). Validar 1 conversa real antes do rollout.
4. **Re-medir:** rodar as queries de novo pós-deploy — `cache_creation` deve despencar, `cache_read` subir, `$/mês` cair. Sinal se não cair.
5. **Reversível:** flag OFF volta ao comportamento atual; commit isolado.

---

## Decisões abertas pro Pedro

1. **Escopo agora:** só Fases 1+2 (cache — ganho certo, risco ~zero) **ou** já incluir a Fase 3 (roteamento Haiku/Sonnet — mais economia + efetividade, mas precisa de validação de qualidade)?
2. **Roteamento (se sim):** por heurística determinística (comprimento/estágio/tem-mídia) — barato e previsível — ou um classificador leve (mais preciso, +latência)? Recomendo heurística primeiro.
3. **Lead history no system:** mover pra runtime (melhor pro cache) — confirmo que não muda o comportamento observável (é o mesmo texto, outro lugar).

---

## Arquivos/linhas-chave
- Cliente lead-facing (cache): `src/lib/ai/openai-client.ts` (`processWithClaude`, `systemBlocks` L394-396).
- Builder: `src/lib/ai/sales-prompt-builder.ts` (`buildSystemPrompt` L94, `buildRuntimeContext` L191, `buildKnowledgeBaseSection` L862).
- Buster: `src/lib/queue/queue-processor.ts` L826-844 (carrier RAG), L809-824 (KB/feedback), L962-969 (system+runtime), L1049 (`processWithAI`).
- Padrão a espelhar (SparkBot H44): `src/lib/account-assistant/llm-client.ts` L131-135, L370-402, L434-451.
- Uso/custo: `execution_log` (`action_type='ai_processing'`, `action_payload.cache_hit_ratio`) + `usage_records` (`cached_tokens`, `cache_creation_tokens`, `cost_usd`).
