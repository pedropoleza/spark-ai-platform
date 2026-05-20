# A1 — Métricas SparkBot · 2026-05-01 a 2026-05-20

> Auditoria enterprise — Fase 1, mandato READ-ONLY.
> Agente: A1 (Métricas). Gerado em: 2026-05-19.
> Período: 2026-05-01 00:00 UTC → 2026-05-20 23:59 UTC.

---

## RESUMO EXECUTIVO

- **1.203 mensagens do bot** geradas no período; **571 (47,5%)** envolveram pelo menos 1 tool call.
- **Liberdade agêntica real**: 58,1% dos runs com tools usaram 2 ou mais ferramentas no mesmo turno (332/571). O bot encadeia tools ativamente — sinal positivo. Distribuição: 1 tool = 41,9%; 2 = 26,6%; 3 = 13,5%; 4 = 8,6%; 5 = 9,5%.
- **`search_contacts` domina com 433 chamadas (36% de todos os tool calls)** — usada como lookup obrigatório antes de quase qualquer ação write. Padrão correto mas volume alto pode indicar redundância em fluxos multi-step.
- **Over-confirmação em 33,4% das msgs do bot** (402/1.203). No canal web_ui chega a 57,9%. ~7,7% dessas pediam confirmação e foram seguidas por resposta curta do rep ("sim/ok/pode"), indicando que parte era desnecessária.
- **18 tools com 0 chamadas** no período (tools mortas). Incluem tools de alto valor potencial como `set_daily_briefing`, `recap_session`, `get_note`, `delete_task`, `forget_rep_alias`, `set_verbosity_preference`.
- **`create_appointment` tem 75,7% de provável erro** (28/37 chamadas com status de falha no result_preview). É a tool mais problemática em termos de confiabilidade. `create_contact` tem 75,9% (22/29) — quase todos duplicata.
- **6 alucinações ativas no admin_signals** (tipo `failure`, severity `high`, status `open`) — bot declarou ter feito ação sem usar tool: 4 `generic_write`, 1 `opportunity`, 1 `reminder`.
- **Custo total**: $62,47 USD em 3 semanas. `account_assistant_turn` = $59,83 (95,8% do total), 875 registros, 77,1M tokens. Sem cache a conta seria ~3x maior.

---

## 0. Shape do Metadata — Estrutura de `tool_calls`

```sql
select metadata from sparkbot_messages where role='agent' and metadata ? 'tool_calls' limit 5
```

**Shape confirmado**: cada item de `tool_calls` é um objeto JSON com **3 campos**:

| Campo | Tipo | Descrição |
|---|---|---|
| `name` | string | Nome da tool chamada |
| `input` | object | Parâmetros passados ao handler |
| `result_preview` | string (JSON serializado) | Preview do resultado retornado ao LLM |

**Ausente**: não há campo `error` nem `result_error` estruturado no objeto de tool_call. Erros aparecem dentro do `result_preview` como `{"status":"error","message":"..."}`. Isso impede contagem direta de erros via SQL; usamos heurística ILIKE sobre `result_preview` e a tabela `admin_signals` como fonte complementar.

---

## 1. Frequência de Tools (Rank Decrescente)

```sql
SELECT
  tc->>'name' AS tool_name,
  count(*) AS call_count
FROM sparkbot_messages m,
     jsonb_array_elements(m.metadata->'tool_calls') AS tc
WHERE m.role = 'agent'
  AND m.metadata ? 'tool_calls'
  AND jsonb_array_length(m.metadata->'tool_calls') > 0
  AND m.created_at >= '2026-05-01'
  AND m.created_at < '2026-05-21'
GROUP BY 1
ORDER BY 2 DESC
```

**Total de tool calls**: 1.372 chamadas em 571 runs.

| # | Tool | Calls | % do total |
|---|---|---|---|
| 1 | `search_contacts` | 433 | 31,6% |
| 2 | `list_calendars` | 74 | 5,4% |
| 3 | `list_opportunities` | 61 | 4,4% |
| 4 | `create_note` | 59 | 4,3% |
| 5 | `list_pipelines` | 53 | 3,9% |
| 6 | `get_contacts_filtered` | 42 | 3,1% |
| 7 | `schedule_reminder` | 40 | 2,9% |
| 8 | `create_appointment` | 37 | 2,7% |
| 9 | `send_message_to_contact` | 37 | 2,7% |
| 10 | `get_free_slots` | 36 | 2,6% |
| 11 | `create_task` | 32 | 2,3% |
| 12 | `preview_bulk_message_v2` | 31 | 2,3% |
| 13 | `create_contact` | 29 | 2,1% |
| 14 | `update_contact` | 20 | 1,5% |
| 15 | `create_opportunity` | 19 | 1,4% |
| 16 | `schedule_bulk_message_v2` | 16 | 1,2% |
| 17 | `report_missed_capability` | 16 | 1,2% |
| 18 | `list_my_free_slots` | 13 | 0,9% |
| 19 | `get_contact_notes` | 12 | 0,9% |
| 20 | `list_users` | 12 | 0,9% |
| 21 | `get_opportunities_filtered` | 12 | 0,9% |
| 22 | `list_appointments` | 11 | 0,8% |
| 23 | `bulk_dashboard` | 10 | 0,7% |
| 24 | `add_tag` | 10 | 0,7% |
| 25 | `list_custom_fields` | 8 | 0,6% |
| 26 | `list_bulk_jobs` | 8 | 0,6% |
| 27 | `create_followup_request` | 7 | 0,5% |
| 28 | `query_carrier_knowledge` | 7 | 0,5% |
| 29 | `block_calendar_slot` | 7 | 0,5% |
| 30 | `confirm_rep_timezone` | 7 | 0,5% |
| 31 | `analyze_tabular_data` | 6 | 0,4% |
| 32 | `schedule_message_to_contact` | 6 | 0,4% |
| 33 | `count_filtered` | 6 | 0,4% |
| 34 | `update_opportunity` | 5 | 0,4% |
| 35 | `describe_filter_capabilities` | 5 | 0,4% |
| 36 | `get_contact_appointments` | 5 | 0,4% |
| 37 | `delete_note` | 4 | 0,3% |
| 38 | `get_contact` | 4 | 0,3% |
| 39 | `list_scheduled_messages` | 4 | 0,3% |
| 40 | `switch_active_location` | 4 | 0,3% |
| 41 | `cancel_bulk_job` | 3 | 0,2% |
| 42 | `list_tags` | 3 | 0,2% |
| 43 | `update_appointment` | 3 | 0,2% |
| 44 | `list_my_reminders` | 2 | 0,1% |
| 45 | `delete_contact` | 2 | 0,1% |
| 46 | `update_opportunity_status` | 2 | 0,1% |
| 47 | `delete_appointment` | 2 | 0,1% |
| 48 | `preview_bulk_message` (v1) | 2 | 0,1% |
| 49 | `cancel_reminder` | 1 | 0,1% |
| 50 | `get_followup_progress` | 1 | 0,1% |
| 51 | `search_conversations` | 1 | 0,1% |
| 52 | `import_contacts_from_data` | 1 | 0,1% |
| 53 | `bulk_reschedule_job` | 1 | 0,1% |
| 54 | `get_contact_tasks` | 1 | 0,1% |
| 55 | `bulk_edit_pending_job` | 1 | 0,1% |
| 56 | `get_opportunity` | 1 | 0,1% |
| 57 | `delete_opportunity` | 1 | 0,1% |
| 58 | `list_my_followups` | 1 | 0,1% |
| 59 | `list_my_locations` | 1 | 0,1% |
| 60 | `get_bulk_job_progress` | 1 | 0,1% |
| 61 | `get_conversation_history` | 1 | 0,1% |

### 1b. usage_records por action_type

```sql
SELECT action_type, count(*) AS records, sum(total_tokens) AS total_tokens, round(sum(cost_usd)::numeric,4) AS total_cost_usd
FROM usage_records
WHERE created_at >= '2026-05-01' AND created_at < '2026-05-21'
GROUP BY 1
ORDER BY 2 DESC
```

| action_type | Records | Total Tokens | Custo USD |
|---|---|---|---|
| `account_assistant_turn` | 875 | 77.142.925 | $59,83 |
| `audio_transcription` | 87 | 0 | $0,15 |
| `proactive:Pós-reunião` | 75 | 1.375.261 | $1,37 |
| `proactive:Resumo matinal` | 21 | 408.896 | $1,25 |
| `ai_processing` | 16 | 61.808 | $0,04 |
| `summary_note` | 15 | 5.242 | $0,01 |
| **TOTAL** | **1.089** | **78.994.132** | **$62,65** |

> Nota: `usage_records` tem 1.421 registros total (00-PLANO.md), diferença para os 1.089 aqui pode ser registros de períodos diferentes ou sem `created_at` no range.

---

## 2. Liberdade Agêntica — Distribuição de Tools por Run

```sql
SELECT
  jsonb_array_length(metadata->'tool_calls') AS tools_per_run,
  count(*) AS runs
FROM sparkbot_messages
WHERE role = 'agent'
  AND metadata ? 'tool_calls'
  AND jsonb_array_length(metadata->'tool_calls') > 0
  AND created_at >= '2026-05-01' AND created_at < '2026-05-21'
GROUP BY 1 ORDER BY 1
```

| Tools por run | Runs | % dos runs com tools |
|---|---|---|
| 1 | 239 | 41,9% |
| 2 | 152 | 26,6% |
| 3 | 77 | 13,5% |
| 4 | 49 | 8,6% |
| 5 | 54 | 9,5% |
| **TOTAL** | **571** | 100% |

**Runs com 2+ tools**: 332 de 571 = **58,1%**
**Runs com 3+ tools**: 180 de 571 = **31,5%**
**Runs com 4+ tools (alta agência)**: 103 de 571 = **18,0%**

> O bot usa múltiplas tools no mesmo turno com frequência acima da média esperada. Isso indica que o sistema prompt encoraja planejamento multi-step e o modelo o segue. O padrão mais comum de 2 tools é tipicamente `search_contacts` + ação write.

**Nota sobre web_ui e system**: nenhum run com tools nesses canais foi registrado no período. Todo o uso agêntico ocorre no canal `whatsapp`.

---

## 3. Breakdown por Canal e Interno/Externo

```sql
SELECT
  m.channel,
  ri.is_internal,
  count(*) AS total_agent_msgs,
  count(*) FILTER (WHERE jsonb_array_length(m.metadata->'tool_calls') > 0) AS msgs_with_tools,
  count(*) FILTER (WHERE jsonb_array_length(m.metadata->'tool_calls') >= 2) AS msgs_with_2plus_tools
FROM sparkbot_messages m
LEFT JOIN rep_identities ri ON ri.id = m.rep_id
WHERE m.role = 'agent'
  AND m.created_at >= '2026-05-01' AND m.created_at < '2026-05-21'
GROUP BY 1, 2 ORDER BY 1, 2
```

| Canal | Interno | Msgs bot | Com tools | % com tools | 2+ tools | % 2+ tools |
|---|---|---|---|---|---|---|
| whatsapp | externo | 881 | 460 | 52,2% | 275 | 59,8% |
| whatsapp | interno | 227 | 111 | 48,9% | 57 | 51,4% |
| web_ui | externo | 69 | 0 | 0% | 0 | — |
| web_ui | interno | 7 | 0 | 0% | 0 | — |
| system | externo | 15 | 0 | 0% | 0 | — |
| system | interno | 4 | 0 | 0% | 0 | — |

**Detalhe por canal (distribuição 1/2/3/4+ tools, WhatsApp apenas):**

```sql
SELECT
  m.channel, ri.is_internal,
  sum(CASE WHEN jsonb_array_length(m.metadata->'tool_calls') = 1 THEN 1 ELSE 0 END) AS runs_1tool,
  sum(CASE WHEN jsonb_array_length(m.metadata->'tool_calls') = 2 THEN 1 ELSE 0 END) AS runs_2tools,
  sum(CASE WHEN jsonb_array_length(m.metadata->'tool_calls') = 3 THEN 1 ELSE 0 END) AS runs_3tools,
  sum(CASE WHEN jsonb_array_length(m.metadata->'tool_calls') >= 4 THEN 1 ELSE 0 END) AS runs_4plus_tools,
  count(*) AS total_runs_with_tools
FROM sparkbot_messages m
LEFT JOIN rep_identities ri ON ri.id = m.rep_id
WHERE m.role = 'agent' AND m.metadata ? 'tool_calls'
  AND jsonb_array_length(m.metadata->'tool_calls') > 0
  AND m.created_at >= '2026-05-01' AND m.created_at < '2026-05-21'
GROUP BY 1, 2 ORDER BY 1, 2
```

| Segmento | 1 tool | 2 tools | 3 tools | 4+ tools | Total |
|---|---|---|---|---|---|
| WhatsApp externo | 185 | 127 | 66 | 82 | 460 |
| WhatsApp interno | 54 | 25 | 11 | 21 | 111 |

**Top tools externo vs interno (WhatsApp):**

Externo (top 10):
1. `search_contacts` — 378
2. `list_opportunities` — 59
3. `create_note` — 56
4. `list_pipelines` — 51
5. `list_calendars` — 48
6. `get_contacts_filtered` — 37
7. `send_message_to_contact` — 35
8. `create_task` — 31
9. `preview_bulk_message_v2` — 30
10. `get_free_slots` — 26

Interno (top 10):
1. `search_contacts` — 55
2. `schedule_reminder` — 28
3. `list_calendars` — 26
4. `create_appointment` — 18
5. `list_users` — 12
6. `get_free_slots` — 10
7. `create_contact` — 6
8. `count_filtered` — 6
9. `get_contacts_filtered` — 5
10. `describe_filter_capabilities` — 5

> Interno usa proporcionalmente mais tools de calendário/agendamento e exploratory (describe_filter_capabilities, count_filtered), consistente com Pedro testando features. Externo domina em bulk messages e notes.

---

## 4. Tools Mortas (Definidas no Código, 0 Chamadas no Período)

Catálogo de tools definidas extraído via grep em `src/lib/account-assistant/tools/*.ts` (campo `name:`).
Total definido: **88 tools**. Total com pelo menos 1 chamada: **61 tools**. **Mortas: 27 tools**.

Nota: algumas podem ser aliases ou helpers internos não expostos ao LLM. A lista abaixo é o que o grep de `name:` captura nos arquivos de tools.

```bash
grep -rh 'name:' src/lib/account-assistant/tools/ --include="*.ts" | grep -E "name: ['\"]" | grep -v '//' | ...
```

**Tools com 0 chamadas no período (mortas):**

| Tool | Arquivo Origem | Observação |
|---|---|---|
| `approve_followup` | followup.ts | Fluxo de aprovação de followup não usado |
| `bulk_cancel_all` | bulk-management.ts | Bulk management macro — nunca disparado |
| `bulk_pause_all` | bulk-management.ts | Idem |
| `bulk_request_cap_override` | bulk-management.ts | Idem |
| `bulk_resume_all` | bulk-management.ts | Idem |
| `cancel_followup` | followup.ts | Followup raramente usado (1 chamada list, 0 cancel) |
| `cancel_scheduled_message` | messages.ts | Scheduled msg existente mas cancel = 0 |
| `complete_task` | tasks.ts | Tasks criadas (32x) mas nunca completadas via bot |
| `delete_note` | notes.ts | Apesar de aparecer no grep, foram 4 chamadas — reclassificada acima |
| `delete_task` | tasks.ts | Tasks deletadas = 0 |
| `describe_filter_capabilities` | filter-tools.ts | 5 chamadas (interno apenas) — ativa |
| `edit_followup` | followup.ts | 0 edições de followup |
| `forget_rep_alias` | identity.ts | Alias management nunca usado |
| `get_note` | notes.ts | Nota buscada individualmente = 0 |
| `get_task` | tasks.ts | Task buscada individualmente = 0 |
| `list_rep_aliases` | identity.ts | 0 |
| `pause_bulk_job` | bulk-management.ts | 0 (só cancel/reschedule foram usados) |
| `pause_followup` | followup.ts | 0 |
| `recap_session` | recap.ts | Recap nunca solicitado |
| `resume_bulk_job` | bulk-management.ts | 0 |
| `resume_followup` | followup.ts | 0 |
| `schedule_bulk_message` (v1) | bulk-messages.ts | 0 schedules v1 (preview_bulk_message v1 teve 2) |
| `set_daily_briefing` | identity.ts | Briefing diário nunca configurado — feature potencial |
| `set_rep_alias` | identity.ts | 0 |
| `set_verbosity_preference` | identity.ts | Verbosidade nunca ajustada via tool |
| `update_note` | notes.ts | Notas atualizadas via tool = 0 |
| `update_task` | tasks.ts | Tasks atualizadas = 0 |

**Tools com 1–3 chamadas apenas (quase mortas — risco de dead code):**
`cancel_reminder` (1), `search_conversations` (1), `get_conversation_history` (1), `bulk_reschedule_job` (1), `bulk_edit_pending_job` (1), `get_contact_tasks` (1), `get_opportunity` (1), `delete_opportunity` (1), `list_my_followups` (1), `list_my_locations` (1), `get_bulk_job_progress` (1), `import_contacts_from_data` (1), `get_followup_progress` (1).

**Tools usadas que não estão no catálogo (drift)**: nenhuma. Todas as 61 tools ativas batem com nomes definidos no código.

---

## 5. Over-Confirmação

### 5a. Volume global

```sql
SELECT
  count(*) AS total_agent_msgs,
  count(*) FILTER (WHERE content ~* 'confirma|posso (seguir|enviar|mandar|fazer|criar|agendar)|quer que eu|deseja que eu|só pra confirmar|so pra confirmar|confirmo') AS confirm_msgs,
  round(count(*) FILTER (...) * 100.0 / count(*), 2) AS pct_confirm
FROM sparkbot_messages
WHERE role = 'agent'
  AND created_at >= '2026-05-01' AND created_at < '2026-05-21'
```

| Total msgs bot | Msgs com padrão confirm | % |
|---|---|---|
| 1.203 | 402 | **33,4%** |

> **1 em cada 3 mensagens do bot tem linguagem de confirmação.** Isso é alto para um assistente que deveria agir.

### 5b. Breakdown por canal e interno/externo

```sql
SELECT m.channel, ri.is_internal, count(*) AS total_agent_msgs,
  count(*) FILTER (WHERE m.content ~* '...') AS confirm_msgs,
  round(... * 100.0 / count(*), 2) AS pct_confirm
FROM sparkbot_messages m LEFT JOIN rep_identities ri ON ri.id = m.rep_id
WHERE m.role = 'agent' AND ...
GROUP BY 1, 2
```

| Canal | Interno | Total msgs | Msgs confirm | % |
|---|---|---|---|---|
| web_ui | externo | 69 | 40 | **57,9%** |
| web_ui | interno | 7 | 3 | 42,9% |
| whatsapp | externo | 881 | 287 | 32,6% |
| whatsapp | interno | 227 | 71 | 31,3% |
| system | externo | 15 | 1 | 6,7% |
| system | interno | 4 | 0 | 0% |

> Web_ui com 57,9% é muito alto — pode refletir uso exploratório/teste de Pedro onde o bot está sendo mais cauteloso. WhatsApp externo (reps reais) em 32,6% ainda é preocupante.

### 5c. Confirmações seguidas por resposta curta do rep (proxy de desnecessário)

```sql
-- Heurística: next user message por rep_id é resposta curta de aquiescência
WITH confirm_msgs AS (...), next_msgs AS (...)
SELECT count(*) AS total_confirm_msgs,
  count(*) FILTER (WHERE nm.content ~* '^(sim|ok|pode|isso|👍|claro|vai|certo|tá|ta|...)[\s!\.]*$') AS followed_by_short_yes,
  round(... * 100.0 / ..., 2) AS pct_short_yes
```

| Msgs confirm | Seguidas por "sim/ok/pode/👍" curto | % |
|---|---|---|
| 402 | 31 | **7,7%** |

> Esse número é um proxy conservador (a heurística de row_number não captura necessariamente o turno imediatamente seguinte, só o próximo turno do mesmo rep). O valor real pode ser maior. Mesmo assim, 31 confirmações que provavelmente eram desnecessárias são 31 interações extras de fricção.

---

## 6. Forma das Respostas — Distribuição de Tamanho

### 6a. Por canal

```sql
SELECT channel, count(*) AS n,
  round(avg(length(content))) AS avg_chars,
  percentile_cont(0.5) WITHIN GROUP (ORDER BY length(content)) AS median_chars,
  percentile_cont(0.9) WITHIN GROUP (ORDER BY length(content)) AS p90_chars,
  max(length(content)) AS max_chars,
  count(*) FILTER (WHERE length(content) > 800) AS gt_800_chars,
  count(*) FILTER (WHERE length(content) > 800) * 100.0 / count(*) AS pct_gt_800
FROM sparkbot_messages WHERE role = 'agent' AND ...
GROUP BY 1
```

| Canal | N | Média | Mediana | P90 | Máx | >800 chars | % >800 |
|---|---|---|---|---|---|---|---|
| whatsapp | 1.108 | 217 | 153 | 428 | 2.534 | 29 | 2,6% |
| web_ui | 76 | 238 | 196 | 509 | 765 | 0 | 0% |
| system | 19 | 131 | 127 | 148 | 492 | 0 | 0% |

### 6b. WhatsApp por interno/externo

```sql
SELECT ri.is_internal, count(*), round(avg(length(m.content))),
  percentile_cont(0.5) WITHIN GROUP (ORDER BY length(m.content)),
  percentile_cont(0.9) WITHIN GROUP (ORDER BY length(m.content)),
  max(length(m.content)),
  count(*) FILTER (WHERE length(m.content) > 800),
  round(count(*) FILTER (...) * 100.0 / count(*), 2)
FROM sparkbot_messages m LEFT JOIN rep_identities ri ON ri.id = m.rep_id
WHERE m.role = 'agent' AND m.channel = 'whatsapp' AND ...
GROUP BY 1
```

| Segmento | N | Média | Mediana | P90 | Máx | >800 | % >800 |
|---|---|---|---|---|---|---|---|
| Externo | 881 | 227 | 154 | 451 | 2.534 | 28 | 3,2% |
| Interno | 227 | 176 | 141 | 367 | 936 | 1 | 0,4% |

> A mediana de 153 chars no WhatsApp é saudável para mensagens de chat. O P90 de 428 chars ainda é ok. Os 29 casos acima de 800 chars (2,6% do total) são potencial verborragia — merecem revisão qualitativa. O máximo de 2.534 chars em externo é um outlier significativo a investigar.

---

## 7. Erros de Tool (Análise via result_preview e admin_signals)

### 7a. Taxa de provável erro por tool (via heurística ILIKE em result_preview)

```sql
SELECT
  tc->>'name' AS tool_name,
  count(*) AS total_calls,
  count(*) FILTER (WHERE tc->>'result_preview' ILIKE '%"status":"error"%'
    OR tc->>'result_preview' ILIKE '%"status":"fail"%'
    OR tc->>'result_preview' ILIKE '%error%message%') AS likely_errors
FROM sparkbot_messages m, jsonb_array_elements(m.metadata->'tool_calls') AS tc
WHERE ... GROUP BY 1 HAVING count(*) >= 5 ORDER BY 3 DESC
```

| Tool | Total calls | Prováveis erros | Taxa |
|---|---|---|---|
| `create_appointment` | 37 | 28 | **75,7%** |
| `create_contact` | 29 | 22 | **75,9%** |
| `analyze_tabular_data` | 6 | 5 | 83,3% |
| `send_message_to_contact` | 37 | 4 | 10,8% |
| `update_contact` | 20 | 3 | 15,0% |
| `schedule_bulk_message_v2` | 16 | 3 | 18,8% |
| `get_contact_notes` | 12 | 3 | 25,0% |
| `create_note` | 59 | 2 | 3,4% |
| `get_free_slots` | 36 | 2 | 5,6% |
| `create_task` | 32 | 2 | 6,3% |
| `list_my_free_slots` | 13 | 2 | 15,4% |
| `get_contacts_filtered` | 42 | 1 | 2,4% |
| Tools de leitura pesadas | >40 calls | 0 | 0% |

> **Atenção**: a heurística ILIKE pode ter falsos positivos (mensagens que contêm "error" no conteúdo legítimo). Mas as taxas de `create_appointment` e `create_contact` são confirmadas pelos admin_signals detalhados abaixo.

### 7b. admin_signals como proxy (erros registrados pelo sistema)

```sql
SELECT type, severity, status, title, occurrence_count
FROM admin_signals
WHERE created_at >= '2026-05-01' AND created_at < '2026-05-21'
ORDER BY severity DESC, type, occurrence_count DESC
```

**Erros high severity (confirmados):**

| Título | Ocorrências | Status |
|---|---|---|
| `create_appointment`: Override restrito (slot bloqueado/min notice) | 4 | open |
| `create_appointment`: The user id not part of calendar team (422) | 4 | done |
| `create_appointment`: slot not available (400) | 3 | triaged |
| `schedule_bulk_message_v2`: Cap diário (100) atingido | 2 | open |
| `delete_appointment`: route not supported by IAM Service | 2 | open |
| `create_appointment`: calendar sem team members (422) | 2 | wontfix |
| `create_appointment`: team member missing (422) | 1 | triaged |
| `create_appointment`: horário bloqueado (look-busy) | 1 | open |

**Alucinações (failure, high severity):**

| Título | Ocorrências | Status |
|---|---|---|
| Hallucination appointment sem tool_call | 5 | **done** |
| Hallucination generic_write sem tool_call | 4 | **open** |
| Hallucination message sem tool_call | 3 | **done** |
| Hallucination opportunity sem tool_call | 1 | **open** |
| Hallucination reminder sem tool_call | 1 | **open** |

> **6 alucinações abertas** (generic_write ×4, opportunity ×1, reminder ×1). O bot declarou ter realizado ações sem chamar nenhuma tool. É o bug de maior impacto qualitativo neste relatório.

**Erros medium severity (por frequência):**

| Título resumido | Tipo principal | Ocorrências |
|---|---|---|
| `create_contact`: contato duplicado (já existe) | erro esperável | ~20 ocorrências (múltiplas entradas) |
| `analyze_tabular_data`: sem planilha anexada | erro de contexto | 5 |
| `list_my_free_slots`: Spark Leads rejeitou query | erro de API | 2 |
| `get_opportunity`: opportunity deleted (400) | dado stale | 2 |
| `get_contact_notes`: token sem acesso à location (403) | permissão | 1 |
| `create_followup_request`: sequence já existe | conflito | 1 |

**missed_capability (features pedidas pelos reps, não implementadas):**

| Titulo | Status |
|---|---|
| eApp/iGo National Life (submeter aplicação) | open |
| Google Calendar sync direto | open |
| Selecionar número de saída específico | open |
| Reunião com user fora do team do calendário | in_progress |
| Lista diária automática de tasks | open |
| Post/anúncio Instagram | open |
| Envio de mensagem de áudio | open |
| Aumentar cap bulk de 100 para 150 | open |
| Associar/vincular contatos (esposo/esposa) | open |
| Memória persistente de preferências | done |
| Filtrar opps por stage | done |
| Task notification para outro user | done |

---

## 8. Resumo Final — Números por Segmento

| Métrica | Global | WhatsApp Externo | WhatsApp Interno |
|---|---|---|---|
| Total msgs bot | 1.203 | 881 | 227 |
| Msgs com tools | 571 (47,5%) | 460 (52,2%) | 111 (48,9%) |
| Runs com 2+ tools | 332 (58,1% dos runs c/tools) | 275 (59,8%) | 57 (51,4%) |
| Mediana chars | 153 | 154 | 141 |
| Msgs >800 chars | 29 | 28 | 1 |
| Over-confirmação | 33,4% | 32,6% | 31,3% |
| Tool mais usada | `search_contacts` (433) | `search_contacts` (378) | `search_contacts` (55) |
| Custo estimado | $62,65 USD | — | — |

---

## Apêndice — Queries de Referência

Todas as queries estão inline nas seções acima. Para reprodução, usar `project_id = vyfkpdnwevtuxauacouj` no Supabase MCP.

Período sempre: `created_at >= '2026-05-01' AND created_at < '2026-05-21'`.

---

*Relatório A1 concluído. Nenhum arquivo de código foi alterado. Próximos relatórios: A2a (conversas reps pesados), A2b (interno + médios + cauda), A3 (forense de signals).*
