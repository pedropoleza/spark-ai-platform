# SparkBot — Estatísticas de uso (últimos 7 dias, 2026-06-17 → 2026-06-24)

Fonte: `sparkbot_messages` + `admin_signals` (Supabase prod). Total **2015 mensagens**, **28 reps** ativos, canal quase 100% WhatsApp (web_ui = 2 msgs, morto).

## Volume por dia (WhatsApp; agent/user)
| Dia | agent | user | reps |
|-----|-------|------|------|
| 06-24 (parcial) | 19 | 15 | 5 |
| 06-23 | 199 | 166 | 20 |
| 06-22 | 212 | 167 | 17 |
| 06-21 | 24 | 20 | 8 (fim de semana) |
| 06-20 | 67 | 62 | 6 |
| 06-19 | 259 | 242 | 14 (pico) |
| 06-18 | 199 | 183 | 15 |
| 06-17 | 69 | 55 | 10 |

Pico em dias úteis (~250 msgs/dia, ~14-20 reps). Cai no fim de semana.

## Top reps por volume (7d)
1. **Jussara Ferreira** — 444 (205 user / 239 agent) ⚠️ outlier
2. **Daniely Jones** — 263
3. **Bruno Schneider Cruz** — 210
4. **Sieder Madrona** — 194
5. **Gustavo Couto** — 152
6. **Cintia Berti** — 122
7. John Doe [INTERNO/Pedro] — 88
8. Sabrina Caldas — 78
9. Manuela Garcia — 66
10. Marcos Alves — 58 · Soraia Close — 55 · Ana Paula Rangel — 43 · Victor Alves — 43 · Matheus Curty — 43
- Cauda longa: ~13 reps com <30 msgs. ~6 power users concentram a maioria.

## Ferramentas mais usadas (chamadas / reps distintos)
| Tool | usos | reps | categoria |
|------|------|------|-----------|
| search_contacts | 630 | 19 | **busca (dominante)** |
| present_options | 173 | 18 | UI interativa (botões) |
| list_calendars | 104 | 13 | agendamento |
| schedule_message_to_contact | 82 | 5 | **mensagem agendada** |
| create_appointment | 72 | 8 | agendamento |
| create_note | 57 | 9 | nota |
| get_free_slots | 54 | 13 | agendamento |
| create_task | 50 | 9 | tarefa |
| get_contact_appointments | 45 | 6 | agendamento |
| schedule_reminder | 31 | 8 | lembrete |
| send_message_to_contact | 29 | 6 | mensagem imediata |
| list_opportunities | 26 | 8 | funil |
| list_appointments | 24 | 6 | agenda |
| list_pipelines | 22 | 8 | funil |
| create_contact | 22 | 7 | contato |
| get_contact_notes | 21 | 5 | nota |
| create_followup_request | 19 | 3 | follow-up (H33) |
| query_carrier_knowledge | 16 | 4 | **KB seguro (NLG)** |
| get_contacts_filtered | 16 | 3 | filtro |
| move_opportunity / add_tag / report_missed_capability | 10-11 | — | funil/tag/gap |
| start_task_draft / add_step / commit_draft | 6/13/3 | 1-2 | orquestrador (H41, recém-live) |

**Clusters de uso real:** (1) Agendar/reagendar reunião — o maior. (2) Mandar/agendar mensagem pro contato. (3) Notas + tasks (registro pós-call). (4) Funil (opps/pipeline/tags). (5) Lembretes. (6) Dúvidas de produto (carrier KB). (7) Follow-up/orquestração (nascente).

## Falhas técnicas duras (raras)
- `llm_failed=3`, `send_error=1`, `not_sent=1` em 1103 msgs de agent. **Entrega quase sempre funciona.** O problema NÃO é técnico-duro — é qualidade/fluência/capacidade.

## admin_signals (7d) — o que dói de verdade
**missed_capability (o que reps PEDEM e o bot NÃO faz):**
- Templates de mensagem reutilizáveis por categoria/assunto (×2 — pedido recorrente)
- Extração automática de PDF de apólice → custom fields (×2)
- E-mail OPCIONAL no formulário de agendamento do calendário (×3 — atrito claro)
- Agendamento recorrente automático de reuniões (semanal)
- Follow-up cíclico (reinicia após completar)
- Criar/editar automações e workflows no Spark Leads
- Trigger automático de fluxo ao adicionar tag

**error medium/high (operacionais):** slot ocupado em create/update_appointment; `Location is not active` (search/list_calendars); token sem acesso (get_contact 403); `email must be an email`; IAM não suporta delete (3 locations); structured-output caindo no fallback de texto; turno parou por orçamento de tempo (anti-timeout); LLM lead-facing tier degradado.

**failure:** Coherence loop-breaker / rerun (tag sem tool) / rewrite (appointment sem tool) — bot pego afirmando sem tool. 5 reps pausados por silêncio (proativos sem resposta). **CRÍTICO: SparkBot inbound MUDO** (Stevo SPOF).

## Hipóteses a confirmar nos transcripts (lado qualitativo)
- Falsas confirmações ("feito ✅" sem fazer) — atrito #1 do estudo anterior.
- Robótico: present_options demais? recapitula demais? pergunta o que já sabe?
- Áudio é load-bearing (reps mandam voz).
- Oportunidades proativas não exploradas: resumo de funil, números da conta, dicas, lembretes inteligentes.
