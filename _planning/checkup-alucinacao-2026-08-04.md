# Check-up de alucinação do SparkBot — 2026-08-04

Disparado pela queixa do Milton ("quinta-feira é dia 6, o sistema insiste que é dia 7").
Método: 5 lentes independentes sobre 21 dias de conversa real (4.522 mensagens, 57 reps),
cada achado re-verificado por um segundo agente contra o banco, mais varredura
determinística em SQL. **Dia-da-semana sempre calculado no Postgres, nunca por LLM** — um
auditor LLM cairia no mesmo erro do auditado.

## Causa-raiz do caso Milton

O modelo mapeia dia-da-semana ↔ data pelo **calendário de 2025**, não pelo corrente.
Como 2025 tem 365 dias, todo dia-da-semana de 2026 fica exatamente +1 — daí o padrão
perfeito. Medido:

| | pares "dia + data" | errados | atores |
|---|---|---|---|
| SparkBot (rep) | 401 | **66 (16,5%)** | 17 reps |
| Lead-facing | 84 | 7 (8,3%) | 3 agentes |

**73 de 73 errados batem com 2025. Nenhum com 2026.** Erro de aritmética espalharia
±1/±7 aleatoriamente.

Contraprova do mecanismo: o lead-facing erra 10× menos porque quase sempre COPIA a lista
de horários, que é gerada por código. Quando o dado vem do código, acerta; quando o
modelo deriva, erra.

## Corrigido nesta sessão

| Onda | O quê | Commits |
|---|---|---|
| Grounding | Tabela `[CALENDÁRIO REAL]` de 3 semanas no runtime context dos 2 motores (~165 tok) + regra 1 do agendamento reescrita (mandava "calcule a data", que é o que ele não sabe fazer) | `fb2b09b` |
| Trava | Servidor infere `expected_weekday` da fala do rep e cruza o "dia N" falado com o dia gravado — a trava H50 era opt-in do modelo | `3ac563c`, `baf9b34` |
| Onda 0 | Trava estendida a `schedule_reminder`, `schedule_message_to_contact`, `create_task`/`update_task` e reagendamento de follow-up + fuso unificado (`ctx.repTz`) | `20695a1` |
| Canário | `scripts/audit-weekday-drift.ts` com a linha de base pré-fix | `0c3ce90` |

Além do H67 (id de stanza longo) no spark-os, que destravou a proatividade no mesmo dia.

## Dano medido (não estimado)

**Reuniões marcadas no dia errado — 5, em 4 reps:** Caua (Yasmin 16/07, Júlia 14/07),
Danielle (Eveline 17/07), Sidney (Eva Aracy 17/07, Eliana 18/07).

**Disparos executados no dia errado — 4, sendo 3 mensagens entregues ao LEAD:**

| linha | rep pediu | executou |
|---|---|---|
| `ceba8e19` | "Sexta feira 1pm" | sábado 18/07 13:00 |
| `efff4ce2` | "terça 9h" | quarta 22/07 (Paula Gomes) |
| `d933cbac` | "próxima terça, 11h" | quarta 22/07 (Niuzete) |
| `e60a9ab2` | "quarta que vem ao meio-dia" | quinta 23/07 (Paula Gomes) |

**O padrão mais caro não é a data — é a teimosia.** Zero autocorreções de data em 21
dias, e as contestações explícitas do rep foram todas reafirmadas:
- Sidney: *"não, sexta é quinta-feira"* → bot: *"Entendido! Quinta-feira 17/07 está certo então. Foi marcada corretamente ✅"*
- Milton: corrigiu 2×, bot devolveu menu com as DUAS datas erradas e a errada pré-marcada.

## Aberto — precisa de decisão ou investigação

1. **14 lembretes `completed` sem gerar mensagem nenhuma** (12 são do Gustavo Couto =
   67% dos lembretes dele). Sem sinal, sem `execution_log`, sem linha em
   `sparkbot_messages`. Causa desconhecida — wallet/loop-guard explica no máximo 2.
   Pior que o 479: ali existia ao menos a linha `not_sent=true`.
2. **Correção de mensagem agendada cria envio novo em vez de substituir.** A cliente
   Iara (rep Angel) recebeu 3 mensagens em 3 segundos, 2 com o texto pré-correção.
   `cancel_scheduled_message` existe; o LLM nunca chama. O dedup atual casa por texto
   idêntico — exatamente o oposto do necessário.
3. **Dossiê de contato inventado** (Marcelo Messias, rep Gustavo): `tools=[]`, nenhuma
   leitura, e ao ser questionado o bot inventou a fonte ("veio das notas"). 2 casos.
4. **"Não achei X" sem ter buscado** — 4 casos; um quase virou duplicata de cliente ativa.
5. **Sem canário de asserção-sem-leitura.** 55% dos turnos não chamam nenhuma tool de
   leitura e não existe nenhum sinal em `admin_signals` — é por isso que nada disso
   apareceu sozinho.

## O que NÃO foi possível verificar

- **O estado real no Spark Leads.** Tudo veio do Supabase; "gravou X" é o que o bot
  narrou ou a linha em `assistant_scheduled_tasks`, não o CRM.
- Dano comercial das 3 mensagens que saíram ao lead no dia errado.
- Causa dos 14 lembretes fantasma.
- As contagens variam entre lentes (60/77/101 pares em janelas e regex diferentes) —
  mesma ordem de grandeza (~15%), nenhuma é exata.
