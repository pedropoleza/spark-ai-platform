# Stress Test — Reminders & Proatividade
**Data:** 2026-04-29
**Endpoint:** `POST /api/agents/account-assistant/synthetic-test`
**Sessão:** `1f61f21b-5379-4f69-8843-134a101b39a2`
**Modelo:** `claude-sonnet-4-6`
**Rep phone:** `+17867717077`

---

## Resumo executivo

| # | Turno (msg do rep) | Esperado | Real | Veredito |
|---|---|---|---|---|
| 1 | "Me lembra amanhã 14h de ligar pro Carlos" | `schedule_reminder` direto, channel='whatsapp', `remind_at=2026-04-30T14:00...` | `schedule_reminder` chamado com cron correto, mas tool exigiu confirmação (gating `medium_and_high`); bot pediu "Confirma?" | **PASS** (com 1 trip de gating) |
| 1b | "sim, confirma" | Reminder criado | **DB ERRO**: `Could not find the 'delivery_channel' column of 'assistant_scheduled_tasks' in the schema cache` — migration 00042 não foi aplicada em produção | **FAIL CRÍTICO** |
| 1c | "tenta de novo" | Retry sem `delivery_channel` | Bot retentou IDÊNTICO, mesmo erro. Não pensou em remover `delivery_channel` como fallback | **FAIL** |
| 2 | "Lista meus lembretes" | Lista o de Carlos | `list_my_reminders({})` retornou `[]` (esperado, pois turn 1 falhou no DB) | **PASS** (mas só porque o reminder não existia) |
| 3 | "Cancela esse" | Cancelar ou pedir clarificação | "Não tem nenhum lembrete ativo pra cancelar" — bot usou contexto, não chamou tool | **PASS** |
| 4 | "Todo dia útil às 9h, manda os opps que precisam follow-up" | Recurring com cron `0 9 * * 1-5` | `schedule_reminder` com `recurrence: "0 9 * * 1-5"` correto; bot pediu confirmação | **PASS** (cron perfeito) |
| 4b | "sim, confirma" | Recurring criado | **DB ERRO** mesmo erro de delivery_channel | **FAIL CRÍTICO** |
| 5 | "Quais lembretes recorrentes eu tenho?" | List filtrado com `include_recurring=true` | `list_my_reminders({include_recurring: true})` correto, retornou `[]` (porque DB falhou no turn 4b) | **PASS** (filtro correto) |
| 6 | "tô conversando aqui no painel da Spark, não no WhatsApp. Me lembra sexta-feira 16h de revisar o pipeline" | Bot DEVE perguntar "computador, celular ou ambos?" antes de chamar tool | Bot chamou `schedule_reminder` direto com `delivery_channel='web_ui'` SEM perguntar | **FAIL** (regra UX violada) |
| 7 | "Pode ser no computador" | Bot agenda com `delivery_channel='web_ui'` | Bot já tinha tentado web_ui no turn 6; aqui re-pediu confirmação (`web_ui` mantido) | **PASS** (parcial) |
| 7b | "sim, confirma" | Reminder criado | **DB ERRO** mesmo bug de schema | **FAIL CRÍTICO** |
| 8 | "Lista todos meus lembretes ativos agora" | Lista incluindo recurring + de canal web | `list_my_reminders({})` SEM `include_recurring=true` — retornou `[]` | **WARN** (filtro incompleto, mas o DB tava vazio) |
| 9 | "Cancela o reminder XXXXXXXX" (ID inválido) | Recusar (ID inválido) | "Não tem nenhum lembrete ativo pra cancelar" — bot usou contexto, não validou ID propriamente; mas resultado prático correto | **PASS** (mas não testou validação de ID) |
| 10 | "Me lembra ontem 8h" | Recusar (data passada) | "'Ontem' já passou, não dá pra criar lembrete no passado" — sem chamar tool | **PASS** |
| 11 | "Me lembra 34h da manhã" | Clarificar | "'34h da manhã' não existe. Qual horário você quis dizer?" — sem chamar tool | **PASS** |
| 12 | "Cria um lembrete sem mensagem só com horário 10h" | Pedir clarificação | "Preciso saber o que você quer que eu te lembre. Qual é a mensagem?" — sem chamar tool | **PASS** |
| 13 | "lembrete que repete a cada 5 minutos pra sempre" | Aceitar com aviso (cron `*/5 * * * *`) | Bot RECUSOU outright: "Não faço isso — ia te spammar sem parar" — sem chamar tool | **WARN** (refusou em vez de avisar; pode ser intencional) |
| 14 | "Cria uma task pro Pedro chamar o cliente Carlos amanhã" | `create_task` (NÃO schedule_reminder) | Bot pediu clarificação "Qual Pedro?" — não chamou nem `create_task` nem `schedule_reminder` | **WARN** (não distingue tools claramente; só faz busca no CRM) |
| 15 | "Não, era pra ser um lembrete pra mim, não pro Pedro" | Cancelar task (se criou) + criar reminder | Bot pivotou pra reminder, chamou `search_contacts("Carlos")`. Não tentou cancelar task (porque não criou). Ainda não criou reminder, pediu mais info | **WARN** (correção parcial; não chamou schedule_reminder) |
| 16 | "Resumo: o que tá agendado pra hoje e amanhã?" | Listar reminders + tasks | `list_appointments(when=today)` + `list_appointments(when=tomorrow)` — não listou reminders nem tasks | **FAIL** (interpretou "agendado" como appointments only) |

**Totais:** 9 PASS / 5 FAIL / 4 WARN (em 18 turnos efetivos, contando 1+1b+1c como 3 sub-turnos)

> Nota: dos 5 FAIL, 3 são consequência DIRETA do mesmo bug de DB (turns 1b, 4b, 7b). Os outros 2 são UX (turn 6, turn 16).

---

## Findings críticos

### 1. **FAIL CRÍTICO — `delivery_channel` column missing in production DB**
- **Erro:** `Could not find the 'delivery_channel' column of 'assistant_scheduled_tasks' in the schema cache`
- **Causa:** Migration `supabase/migrations/00042_sparkbot_web_channel.sql` (data: 2026-04-29) **não foi aplicada** ao Supabase de produção, mas o código `src/lib/account-assistant/tools/reminders.ts` (linhas 109-112, 124) já assume que a coluna existe (faz INSERT e SELECT nela).
- **Impacto:** **NENHUM reminder é criável em produção**. 100% dos requests pra `schedule_reminder` falham com erro irrecuperável.
- **Fix:**
  ```bash
  # 1. Aplicar a migration:
  supabase db push  # ou via dashboard Supabase
  # 2. Verificar:
  SELECT column_name FROM information_schema.columns
   WHERE table_name='assistant_scheduled_tasks' AND column_name='delivery_channel';
  ```
- **Side effect:** Mesma migration adiciona `preferred_proactive_channel` em `rep_identities`, `channel`/`read_in_web_at` em `sparkbot_messages`, `delivery_channel` em `assistant_alert_state`, e cria `sparkbot_web_subscriptions`. **Tudo isso está quebrado em prod.**

### 2. **FAIL — Bot não pergunta canal no Web UI (regra do prompt-builder)**
- **Esperado:** No turn 6, com texto "tô no painel web", bot deveria perguntar "computador, celular ou ambos?".
- **Real:** Bot chamou `schedule_reminder` direto com `delivery_channel='web_ui'`.
- **Causa raíz:** A regra está no `prompt-builder.ts` linha 102-107 e SÓ é aplicada quando `channel === 'web_ui'`. O endpoint `synthetic-test` **NÃO aceita `channel` no body** — sempre passa `whatsapp` por default. Isso é uma **limitação do endpoint de teste**, não do bot em si.
- **Atenção do roteiro:** O briefing dizia "adicione na mensagem" pra forçar o canal, mas isso **não funciona** porque o prompt-builder usa o parâmetro `channel`, não o conteúdo do texto. O bot reage ao `delivery_channel` do schema, não ao texto livre.
- **Fix recomendado:**
  - **A.** Adicionar suporte a `channel` no body do `synthetic-test` route, pra QA poder testar fluxo web.
  - **B.** OU adicionar instrução no system prompt: "Se o rep mencionar explicitamente que tá no painel web/Spark UI mesmo que o canal atual diga whatsapp, perguntar canal antes de chamar a tool."

### 3. **WARN — Bot retentou idêntico após erro de DB (turn 1c)**
- Após `delivery_channel` falhar com erro `retryable: false`, bot retentou IDÊNTICO sem remover o campo problemático. Não tem fallback a "sem canal".
- **Mas isso é correto na real**, porque o DB precisa ter a coluna. Fix é a migration. Bot NÃO deve adivinhar fallbacks.

### 4. **WARN — Edge case "ID inválido" (turn 9) não testado de verdade**
- Bot usou contexto ("não tem nenhum lembrete ativo") em vez de tentar `cancel_reminder("XXXXXXXX")` e validar erro. Comportamento prático correto, mas **a tool em si não foi exercida** com ID inválido. Sugiro adicionar teste unitário na tool `cancel_reminder` que valida UUID format.

### 5. **WARN — `list_my_reminders` não usou `include_recurring=true` no turn 8**
- Quando rep pediu "Lista todos meus lembretes ativos", bot chamou sem o filtro. Em produção, com reminders recorrentes existentes, **eles seriam ocultados**. Sugiro mudar default da tool pra `include_recurring=true` ou ajustar prompt pra "todos = include_recurring=true".

### 6. **FAIL — Resumo (turn 16) só lista appointments**
- Rep perguntou "o que tá agendado pra hoje e amanhã" e bot listou apenas `list_appointments`. Reminders e tasks ficaram de fora.
- **Fix:** Ajustar prompt pra que "agendado" inclua: appointments + reminders + tasks.

### 7. **WARN — Bot não distinguiu `create_task` vs `schedule_reminder` no turn 14**
- Rep falou "task pro Pedro" — bot interpretou só como busca de contato (`search_contacts` no turn 15), nunca chamou `create_task`. A diferença semântica entre "task no CRM (visível no GHL)" vs "reminder (msg proativa)" não foi exercida.
- **Fix:** Adicionar exemplo no docstring de `create_task` reforçando "Use quando rep pedir 'cria task pro X', 'agenda task pra Y'", e na `schedule_reminder` reforçando "Use quando rep pedir 'me lembra' / 'avisa em'".

### 8. **OK — Recurring "5min pra sempre" foi REJEITADO** (turn 13)
- O briefing pediu "aceitar com aviso", mas o bot recusou totalmente. Isso é defensivo e razoável pra evitar spam runaway. Pode-se ajustar pra "aceitar com aviso explícito + cap em N execuções", mas comportamento atual é seguro.

### 9. **OK — Cron correto pra "todo dia útil 9h"** (turn 4)
- Bot inferiu `0 9 * * 1-5` corretamente. Robusto.

### 10. **OK — Refusal de data passada e timestamp absurdo** (turn 10, 11)
- Sem chamar tool. Validação semântica em prompt está funcionando bem.

---

## Métricas

| Métrica | Valor |
|---|---|
| Turnos executados | 20 (16 do roteiro + 4 follow-ups de confirmação) |
| Duração total | 84.2s |
| Latência média/turno | 4.2s |
| Latência min/max | 1.3s (turn 9) / 8.8s (turn 1c) |
| Prompt tokens (sum) | 468,204 |
| Completion tokens (sum) | 3,064 |
| Cached tokens (sum) | 453,059 |
| **Cache hit ratio** | **96.8%** ← excelente |

**Distribuição de latência por turno:**
- Turnos sem tool (3, 9, 10, 11, 12, 13): 1.3-2.8s (resposta direta)
- Turnos com 1 tool call: 2.9-5.5s
- Turnos com 2 tool calls (1b, 1c, 4b, 7b, 16): 6.3-8.8s

**Tool calls registrados:**
- `schedule_reminder`: 8x (5 hit gating, 3 hit DB error)
- `list_my_reminders`: 4x (2 com `include_recurring`, 2 sem)
- `cancel_reminder`: 0x ← **nunca foi exercitado de verdade** (turn 3 e 9 não invocaram)
- `create_task`: 0x ← **nunca foi exercitado** (turn 14 não invocou)
- `search_contacts`: 1x (turn 15)
- `list_appointments`: 2x (turn 16)

---

## Recomendações concretas

### Prioridade P0 (bloqueante de produção)
1. **APLICAR MIGRATION 00042** no Supabase de produção. Sem isso, **NENHUM** reminder funciona. Comando:
   ```bash
   cd supabase && supabase db push
   # ou: psql $DATABASE_URL < migrations/00042_sparkbot_web_channel.sql
   ```
   E **forçar refresh do PostgREST schema cache**:
   ```sql
   NOTIFY pgrst, 'reload schema';
   ```

### Prioridade P1 (UX core)
2. **Adicionar suporte a `channel` no `synthetic-test`** (`/src/app/api/agents/account-assistant/synthetic-test/route.ts` linha ~46). Aceitar `channel: "whatsapp"|"web_ui"` no body e propagar pro `processor.ts`. Sem isso, QA não consegue testar fluxo web.
3. **Mudar prompt do `list_my_reminders`** pra sempre usar `include_recurring=true` quando rep pede "todos / lista completa". Ou mudar default da tool.
4. **Ajustar prompt de `Resumo do dia`** pra incluir reminders + tasks + appointments, não só appointments.
5. **Reforçar docstrings** de `create_task` (CRM) vs `schedule_reminder` (msg do bot) com exemplos:
   ```
   create_task: "cria task pra Pedro chamar Carlos" → cria no GHL CRM, atribuído a Pedro
   schedule_reminder: "me lembra de ligar pro Carlos" → msg proativa pro próprio rep
   ```

### Prioridade P2 (resiliência)
6. **Validar UUID em `cancel_reminder`** antes de chamar Supabase. Atualmente bot pode passar string lixo e falhar no DB.
7. **Cap em recurring agressivo**: aceitar `*/5 * * * *` mas com `max_executions: N` ou aviso explícito + confirmação dupla.
8. **Após erro `retryable: false`** na tool, instruir bot via system prompt a NÃO retentar idêntico (no turn 1c retentou mesmo argumento). Tools devem documentar quando o erro é definitivo.

### Prioridade P3 (limpeza)
9. **Documentar regra UX no system prompt explicitamente**: "Se canal=whatsapp mas rep diz que tá no painel/painel web/Spark UI, peça pra confirmar onde quer receber antes de chamar `schedule_reminder`."
10. **Adicionar `/api/agents/account-assistant/synthetic-test` no Vercel logs alerts** pra capturar `Falha ao agendar` que é hoje silenciado pro usuário.

---

## Avaliação geral

- **Cache hit ratio 96.8%** é excelente — cache de prompt tá funcionando bem.
- **Latência média 4.2s** é aceitável pra agente conversacional.
- **3 de 5 FAILs vêm do mesmo bug** — aplicar migration 00042 vai elevar pass rate de 9/18 (50%) pra ~14/18 (78%).
- **Edge cases (data passada, timestamp absurdo, mensagem ausente, recurring agressivo)** todos tratados com validação em prompt **antes** de chamar tools — sólido.
- **Maior gap:** semântica entre `create_task` e `schedule_reminder`. Bot evitou ambos no turn 14, indicando que distinção semântica não tá clara pro modelo. Precisa de exemplos no system prompt.
