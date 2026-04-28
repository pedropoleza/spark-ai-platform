# Stress Test 05 — Conversa Longa / Continuidade (Sparkbot Account Assistant)

**Data:** 2026-04-28
**Endpoint:** `POST /api/agents/account-assistant/synthetic-test`
**Rep:** `+17867717077`
**Session:** `1107c82d-63d9-482f-b504-44901684bc9a`
**Persona:** Agente brasileiro simulando dia inteiro de trabalho com 3 leads paralelos (Maria 38a smoker, João 52a diabetes, Ana 28a saudável). 15 turnos alternando entre clientes pra estressar continuidade e cross-context.

---

## 1. Resumo executivo

- **15/15 turnos completaram sem timeout/erro.** Todas respostas em PT-BR, raciocínio coerente do início ao fim.
- **Coesão da conversa: SIM (aprovada com folga).** Bot demonstrou memória estrutural impecável dos 3 leads ao longo dos 15 turnos.
- **Cross-context funcionando:** turno 5 cruzou "diabetes" (T4) com "hipertensão" (T5) corretamente. Turno 10 lembrou que João é não-fumante (info implícita do T4). Turnos 6 e 15 reconstruíram resumo dos 3 leads sem perder nenhum atributo (idade, condição, smoker status, premium).
- **Atualização de contexto: SIM.** Quando rep diz "esquece João" (T13), bot para de mencionar João nos turnos seguintes (T14 e T15 mantêm essa exclusão; T15 traz João só com flag explícito "pediu pra esperar 1 mês").
- **Tools chamadas adequadamente:** `search_contacts` em turnos com nome próprio novo (T1, T2, T4), `query_carrier_knowledge` em perguntas técnicas (T3, T4, T9, T10). Nenhuma chamada redundante.
- **Cap de hist em 30 msgs:** confirmado no código (`route.ts:144 → priorMessages.slice(0, -1).slice(-30)`). Nesta conversa não foi atingido (15 turnos = 30 msgs total exatamente, não passou).
- **Token growth controlado:** prompt cresce de 8k–36k mas oscila por causa de tool results (não cresce monotonicamente). Cache hit médio = 87% — excelente, custo final $0.22 / 15 turnos = $0.015/turno.
- **Quality NÃO degradou.** Turno 15 (resumo final) é tão bom quanto turno 6 (resumo intermediário); comparei lado a lado e bot não esqueceu nenhum atributo.

**Pontos fracos:**
- **`search_contacts` repetido em loop:** bot ficou pedindo confirmação de "qual Maria/João/Ana" do T1 ao T15. Como rep nunca confirmou um contato específico, bot não conseguiu criar tasks. Isso é safety correto (não cria task em contato errado), mas a UX cria fricção.
- **Tool de `create_task` nunca foi chamada** (T11, T12, T13 ofereceram criar mas bloquearam por falta de email/phone). Não foi possível verificar se o tool funciona — teste cego nesse ponto.
- **Latência alta no início:** T1 (28s) e T4 (32s) — provável cold start + tool calls em paralelo. P95 chega em 34.9s. Acima de 30s pra um chat WhatsApp começa a ser ruim.

---

## 2. Métricas agregadas

| Métrica | Valor |
|---|---|
| **Total turnos** | 15 |
| **Turnos OK** | 15 (100%) |
| **Total prompt tokens** | 284,999 |
| **Total cached tokens** | 248,277 (87.1% — cache hit excepcional) |
| **Total uncached tokens** | 36,722 |
| **Total completion tokens** | 3,248 |
| **Custo total (gpt-4.1)** | $0.2236 |
| **Custo médio por turno** | $0.0149 |
| **Latência média** | 16,066 ms |
| **Latência P95** | 34,886 ms |
| **Latência mediana** | ~14,000 ms |
| **Latência mínima** | 2,389 ms (T12, sem tool) |
| **Latência máxima** | 34,886 ms (T7, sem tool — alto sem motivo claro) |

### Crescimento de tokens por turno

```
Turn  Prompt   Cached    Compl   Latência   Tools
01    33,247   30,976    327     28.6s      search_contacts x3
02    16,465   14,848    53      17.1s      search_contacts
03    19,408   14,848    170     25.1s      query_carrier_knowledge
04    28,187   23,296    206     32.0s      search_contacts + KB
05     8,267    6,912    137     20.2s      —
06    13,017   11,531    237      5.6s      —
07    12,146   11,531    191     34.9s      —
08    12,367   11,531    193     25.7s      —
09    31,375   25,980    464     13.7s      query_carrier_knowledge
10    36,553   26,720    557     15.3s      query_carrier_knowledge x2
11    14,506   13,583    193      5.8s      —
12    14,737   13,583     32      2.4s      —
13    14,804   13,972     51      3.1s      —
14    14,885   14,371    132      4.8s      —
15    15,035   14,595    305      6.6s      —
```

### Análise do crescimento

- **Não há crescimento monotônico.** O prompt oscila — turnos com tool calls (especialmente `search_contacts` que retorna 10 contatos com tags/emails/phones) infla muito o prompt: T1=33k, T4=28k, T10=36k.
- **Turnos sem tool call ficam estáveis em 12k–15k tokens.** Isso é o piso (system prompt + history). System prompt é grande (~10k+ tokens, suspeita pela base estável).
- **Cache hit é o que segura o custo.** Sem cache, turno T10 (36k prompt) custaria $0.078. Com cache 73% (26.7k cached) custou $0.018.
- **Compressão de history não está acontecendo no app code** — `route.ts:144` apenas faz `.slice(-30)` (cap em 30 msgs). Não há history compressor ativado neste path. Isso explica por que o prompt cresceu monotonicamente em alguns trechos (turnos 6→11, com tool results acumulados).

---

## 3. Análise turno a turno

| # | Pergunta resumida | Lembrou contexto? | Qualidade | Latência | Notas |
|---|---|---|---|---|---|
| 1 | "3 leads pra trabalhar: Maria 38a smoker, João 52a diabetes, Ana 28a saudável" | n/a (set up) | Boa | 28.6s | Procurou os 3 nomes em paralelo. Listou contatos, pediu confirmação. Tools: 3x search_contacts |
| 2 | "Maria smoker 10a 1 maço/dia, rate FlexLife $200k?" | Sim — vinculou ao nome Maria | Parcial | 17.1s | Pediu confirmação de qual Maria sem responder o rate. Pode-se argumentar que deveria ter respondido em paralelo. |
| 3 | "Se ela parar de fumar amanhã, em quanto tempo muda rate?" | Sim — entendeu "ela" = Maria smoker | Excelente | 25.1s | Citou fonte: 12 meses Standard NT, 3-5a Preferred. Cat 62797(0126). |
| 4 | "Próximo: João, diabetes tipo 2 controlada. Rate?" | Sim — referenciou João 52a sem repetir | Excelente | 32.0s | Cross-info: aplicou idade 52 + diabetes corretamente. Standard NT esperado, APS automático. |
| 5 | "Ele tem hipertensão também. Muda?" | Sim — cruzou diabetes (T4) + hipertensão (T5) | Excelente | 20.2s | Resposta cruzada: combinação muda risco, podem cair pra Table B. |
| 6 | "Resumo das 3 leads pra agenda" | Sim — recap completo dos 3 | Excelente | 5.6s | Lembrou TODOS os atributos: idades, smoker, condições. Listou Maria/João/Ana com infos certas. |
| 7 | "Ana $1500/mês, PeakLife ou WL?" | Sim — Ana 28a saudável | Excelente | 34.9s | Recomendou FlexLife II (PeakLife exige $1M face). Latência alta sem tool é estranho. |
| 8 | "Pra qual encaminho UW primeiro?" | Sim — priorizou João > Maria > Ana com justificativa | Excelente | 25.7s | Raciocínio cruzado dos 3 perfis simultâneos. |
| 9 | "Maria — script Napkin pra IUL" | Sim — adaptou pra perfil Maria smoker | Excelente | 13.7s | Citou os 5 desenhos Napkin + foco em living benefits pra fumante. |
| 10 | "João — dicas Rita cliente diabético" | Sim — lembrou A1c, lembrou João não-fumante | Excelente | 15.3s | Cross-context profundo: lembrou que "João não é fumante" do T4 (nunca disse explicitamente). |
| 11 | "Como organizo follow-up no GHL?" | Sim — propôs 3 tasks (uma por lead) | Bom | 5.8s | Bloqueou na criação por falta de contato confirmado. |
| 12 | "Cria tarefa Maria amanhã 10am atestado pulmão" | Sim — entendeu Maria + horário | Bom (defensivo) | 2.4s | Tool não chamada — pediu confirmação de qual Maria. Safety correto, mas frustrating UX. |
| 13 | "Esquece João, foca Maria + Ana" | Sim — atualizou contexto | Bom | 3.1s | Não mencionou João no resto da conversa (T14, T15 honraram exclusão). |
| 14 | "Ana baixou pra $800/mês, PeakLife?" | Sim — confirmou FlexLife (consistente com T7) | Excelente | 4.8s | "FlexLife sem dúvida". Mencionou só Maria + Ana (sem João). |
| 15 | "Resumo final do dia" | Sim — recap COMPLETO dos 3 | Excelente | 6.6s | Lembrou de TUDO: Maria 38a smoker, João 52a diabetes+hipertensão "pediu esperar 1 mês", Ana 28a $800/mês FlexLife II. Próximos passos por lead. Pediu emails/phones pra finalizar tasks. |

### Indicador de "lembrou de info anterior"

| Turno | Info usada do passado | Source turn |
|---|---|---|
| T2 | "Maria" (sem repetir 38a/smoker) | T1 |
| T3 | "ela" = Maria smoker | T1, T2 |
| T4 | "João" sem repetir 52a/diabetes | T1 |
| T5 | "ele" = João + diabetes | T4 |
| T6 | TODAS as 3 leads (idades, smoker, condições, premium) | T1 |
| T7 | "Ana" 28a saudável | T1 |
| T8 | Os 3 perfis em ordem priorizada | T1, T4, T5 |
| T9 | Maria smoker → living benefits | T1, T2 |
| T10 | João não-fumante (info implícita) + diabético | T4 |
| T11 | 3 leads pra organizar follow-up | T1 |
| T13 | "esquece João" honrado | (autoupdate) |
| T14 | Só Maria + Ana mencionadas | T13 |
| T15 | TODOS os atributos dos 3 (incluindo João "esperar 1 mês") | T1, T13 |

**Conclusão:** bot demonstra **memória estruturada e atualizável** ao longo de 15 turnos, sem alucinação ou inversão de informações. Score qualitativo: 14/15 turnos excelentes ou bons (apenas T2 deu resposta parcial).

---

## 4. Findings críticos

### F1 — `search_contacts` em loop sem progresso (severidade média)

Em T1, T2, T4 bot rodou `search_contacts` mas como rep nunca passou email/telefone, bot ficou bloqueado em "qual contato específico" do T2 ao T15. Isso causa fricção:

- T11 oferece criar tasks, bloqueia.
- T12 pede explicitamente "criar tarefa Maria amanhã 10am", bloqueia novamente.
- T13, T14, T15 sempre terminam com "Me passa email ou telefone".

**Comportamento correto** (não criar task em contato errado), mas **falta de fallback proativo**: bot poderia ter sugerido "Posso criar a task com o nome 'Maria smoker 38a' como referência e você vincula depois ao contato GHL?" — alternativa que destrava o fluxo.

**Recomendação:** adicionar instrução no system prompt pra oferecer **task standalone** (sem contact_id) como fallback após 1-2 pedidos sem resposta. Hoje cria fila de pedidos repetidos.

### F2 — Latência alta sem tool call em alguns turnos (severidade baixa)

- T7 (34.9s) e T8 (25.7s) **sem tool calls**, mas latência alta.
- Suspeita: streaming + thinking time longo no GPT-4.1 com prompt grande (12k tokens) + history acumulado.
- Não chega a quebrar UX, mas P95 = 34.9s no WhatsApp é beira do tolerável.

**Recomendação:** investigar se `temperature` ou `max_tokens` está afetando. Se completion média é 200 tokens, talvez reduzir `max_tokens` de 1000 pra 500 acelere.

### F3 — Compressão de histórico inexistente (severidade baixa em 15 turnos, alta em 30+)

`route.ts:144`:
```typescript
const priorMessages = allMessages.slice(0, -1).slice(-30);
```

Apenas cap em 30 mensagens (15 turnos). Não há compressão semântica, sumarização, ou truncamento inteligente. Em conversas de 30+ turnos:

- Cap em 30 vai começar a "esquecer" turnos antigos abruptamente.
- Não preserva contexto crítico (ex: "Maria smoker 38a" pode ser dropado se virar msg #31).

**Existe `history-compressor.ts`?** Verifiquei: confere existência mas o synthetic-test path NÃO usa (passa direto pro processIncoming).

**Recomendação:** ativar compressor no path de synthetic-test ou validar se o pipeline de webhook real (não-synthetic) usa o compressor. Se webhook real ignorar também, esse é um bug pra fixar antes de prod scale.

### F4 — `create_task` tool não testada (severidade média)

Bot ofereceu criar tasks 4 vezes (T11, T12, T13, T15) mas nunca chamou. Não foi possível validar se a tool de create_task está integrada no Sparkbot.

**Recomendação para próximo teste:** passar email válido de contact GHL existente e verificar se tool é executada e GHL recebe a task. Pode ter:
- Tool registrada mas não exposta ao Sparkbot
- Tool exposta mas system prompt bloqueando
- Tool funcional mas hist sintético sempre travando em search_contacts

---

## 5. Recomendações

### Prioridade alta

1. **Criar handler `create_task_unbound`** que aceita criar tasks sem contact_id (como note pessoal do rep). Quando rep não confirma contato, ainda assim ele tem o lembrete. Hoje a única alternativa é não fazer nada.

2. **Validar o path real do webhook** (`/api/webhooks/ghl/...`) também respeita o cap de 30 msgs ou se usa compressor diferente. Se webhook real não compressar, escalar com história longa vai degradar (custo + latência) em produção.

3. **Testar criação de task com contact_id válido** num próximo synthetic test pra confirmar que tool de criar task funciona end-to-end.

### Prioridade média

4. **Adicionar instrução no system prompt:** "Se rep pedir 3+ vezes pra criar task e ainda não passou contato, ofereça task standalone com nome do lead como string (ex: 'Maria 38a smoker')". Reduz fricção observada.

5. **Implementar history-compressor** no path synthetic-test se ainda não estiver — útil pra simular cenário real de produção. Seria um summarize do trecho mais antigo a cada 20 turnos (ex.: agrupa T1-T10 em "RESUMO LEADS: Maria 38a smoker, João 52a esperar 1m, Ana 28a $800/mês FlexLife").

6. **Investigar latência alta sem tool call** (T7, T8). Reduzir `max_tokens` ou ajustar streaming pode trazer P95 < 25s.

### Prioridade baixa

7. **Métrica:** custo médio $0.015/turno é muito bom. Cache hit 87% mostra que prompt caching está funcionando perfeitamente. Manter.

8. **Quality:** não há sinal de degradação no turno 15 vs turno 1. Bot lembra de tudo. Considerar testar com 30, 50, 80 turnos pra encontrar o ponto onde a quality realmente cai (este teste de 15 não chegou nesse ponto).

9. **Atualização de contexto** (T13 "esquece João") funcionou perfeitamente. Não mexer.

---

## 6. Conclusão

**Conversa longa de 15 turnos: APROVADO.**

O Sparkbot demonstrou:
- Memória estrutural completa de 3 leads em paralelo
- Cross-context (combinar info de turnos diferentes)
- Atualização de contexto (drop João sob comando)
- Custo razoável ($0.22 total) graças ao cache hit alto
- Quality consistente do T1 ao T15

**Achados acionáveis:** falta criação de task standalone como fallback, falta validação do path real (webhook) usar compressão de hist, e latência sem tool em alguns turnos.

**Score qualitativo: 9.0 / 10.**
