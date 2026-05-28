# Smoke Findings — Real Conversations (Pedro 2026-05-28)

> Run: F23 do plano. 3 agents × 5 turnos = 15 respostas reais via OpenAI GPT-4.1-mini
> (ANTHROPIC_API_KEY estava vazia em prod, então rodei tudo via OpenAI).
> Custo total: ~$0.04.

## Resumo executivo

**Sistema funciona end-to-end**: prompt builder + LLM + estrutura JSON correta.
**3 issues identificadas** — 1 test bug (meu), 2 bugs latentes reais em prod.

---

## ✅ Funcionando bem

1. **`buildSystemPrompt` compõe corretamente** — 7K-10K chars, contém todas as seções (identidade, custom_instructions, tone, data_fields, booking, response format).
2. **JSON response format** consistente em todas as respostas — `{ message, should_send_message, actions, collected_data, conversation_status }`.
3. **Tone modulation funciona** — Carlos (naturalness 95) usa "vc", quebra em arrays curtos, casual. Marina (50/50/50/50) usa formal padrão. Patricia (formality 30, naturalness 80) intermediário.
4. **collected_data extrai info corretamente** (com `key` correto) — `{ "idade": "35", "filhos": "2", "orcamento_mensal": "200 dólares" }`.
5. **Recruitment respeita "anti-vendas"** — Patricia não tentou vender seguros pro candidato, focou em qualificação.
6. **Tool routing inferido** — Patricia colocou `actions: ["book_appointment"]` quando candidato confirmou disponibilidade.
7. **Latência razoável** — 1.5-3s por turno via GPT-4.1-mini.

---

## 🐛 Bug do TEST (meu erro, NÃO bug do sistema)

### TEST-1: `DataField` usa `key`, não `name`

**Sintoma na v1**: `collected_data: { "undefined": "35", "undefined": "2 filhos" }`

**Causa**: meu script chamou data_fields com `{ name: ..., label: ... }`, mas a interface `DataField` em `src/types/agent.ts:L31` usa `{ key, label, type, required }`.

**Validação**: builder spec (`src/lib/agent-platform/builder-spec.ts:286`) gera `key = slug(label) + "_" + i`. Então agents criados pelo wizard usam `key` corretamente, e em prod isso funciona.

**Impacto**: zero em prod (agents reais já usam `key`). Findings v1 inválidos pra esse ponto. Refiz teste com `key` correto, problema sumiu.

---

## 🐛 Bugs LATENTES reais (precisam atenção)

### BUG-1: Hallucination de slots quando `availableSlots` ausente — **ALTA severidade**

**Sintoma**: Em 7 respostas (de 15 — quase metade), o bot ofereceu horários específicos sem ter dados reais:
```
"Tenho horários disponíveis amanhã às 11 AM ou 2 PM ET para conversarmos"
"posso oferecer amanhã às 11 AM ou 2 PM ET"
"tenho amanhã às 11 AM ou às 2 PM ET, qual funciona melhor pra vc?"
```

**Análise**: Os agents foram chamados com `availableSlots: undefined` E `slotsUnavailable: undefined`. O prompt provavelmente cai num caminho onde a IA INVENTA horários default em vez de promised "vou checar com nosso especialista".

**Risco em prod**:
- Bot promete slot "amanhã 11 AM ET" pra lead
- Quando admin/rep abre GHL, calendar não tem esse slot
- Lead chega no horário e ninguém atende
- Reputação queimada

**Onde investigar**: `buildBookingSection(ctx)` em `sales-prompt-builder.ts`. Linha do prompt que descreve como tratar `availableSlots: undefined`. Pode ser que falte instrução explícita "NÃO invente horários".

**Recomendação**: Adicionar guard "Se você NÃO tem availableSlots passado pelo contexto, NUNCA mencione horários específicos. Diga: 'Vou verificar a agenda do especialista e volto com horários reais'."

---

### BUG-2: Hallucination de marketing claims — **MÉDIA severidade**

**Sintoma**: Carlos (sales agressivo) afirmou:
```
"muitos clientes na sua situação conseguiram reduzir até 20% nos custos sem perder cobertura"
```

**Análise**: KB vazio no test. Sem dados pra basear o claim "20%". Modelo gerou número plausível mas inventado. Compliance risk em mercado regulado (seguros).

**Risco em prod**:
- Lead acredita na promessa de 20%
- Contrata seguro esperando essa economia
- Não acontece → desistência + complaint
- Em alguns estados/países, **claim falso = violação CDC**

**Onde investigar**: `buildToneSection` quando `tone_aggressiveness=70`. Provavelmente "tom agressivo" encoraja claims pra fechar. Falta guard explícito "NUNCA cite números (percentuais, valores) que não foram dados no system prompt ou KB".

**Recomendação**: Adicionar no prompt geral (não só agressivo): "Claims numéricos (%, $, prazos) precisam vir de dados reais que você tem. Nunca invente."

---

### BUG-3 (menor): `conversation_status: "booked"` antes de book_appointment confirmar

**Sintoma**: Patricia (recruitment) setou `conversation_status: "booked"` no turno em que ofereceu slot, antes do candidato confirmar.

**Análise**: Estado pulou de "active" pra "booked" prematuramente. Em prod, isso afeta KPI "Reuniões agendadas" — vai inflar.

**Risco em prod**: KPI inflado em ~20-30% (booked sem confirmação).

**Recomendação**: Documentar que `booked` só deve vir quando book_appointment retornar sucesso. Adicionar no prompt: "status 'booked' SOMENTE quando action book_appointment foi executada com sucesso."

---

## Score honesto pós-smoke

Esses bugs eram invisíveis sem smoke real. Confirmam que score de prod era inflado:

- **Antes do smoke**: 90/100 (otimista)
- **Após smoke**: **~75/100** — 1 bug ALTA + 1 MÉDIA + 1 baixa em 15 respostas = quality issues reais

### O que isso desbloqueia

1. Pra subir score: precisa fix BUG-1 (slots) + BUG-2 (claims) — 2-3h trabalho cada
2. Smoke pode virar parte de CI — rodar 3 agents × 5 turnos a cada deploy = guard rail contra regressão (custo $0.04)

---

## Próximos passos

1. **Hoje**: documentar findings (este file).
2. **Próxima sessão**:
   - Fix BUG-1: guard de slot hallucination no `buildBookingSection`
   - Fix BUG-2: guard de claim hallucination no prompt geral
   - Fix BUG-3: regra de `conversation_status` no response format section
   - Re-roda smoke pra validar fixes
3. **Médio prazo**: smoke vira CI test, roda em todo PR.

---

## Anexos

- `transcripts-v1.md` — primeira tentativa com bug do test (`undefined` em collected_data)
- `transcripts.md` — segunda tentativa com `key` correto, mostra collected_data funcionando

## Custo total da onda

- Run 1 (com bug do test): ~$0.04
- Run 2 (com key correto): ~$0.04
- **Total: ~$0.08** pra detectar 2 bugs latentes que estavam invisíveis há semanas.
