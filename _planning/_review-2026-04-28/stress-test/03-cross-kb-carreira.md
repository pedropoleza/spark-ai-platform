# Stress Test 03 — Cross-KB & Carreira (10 turnos)

**Data:** 2026-04-28
**Endpoint:** `POST /api/agents/account-assistant/synthetic-test`
**Rep:** `+17867717077`
**Session ID:** `8113e3f1-ed85-45e0-a02e-0666be9b2618`
**Foco:** Validar consulta SIMULTÂNEA aos 2 KBs (national_life_group + agency_brazillionaires) e jornada de carreira (prova → fingerprint → contrato → venda → comissão).

---

## 1. Resumo executivo

Sparkbot tem desempenho **MUITO BOM** em integração cross-KB. Em 8 dos 10 turnos (80%) chamou os 2 KBs em paralelo e produziu respostas que **integram coerentemente** os dois lados (técnico NLG + processo de campo Brazillionaires). A separação narrativa "LADO NLG / LADO BRAZILLIONAIRES" foi consistente do turno 1 ao 9, com finais "RESUMO" sintetizando os dois.

**Ponto forte central:** o bot demonstrou compreensão clara da hierarquia **National Life > Five Rings > Brazillionaires** (turno 7), explicando corretamente que comissão é paga DIRETO pela NLG ao agente (não pelo Brazillionaires/Five Rings), que upline override também sai da NLG, e que o Brazillionaires é "franquia dentro do Five Rings focada no mercado brasileiro". Isso é nuance avançada que muitos reps reais erram.

**Ponto fraco crítico:** turno 6 (fingerprint diabético) — bot **alucinou** que NLG exige fingerprint do CLIENTE pra liberar UW (isso não existe; fingerprint é processo de licenciamento DO AGENTE, não do segurado). Não chamou nenhum KB e respondeu com confiança em info inventada. Modelo usado neste turno foi `gpt-4.1` (todos os outros foram `claude-sonnet-4-6`) — possível causa-raiz: roteamento divergente.

**Tool usage:** 16 chamadas totais distribuídas como **8x national_life_group + 8x agency_brazillionaires** — perfeitamente balanceado nos turnos cross-KB. Turnos 6 e 10 não chamaram tools (turno 10 usou cache/contexto do turno 7 com sucesso; turno 6 falhou).

**Custo & latência:** ~26s/turno (avg), ~333k tokens totais com 73% de cache hit (237k cached / 326k prompt) — eficiência boa, mas latência média de ~26s ainda é alta pra UX conversacional via WhatsApp.

---

## 2. Métricas agregadas

| Métrica | Valor |
|---|---|
| Turnos | 10 |
| Tempo total | 255.9s (~4min 16s) |
| Tempo médio/turno | **25.6s** |
| Tempo máximo (turno 7) | 41.6s |
| Tempo mínimo (turno 5) | 18.8s |
| Tokens prompt totais | 326,599 |
| Tokens cached totais | 237,331 (**72.7% hit**) |
| Tokens completion totais | 8,888 |
| Total tool calls | **16** |
| Turnos com 2 KBs (dual-KB) | **8/10 (80%)** |
| Turnos sem tool call | 2 (turnos 6 e 10) |
| Modelos usados | claude-sonnet-4-6 (9), gpt-4.1 (1 — turno 6) |
| KB calls — national_life_group | 8 |
| KB calls — agency_brazillionaires | 8 |

**Custo estimado** (Sonnet 4.6 fresh ≈ $3/M input, $15/M output, cached ≈ $0.30/M):
- Fresh prompt: (326k − 237k) × $3 = **~$0.27**
- Cached: 237k × $0.30 = **~$0.07**
- Completion: 8.9k × $15 = **~$0.13**
- **Total da sessão de 10 turnos: ~$0.47**

---

## 3. Detalhe por turno

### Turno 1 — "Passo-a-passo da primeira venda FlexLife"
- **Latency:** 26.2s
- **Tools:** 2 (agency_brazillionaires + national_life_group)
- **Resposta:** Estruturou em "LADO BRAZILLIONAIRES" (field trainer, docs por status migratório: cidadão/Green Card/visto/turista) + "LADO NLG" (ForeSight → iGo → Resonant → e-delivery). Citou alertas (NY → FlexLife NL, 60+ physical 24m), timeline (EZ 1-7d, paramed 2-4sem, APS 4-8sem) e fonte (Cat 62797(0126) + Brazillionaires verificado mai/2025).
- **Observação:** Resposta exemplar. Integrou os 2 KBs sem confundir, citou fonte com data de verificação. Termina com CTA pra task no CRM.

### Turno 2 — "Brasileiro 2 anos com Visa de turista"
- **Latency:** 23.3s
- **Tools:** 2 (NLG + Brazillionaires)
- **Resposta:** NLG side: Brasil é Tier B, FlexLife IUL only (no Term), best rate Preferred (no Elite), face min $500K/max $15M, ages 18-70. Crítico: NEXUS exigido pra B1/B2 (imóvel próprio, business, casado com cidadão, $100K assets 3+ meses, ou EB-5). Sem nexus = no submission. Tax: Brasil sem treaty estate/gift, $60K isenção NRFN. Brazillionaires side: docs (DL, visto, passaporte, ITIN/W8BEN+CPF, I-94).
- **Observação:** Excelente. Mencionou "Lista de países marcada como [unverified na versão Jan/2026] — confirma com Sales Desk 800-906-3310" — comportamento ideal de avisar staleness. Diferenciou bem Tier B vs Tier A.

### Turno 3 — "NY $500k Reg 187 + Rita"
- **Latency:** 25.6s
- **Tools:** 2 (NLG + Brazillionaires)
- **Resposta:** NLG side: Reg 187 training obrigatório antes do app, fact-finder + suitability + cover letter. FlexLife NL (não FlexLife padrão). Cap NY menor. Compliance illustration: nunca "histórico" do Pacesetter, mostrar guaranteed/non-guaranteed lado a lado, nunca "seu dinheiro tá no mercado". Brazillionaires side: 3 encontros (consultivo, não venda direta), Napkin Presentation no 2º. Frase "Eu não vim aqui te vender nada".
- **Observação:** Resposta forte. Capturou "estilo Rita" via abordagem consultiva da agência. Citou similarity 0.61 do compliance chunk (transparente sobre confiança do retrieval).

### Turno 4 — "Prova → carreira → contrato → venda → pagamento"
- **Latency:** 26.9s
- **Tools:** 2 (NLG + Brazillionaires)
- **Resposta:** 5 etapas: prova (Kaplan), NIPR, contracting@fiveringsfinancial.com → SureLC → writing numbers, primeira venda (ForeSight + iGo + Resonant), pagamento (CTP 80-95% / excess 3-5% / renewal 2-3% / vested vs service fee non-vested). Comentou chargeback risk.
- **Observação:** Pergunta puramente de carreira, mas bot puxou dos 2 KBs e respondeu completo. Mencionou "fingerprint não pra licença NY resident" — info correta (NY não exige). Boa nota: distinguiu vested (renewal) de service fee (non-vested).

### Turno 5 — "Custos pra entrar: NLG vs Brazillionaires/Five Rings"
- **Latency:** 18.8s (mais rápido!)
- **Tools:** 2 (NLG + Brazillionaires)
- **Resposta:** Curso Xcel $49.99 (vs $199 original, link Brazillionaires), prova $40-80, licença NIPR $50-150. Total $150-300. Recorrente: renovação + CE, E&O ~$300-600/ano. NLG: appointment GRATUITO via Five Rings, ferramentas (ForeSight/iGo/Resonant) gratuitas, sem mensalidade. Citou "comprou uma franquia" do Brazillionaires.
- **Observação:** Diferenciou bem o que é custo NLG (zero pra agente) vs custo de licenciamento (estado) vs treinamento (Brazillionaires barato). Avisou staleness: "chunks Brazillionaires verificados 2020-2025, valores podem ter atualizado".

### Turno 6 — "Cliente diabético com fingerprint pendente" ⚠️
- **Latency:** 23.6s
- **Tools:** 0 (NENHUMA)
- **Modelo:** **gpt-4.1** (único turno que não foi sonnet-4-6)
- **Resposta:** "Primeiro resolve o fingerprint. A NLG só libera o UW (via iGo) depois que o fingerprint está registrado e aprovado no sistema. Se tentar começar o app antes, vai travar na checagem de background."
- **Observação:** **ALUCINAÇÃO GRAVE.** Fingerprint é requisito de **licenciamento de agente** (alguns estados como FL/CA exigem fingerprint do agente pra emitir licença), NÃO do cliente. Cliente diabético precisa de APS/UW médica, não fingerprint. Bot confundiu o contexto da pergunta (interpretou "cliente diabético com fingerprint pendente" como se cliente precisasse do fingerprint, quando provavelmente era o AGENTE com fingerprint pendente da licença). Pior: respondeu com confiança total, sem chamar KB, sem disclaimer. **Causa-raiz provável:** gpt-4.1 respondeu por contexto in-memory sem invocar tools, indicando que o roteamento de modelo + decisão de tool-use não está consistente.

### Turno 7 — "Hierarquia NLG > Five Rings > Brazillionaires"
- **Latency:** 41.6s (mais lento — turno mais denso)
- **Tools:** 2 (NLG + Brazillionaires)
- **Resposta:** Excelente.
  - **NLG:** carrier; emite, faz UW, paga comissão direto via direct deposit. Não fala com agente direto — passa pelo IMO.
  - **Five Rings:** IMO/MGA. Faz contrato via SureLC, define escadinha, fornece treinamento/eventos. Override do upline vem da NLG, não do bolso do agente.
  - **Brazillionaires:** sub-agência/franquia DENTRO do Five Rings, focada no mercado brasileiro. Não emite, não paga.
  - Escadinha: 45% entrada → 50% ($5K) → 55% ($20K) → ... → 90% Blackjack ($156K/12m). 75/25 split (1ª contribuição vs aniversário 1 ano).
- **Observação:** Hierarquia explicada com precisão profissional. "NLG paga direto pro agente" — verdade crítica (muitos reps acham que comissão passa pelo upline). Avisou staleness dos %s da escadinha (mai/2020).

### Turno 8 — "IUL University Aula 1 → produto NLG real"
- **Latency:** 23.8s
- **Tools:** 2 (Brazillionaires + NLG)
- **Resposta:** **Insight excelente:** "A IUL University Aula 1 é conceitual — não é pra apresentar pro cliente. O Gustavo deixa isso claro: 'não pegue esses conceitos e leve pra apresentar ao cliente'." Aula cobre evolução WL→UL→VUL→IUL, dois componentes IUL, cap/floor, MAC. Produto real = **FlexLife II** (90-95% dos casos, 0-85, $50K-$10M+, floor 0%, cap S&P 500 P2P 9.25% [unverified], LBR sem custo). NY = FlexLife NL.
- **Observação:** Bot capturou nuance pedagógica do Brazillionaires (separação "estuda fundo, apresenta simples"). Conectou conceitos da Aula 1 (cap/floor/MAC) ao FlexLife II concretamente. Marcou cap como "[unverified]" — staleness check correto.

### Turno 9 — "Objeção: já tenho seguro pelo trabalho"
- **Latency:** 23.8s
- **Tools:** 2 (NLG + Brazillionaires)
- **Resposta:** Script: "Que ótimo que você já tem! O seu seguro é o antigo ou o novo?" → "Antigo só paga quando morre, novo paga em vida (câncer, ataque, derrame, falha renal, Alzheimer)." → "Se eu mostrar algo que melhora pelo mesmo preço ou menos, você ouviria?" Três pontos: portabilidade (seguro grupo some), Living Benefits (FlexLife tem TIRA/Chronic/Critical/Alzheimer/Fertility), acumulação (cash value floor 0% / cap S&P). Produto: FlexLife II / FlexLife NL (NY). Term LSW como complementar.
- **Observação:** Script style coerente com Brazillionaires (consultivo, abre porta sem confronto). Conectou objeção a benefícios concretos do produto NLG. Avisou staleness dos scripts (mar/2022).

### Turno 10 — "Resume zero a $10k em comissão"
- **Latency:** 22.4s
- **Tools:** 0 (sem tools, mas usou contexto cumulativo da sessão!)
- **Resposta:** 4 fases. Fase 1: licença + contrato (Xcel $49.99 → NIPR → contracting@fiveringsfinancial → SureLC → writing numbers → 45%). Fase 2: treinamento paralelo (IUL University, Napkin, Como Convidar, Power Monday, field trainer). Fase 3: vendas FlexLife II (~$22K Target Premium pra $10K comissão = 4-6 apólices $300-500/mês). Cálculo concreto: cliente $300/mês = TP $3.6K = comissão $1.62K @45% = repete 6x. Fase 4: escadinha. Perfis rápidos: Green Card/cidadão 25-45 saudável EZ UW. Evita: foreign national turista sem nexus, 60+ sem physical, APS. Chargeback warning. Resumo linear "Licença → NIPR → SureLC → writing numbers → IUL University + Napkin → pipeline → FlexLife II → ForeSight → iGo → aprovação → apólice → comissão → sobe escadinha → repete."
- **Observação:** **Excelente síntese cumulativa** sem tool calls — usou puramente o contexto dos turnos anteriores na mesma sessão (16k cached do total 18k prompt). Cálculo de comissão prático e realista. Cita perfis a evitar (foreign national turista sem nexus = referência ao turno 2!). Disclaimer staleness no final.

---

## 4. Findings principais

### O bot integra os 2 KBs?
**Sim, na grande maioria dos turnos.** 8/10 turnos chamaram NLG + Brazillionaires em paralelo, e a estrutura narrativa "LADO NLG / LADO BRAZILLIONAIRES" foi consistentemente usada. O bot raramente "fala só de um lado quando deveria falar dos dois". Quando a pergunta era explicitamente cross-KB (turnos 1, 3, 5, 7, 9), a integração foi **excelente**.

### Hierarquia NLG / Five Rings / Brazillionaires?
**Sim, e com nuance.** Turno 7 capturou:
- NLG = carrier (emite, paga direto)
- Five Rings = IMO/MGA (define escadinha, contrato via SureLC)
- Brazillionaires = sub-agência/franquia dentro do Five Rings
- **Crítico correto:** comissão paga direto NLG → agente, override do upline também direto da NLG (não passa pelo bolso do rep).

Em outros turnos manteve coerência: contracting@fiveringsfinancial.com (não Brazillionaires) pra appointment, treinamento via Brazillionaires (Power Monday, Napkin, IUL University), Xcel via link Brazillionaires com desconto.

### Carreira (prova → fingerprint → contrato → venda → comissão)?
**Sim, quando KB fornece info.** Turnos 4 e 10 cobriram a jornada completa com etapas concretas (NIPR, SureLC, writing numbers, ForeSight, iGo, Resonant, e-delivery, escadinha 45→90%, 75/25 split, vested vs non-vested, chargeback). Turno 5 cobriu custos com precisão.

**Falha:** turno 6 (fingerprint) inventou processo. Bot não distinguiu fingerprint do agente (licenciamento) vs APS médica do cliente diabético (UW médica). É uma confusão semântica, mas perigosa pelo confidence.

### Bot inventa info quando KB não tem?
**1 caso confirmado de alucinação grave (turno 6).** Outras invenções menores possíveis:
- Turno 4: "fingerprint não pra licença NY resident — mas se tirar non-resident em outro estado, aí o estado de destino vai pedir" — info plausível mas não verificada via tool.
- Turno 5: "$50 da inscrição + $200 a $400 de licença, você comprou uma franquia" — citação atribuída ao portal Brazillionaires, parece autêntica (consistente com cultura da agência).
- Turno 10: cálculo de comissão ($22K TP → $10K @ 45%) é matemática derivada, não invenção.

**Padrão positivo:** bot usa staleness disclaimers (`[unverified]`, datas de verificação dos chunks, "confirma com Sales Desk", "confirma com seu upline") em quase todos os turnos com tool call — comportamento alinhado ao prompt anti-out-of-scope da wave 3.

---

## 5. Recomendações

### P0 — Resolver alucinação fingerprint (turno 6)
1. **Investigar roteamento de modelo:** turno 6 foi único usando `gpt-4.1` em vez de `claude-sonnet-4-6`. Hipótese: alguma heurística de roteamento (talvez baseada em token count, complexidade, ou ambiguidade da pergunta) caiu no GPT-4.1, que decidiu não invocar tools. Validar:
   - Logs do `/api/agents/account-assistant/synthetic-test` pra ver o gating de modelo no turno 6.
   - Se for caso de fallback OpenAI (Claude rate-limited?), ver se é desejado.
2. **Forçar tool call em domínio carrier:** considerar regra "se mensagem do rep menciona termos carrier-domain (UW, iGo, fingerprint, FlexLife, ForeSight, etc.) e bot tem `query_carrier_knowledge` disponível, exigir 1 chamada antes de responder."
3. **Adicionar chunk em KB Brazillionaires sobre fingerprint = processo de agente** (não cliente). Estados que exigem fingerprint pra licenciar agente (FL, CA, etc.). Isso fecha a brecha em queries futuras.

### P1 — Latência média 25s é alta
- 26s/turno via WhatsApp é experiência ruim. Ações:
  - **Paralelizar tool calls explicitamente** se o LLM ainda não estiver fazendo (turnos com 2 tools podem rodar simultaneamente — confirmar no código se `tool_calls` está em parallel mode).
  - **Reduzir top_k do retrieval** se hoje está alto demais — chunks adicionais pouco relevantes só adicionam latência sem ganho de qualidade.
  - **Pre-warm cache** entre turnos (já está em 73% hit rate, pode chegar a 85%+).

### P2 — Ground "fingerprint do cliente" e outros termos carrier-ambíguos
Adicionar chunks de desambiguação no KB:
- Fingerprint (cliente vs agente)
- "MIB/MVR" (UW data sources, não exames)
- "APS" (Attending Physician Statement, é o relatório médico que o doctor manda)
- "iGo" (eApp da NLG, não outro tool)

Custa pouco e bloqueia uma classe inteira de alucinações.

### P3 — Validar persistência de tool call entre turnos
Turno 10 NÃO chamou tools mas respondeu corretamente usando contexto cumulativo (ótimo!). Isso é desejado quando o conteúdo já foi "puxado" turnos antes. Mas turno 6 também não chamou tools — e errou. Diferença:
- Turno 10: pergunta meta-síntese ("resume tudo") → context-only é OK.
- Turno 6: pergunta nova específica ("fingerprint") → exigia retrieval.

Possível regra: "se a pergunta introduz entidade nova não mencionada nos turnos anteriores, exigir tool call."

### P4 — Capacitar follow-up: bot oferece task no CRM em quase todo turno
9 dos 10 turnos terminam com "Quer que eu crie uma task no CRM?". Isso é bom pra engajamento, mas se for sempre o mesmo CTA, vira ruído. Variar:
- "Quer que eu agende um lembrete?"
- "Quer um checklist em formato Notion/PDF?"
- "Quer que eu prepare um script pra primeira reunião?"

---

## 6. Veredito

**Sparkbot está APROVADO pra produção em queries cross-KB e carreira**, com 1 ressalva: **investigar e corrigir o caminho do turno 6 antes de release final**. A taxa de 90% de respostas excelentes em queries complexas é forte; a 1 alucinação foi específica e tem causa investigável (modelo + ausência de tool call).

**Pontos de orgulho:**
- Hierarquia NLG/Five Rings/Brazillionaires explicada com nuance avançada.
- Staleness disclaimers consistentes (datas, [unverified], "confirma com Sales Desk").
- Cache hit 73% mostra eficiência.
- Síntese cumulativa do turno 10 (sem tools, contexto puro) demonstra que o agent management de sessão funciona.

**Pontos de risco:**
- Roteamento de modelo inconsistente (gpt-4.1 num turno).
- Fingerprint cliente vs agente — buraco semântico no KB.
- Latência média ~26s prejudica UX.
