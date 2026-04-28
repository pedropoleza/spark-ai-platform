# Stress Test 01 — NLG Underwriting (Sparkbot Account Assistant)

**Data:** 2026-04-28
**Endpoint:** `POST /api/agents/account-assistant/synthetic-test`
**Rep:** `+17867717077`
**Session:** `6f11a44e-1b9a-4c45-a8a0-5b5e07d0b8de`
**Persona:** Agente brasileiro nos EUA, 8-10 turnos sobre National Life Group (FlexLife, FN, NY, 1035, riders).

---

## 1. Resumo executivo

- **10/10 turnos completaram sem timeout/erro.** Todas respostas geradas, em PT-BR, com hedging adequado em pontos de baixa confiança.
- **8/10 turnos chamaram `query_carrier_knowledge`** (80%). 2 turnos sem tool call (T9 comparison WL vs FlexLife, T10 fluxo de illustration) — preocupante o T9, ver findings.
- **100% dos tool calls usaram `kb=national_life_group`** correto.
- **`category_hint` correto em todas as chamadas** (underwriting, product, rider, compliance, process, commission).
- **Resposta cita fonte em 6/10 turnos** explicitamente (Cat 62797(0126) ou outras). Nos turnos sem tool, fonte é mais vaga.
- **Hedging presente** em casos apropriados (T1, T4 sobre cap NY/$2M unverified, T6 tier do Brasil unverified).
- **NÃO inventou regras estruturais**. Pequena imprecisão em T7 sobre comissão (nº "8 anos" não confirmável na KB sem ver chunk) — verificar.
- **Coerência entre turnos forte:** T2 referencia perfil definido em T1 (52 anos, A1c 7.2). T4 mantém contexto NY ao longo. T10 conecta com produtos discutidos em T9.

**Risco crítico:** **Model drift Claude→GPT-4.1 em 4/10 turnos** (T3, T7, T8, T9). Provavelmente fallback automático ou rotation, mas T9 (sem tool call) usou GPT-4.1 — pode estar correlacionado com falha de tool use.

---

## 2. Métricas agregadas

| Métrica | Valor |
|---|---|
| **Total turnos** | 10 |
| **Turnos OK** | 10 (100%) |
| **Turnos com `query_carrier_knowledge`** | 8 (80%) |
| **Total tool calls** | 10 (média 1.0/turno; 2 turnos com 2 calls) |
| **Total prompt tokens** | 222,026 |
| **Total cached tokens** | 167,371 (75.4% do prompt — cache hit excelente) |
| **Total uncached prompt tokens** | 54,655 |
| **Total completion tokens** | 4,464 |
| **Total duration** | 270,028 ms (≈ 4 min 30 s wall) |
| **Latência média/turno** | 27,003 ms |
| **Latência mediana** | ~26,300 ms |
| **Pico latência** | T2 = 57,574 ms (insulina) |
| **Mínimo latência** | T10 = 8,445 ms (sem tool) |
| **Custo total estimado (mixed)** | **~$0.345** |
| **Custo médio/turno** | $0.0345 |
| **Modelos usados** | claude-sonnet-4-6 (6×), gpt-4.1 (4×) |

**Pricing assumido:**
- Claude Sonnet 4.5/4.6: $3/M input, $0.30/M cached read, $15/M output
- GPT-4.1: $2/M input, $8/M output (no cache pricing)

> Observação: o cache hit de 75% é o maior driver de eficiência do bot — pelo prompt-builder estar cacheado, cada turno só paga ~$0.03 em vez de ~$0.10+.

---

## 3. Detalhe por turno

### Turno 1 — Diabético T2 + Metformina, rate class FlexLife

- **Modelo:** claude-sonnet-4-6
- **Tools:** `query_carrier_knowledge` (kb=national_life_group, hint=underwriting, q="diabetes tipo 2 A1c 7.2 Metformina rate class underwriting FlexLife")
- **Tokens:** prompt=5,398 / completion=520 / cached=0 (primeiro turno, cache vazio)
- **Duration:** 14,047 ms
- **Resposta resumida:** Sinaliza APS auto-trigger pra histórico de diabetes (EZ UW fora). A1c 7.2 acima do threshold ideal <7.0. Standard NT é o mais provável; Preferred bloqueado por EZ UW. Sugere XRAE + Sales Desk 800-906-3310. Pede info adicional (BMI, complicações, tempo de diagnóstico). Cita fonte: UW Guide Cat 62797(0126).
- **Crítica:** **EXCELENTE.** Hedging forte ("não promete Standard sem confirmar"), pede dados faltantes em vez de inventar, cita fonte primária. Estrutura ideal de resposta médica.

### Turno 2 — E se ele tomasse insulina há 3 anos?

- **Modelo:** claude-sonnet-4-6
- **Tools:** `query_carrier_knowledge` (hint=underwriting)
- **Tokens:** prompt=28,466 / completion=411 / cached=23,062 (cache kicks in)
- **Duration:** 57,574 ms ⚠️ **Pico — investigar**
- **Resposta resumida:** Insulina é flag direto, full UW obrigatório, expectativa cai pra Table B/C. Alerta sobre Express Standard NT 2 (E-H) que **perde Living Benefits e LIBR**. Mantém XRAE + Sales Desk como CTA.
- **Crítica:** **MUITO BOM.** Coerência perfeita com T1 (não repete dados, só ajusta). Insight crítico sobre perda de riders em Table E-H é VALIOSO comercialmente. Único ponto: 57s de latência é alto — provavelmente reasoning estendido ou retry interno.

### Turno 3 — Diferença ABR vs LIBR

- **Modelo:** **gpt-4.1** (drift Claude→GPT)
- **Tools:** `query_carrier_knowledge` (hint=rider, q="Qual a diferença entre o ABR e o LIBR?")
- **Tokens:** prompt=19,603 / completion=348 / cached=10,368
- **Duration:** 25,833 ms
- **Resposta resumida:** ABR = Living Benefits (terminal/crônico/crítico/Alzheimer/fertilidade), sem custo extra, reduz death benefit. LIBR = Lifetime Income, idade 60+ + 10/15 anos in-force, fee anual, garantia de pagamento mesmo cash zerado. **Bloqueio em Express Standard NT 2.**
- **Crítica:** **CORRETO.** Conecta com T2 (Express NT 2 sem LIBR), mostra coerência. Hint "rider" foi acertado. Único ruído: cita "Insurance & Estates guides" sem cat number — fonte secundária. ABR escopo correto.

### Turno 4 — FlexLife $250k em NY

- **Modelo:** claude-sonnet-4-6
- **Tools:** **2 calls** — (a) hint=product, q="FlexLife NY regras...", state="NY"; (b) hint=compliance, q="Reg 187 NY compliance venda FlexLife", state="NY"
- **Tokens:** prompt=32,497 / completion=673 / cached=23,823
- **Duration:** 32,411 ms
- **Resposta resumida:** Sufixo NL obrigatório (LSW não opera NY). Reg 187 Best Interest Standard treinamento obrigatório. Cap rates menores em NY — confirmar no portal. US Pacesetter precisa marcar como hypothetical/backtested (cita class action Virani v NLG). Ilustração assinada via iGo. **$2M max face NY marcado como unverified — confirma**.
- **Crítica:** **MUITO BOM.** Estado NY corretamente passado em ambas chamadas. Cita class action específica (Virani v NLG) — ponto FORTE de risco real. Hedge sobre $2M é exatamente o esperado. 2 tool calls separadas (product + compliance) mostram bom planejamento.

### Turno 5 — PeakLife vs FlexLife (HNW max accumulation)

- **Modelo:** claude-sonnet-4-6
- **Tools:** `query_carrier_knowledge` (hint=product)
- **Tokens:** prompt=31,615 / completion=459 / cached=25,190
- **Duration:** 34,048 ms
- **Resposta resumida:** FlexLife = middle market, target ≤$1M. PeakLife = HNW, min face $1M, premium funding, full UW 2-4 sem. Mesmas crediting strategies + riders. Alerta: PeakLife underfunded <$1M = COI implode. Menciona SummitLife pra wealth transfer + Estate Preservation Rider.
- **Crítica:** **EXCELENTE.** Insight COI implosion abaixo de $1M é exatamente o que rep precisa saber. Sugere ForeSight + Advanced Markets como CTA correto.

### Turno 6 — Brasileiro H1B, 4 anos US, FN elegível?

- **Modelo:** claude-sonnet-4-6
- **Tools:** `query_carrier_knowledge` (hint=underwriting, q="Foreign National brasileiro H1B...")
- **Tokens:** prompt=31,952 / completion=631 / cached=26,032
- **Duration:** 16,045 ms
- **Resposta resumida:** Brasil = Tier B → best class é Preferred (Elite n/a). H1B = work nexus OK. Confirmar 1 dos nexus formais (imóvel/business/casamento US/$100K assets 3+ meses). Permanente only, $500K-$15M, ages 18-70, venda/assinatura/conta US. Documentos: passaporte, H1B, I-94, FNQ (Cat 50038), comprovante nexus, conta bancária US. **Estate/gift tax: Brasil sem treaty, exemption $60K** — recomenda CPA/tax attorney. Hedge: tier list reorganizada Jan/2026 — confirma.
- **Crítica:** **OURO.** Resposta mais COMPLETA da sessão. Nexus formal, doc list completa, alerta tax ($60K exemption) é exatamente o tipo de info crítica que rep brasileiro perde. Hedge sobre tier reorganization é honesto. Cita FNQ Cat 50038. Latência baixa apesar do volume — bom.

### Turno 7 — 1035 exchange + comissão em replacement

- **Modelo:** **gpt-4.1**
- **Tools:** **2 calls** — (a) hint=process, q="Como funciona o 1035 exchange..."; (b) hint=commission, q="A comissão diminui se eu fizer replacement..."
- **Tokens:** prompt=24,975 / completion=469 / cached=17,536
- **Duration:** 22,347 ms
- **Resposta resumida:** Process: ForeSight → iGo → replacement forms (Reg 60 NY) + ID + voided check. 2-4 sem (sem APS), 4-8 sem (com APS). Comissão: **8+ anos = full commission até target; <8 anos = reduzida**. Term-to-perm sempre full. Excess premium acima target = ~3-5%. Surrender charge pode ser waivado. Cat 104736(0725) citado.
- **Crítica:** **BOM, mas 1 alerta.** O número "8 anos" como threshold de comissão precisa ser verificado contra a KB — Cat 104736 é citado mas não tenho como confirmar se a KB tem esse threshold ou se é interpolação do GPT-4.1. **Recomendação: validar no chunk source.** Resto da resposta (process, surrender waiver, contestabilidade) é correto.

### Turno 8 — Cliente pede desconto na primeira premium

- **Modelo:** **gpt-4.1**
- **Tools:** `query_carrier_knowledge` (hint=compliance)
- **Tokens:** prompt=21,550 / completion=203 / cached=18,944
- **Duration:** 32,548 ms
- **Resposta resumida:** **NÃO PODE prometer desconto.** Anti-rebate laws — violação séria de licença. Premium tem que ser exatamente o da illustration. Risco: chargeback, cancelamento, investigação regulatória. Cita NLG illustration guidelines + NAIC compliance.
- **Crítica:** **CORRETO E DIRETO.** Resposta curta e firme — exatamente o tom para compliance. Sem hedging porque o tema é absoluto. Único: completion 203 tokens é a mais curta — pode ter sido conservador demais (não cita exemplos de prática), mas pra esse caso é OK.

### Turno 9 — Whole Life vs FlexLife (cliente conservador 65 anos) ⚠️

- **Modelo:** **gpt-4.1**
- **Tools:** **NENHUMA** ⚠️ **PROBLEMA CRÍTICO**
- **Tokens:** prompt=10,151 / completion=448 / cached=8,960
- **Duration:** 26,730 ms
- **Resposta resumida:** Whole Life NLG (TotalSecure NL, BasicSecure NL): premium/DB/CV fixos, dividendos 170+ anos. FlexLife: IUL com index, cap/floor, LIBR. Recomenda WL pra cliente conservador 65 anos.
- **Crítica:** **PROBLEMA — não chamou tool.** Resposta tem detalhes técnicos (TotalSecure NL, BasicSecure NL, "170+ anos de dividendos") que **podem estar inventados ou interpolados**. O bot deveria ter chamado `query_carrier_knowledge` com hint=product pra confirmar produtos WL exatos da NLG. **Sem fonte citada.** "BasicSecure NL" não foi mencionado em nenhum turno anterior nem em fontes de KB conhecidas. **Risco de hallucination.**

### Turno 10 — Como peço illustration pra esse caso?

- **Modelo:** claude-sonnet-4-6
- **Tools:** **NENHUMA** (questão de fluxo, KB já carregada implicitamente?)
- **Tokens:** prompt=15,819 / completion=302 / cached=13,456
- **Duration:** 8,445 ms (mais rápido — não chamou tool)
- **Resposta resumida:** ForeSight self-service (agent.nationallife.com) ou Sales Desk 800-906-3310 (Advanced Markets) pra casos complexos. NY: ilustração assinada antes do app (Reg 187). US Pacesetter como hypothetical. **Pergunta CTA:** "Quer que eu crie uma task pra você rodar o ForeSight hoje ou amanhã?"
- **Crítica:** **OK, mas faltou tool.** Já tinha context dos turnos anteriores, então skip de tool é defensável. CTA sobre criar task é bom (engagement). Não inventou nada. Coerente com T4 (Reg 187, US Pacesetter disclaimer).

---

## 4. Findings

### O que o bot ACERTOU bem

1. **Cache hit excepcional (75% do prompt cacheado)** — cost-efficient.
2. **Hedging adequado em casos de baixa confiança** — T4 ($2M max NY), T6 (tier reorganization), T1 (não promete Standard sem XRAE).
3. **CTA consistente** — sempre Sales Desk 800-906-3310, XRAE, ForeSight, Advanced Markets — exatamente o que rep precisa.
4. **Coerência multi-turno** — T2 lembra perfil de T1, T4 mantém NY, T10 conecta produtos T9.
5. **Insights comerciais valiosos** — Express Standard NT 2 perde LIBR (T2), COI implosion PeakLife <$1M (T5), $60K estate tax exemption Brasil (T6), class action Virani v NLG (T4).
6. **PT-BR natural** — gírias adequadas ("tô", "rola"), não forçado.
7. **Compliance firme em T8** — sem hedge em tema absoluto (anti-rebate).
8. **`category_hint` sempre correto** em todos os 10 tool calls — prompt-builder está bem estruturado.
9. **`state` parameter usado em T4** quando havia contexto regional NY.
10. **Cita fonte específica (Cat 62797(0126))** quando faz tool call e tem fonte primária.

### O que o bot ERROU ou suscitou DÚVIDA

1. **T9 SEM TOOL CALL** — pergunta direta sobre produtos NLG (Whole Life vs FlexLife) deveria ter triggered tool. Bot retornou nomes de produtos ("TotalSecure NL", "BasicSecure NL") **sem fonte**, e "BasicSecure NL" não foi confirmado nos turnos anteriores. **Risco de hallucination.** ⚠️
2. **T7 — número "8 anos" como threshold de comissão** — cita Cat 104736(0725) mas precisa ser verificado contra o chunk real. Se for interpolação do GPT-4.1, é alucinação numérica grave (impacto direto na compensation do rep).
3. **Model drift Claude→GPT-4.1 em 4/10 turnos** sem padrão claro:
   - T3 (rider) → GPT-4.1
   - T7 (1035 + comissão) → GPT-4.1
   - T8 (compliance) → GPT-4.1
   - T9 (WL vs FlexLife) → GPT-4.1 ⚠️
   - Todos os outros → claude-sonnet-4-6
   - **Hipótese:** rotation/fallback automático ou load balancing. T9 é o mais preocupante porque coincidiu com falta de tool call.
4. **T10 sem tool call** — defensável (já tinha context), mas info sobre process de illustration tem variantes por estado/produto que poderiam ter sido confirmadas.
5. **Latência alta em T2 (57s)** — outlier vs média 27s. Possível retry interno ou reasoning estendido. Investigar logs.
6. **Não menciona ForeSight como tool a perguntar** em T1, T2, T6 — só sugere genérico ("XRAE + Sales Desk"). ForeSight é o tool primário pra illustration — poderia ter sido sugerido mais cedo.

### Padrões problemáticos

- **Quando o bot acha que "já tem context suficiente", ele skipa tool calls** — isso é OK pra fluxo (T10), mas em T9 levou a possível hallucination de produto. **Threshold de "skip tool" precisa ser conservador em queries sobre produtos específicos.**
- **GPT-4.1 nos 4 turnos parece ter sido mais "creative" / menos preso à KB** — em T7 e T9, especificamente, há detalhes que parecem extrapolar.
- **Falta validação de números proprietários** (8 anos commission, $2M NY max) — bot cita mas não tem como verificar 100%. Hedge é a saída atual, mas seria melhor ter validação cruzada.

---

## 5. Recomendações concretas

### Prompt-builder (system prompt do agente)

1. **REGRA DURA: produto NLG específico = sempre `query_carrier_knowledge` ANTES de responder.**
   Adicionar no system prompt:
   > "Toda menção a produto NLG (FlexLife, PeakLife, SummitLife, TotalSecure NL, BasicSecure NL, etc.) DEVE ser precedida por `query_carrier_knowledge` com hint='product'. NUNCA cite nome de produto sem confirmar pela KB."
2. **REGRA DURA: número proprietário (anos, %, $ thresholds) só pode ser citado se vier do chunk retornado, com fonte explícita.**
   > "Se citar 'X anos', 'Y%', '$Z máximo' — só cite se aparecer literalmente no chunk retornado. Caso contrário, marque [unverified] e direcione pro Sales Desk."
3. **Forçar tool call em queries comparativas** ("X vs Y", "diferença entre", "qual escolher") — adicionar trigger explícito.
4. **Sugerir ForeSight + XRAE + Sales Desk como triple-CTA padrão** em queries de underwriting/produto.

### Tool description (`query_carrier_knowledge`)

1. **Adicionar exemplos negativos** na tool description:
   > "NÃO use se a pergunta for puramente operacional (ex: 'como criar task'). USE SEMPRE se: nome de produto NLG, % rate, $ threshold, comparison entre produtos, eligibilidade FN, regra de estado."
2. **Encorajar 2 calls em queries multi-tópico** (replacement = process + commission, NY = product + compliance) — já está acontecendo organicamente em T4, T7, mas pode ser mais consistente.

### Model routing

1. **Investigar rotation Claude→GPT-4.1.** Se for fallback de erro, logar quais turnos. Se for load-balancing, considerar lock no claude-sonnet-4-6 pra Account Assistant (queries técnicas precisam de fidelidade alta à KB; GPT-4.1 mostrou maior tendência a interpolar).
2. **Forçar claude-sonnet-4-6 quando o turno envolve produto/numérico** — fallback pra GPT-4.1 só pra queries genéricas (saudação, fluxo).

### KB / Chunks

1. **Validar chunk de comissão** (Cat 104736(0725)) — confirmar se contém literalmente "8 anos = full commission" ou se isso é interpolação do GPT-4.1.
2. **Adicionar chunk dedicado a Whole Life NLG** (TotalSecure NL, BasicSecure NL — se forem produtos reais) com cat number e regras. Isso preencheria a lacuna que causou T9 sem tool.
3. **Chunk explícito sobre fluxo de illustration** (T10) — process step-by-step ForeSight + iGo + state-specific signing — pra que tool call seja triggered consistente.

### Logging / observability

1. **Logar `model_used` por turno** — já está sendo retornado, mas alertar quando há rotation.
2. **Logar duração detalhada** (model latency vs tool latency vs total) — T2 com 57s precisa de breakdown.
3. **Métrica de "% turnos com tool call"** como SLI — meta: ≥85% pra Account Assistant em queries técnicas.

---

## Apêndice — Session info

- **session_id:** `6f11a44e-1b9a-4c45-a8a0-5b5e07d0b8de`
- **rep_id:** `1eeb02cc-1a48-4b56-b177-52dcbca07ac2`
- **rep_phone:** `+17867717077`
- **Total turnos:** 10
- **Sucesso:** 10/10 (sem timeouts)
- **Custo total:** ~$0.345 USD
- **Wall clock total:** 4 min 30 s
