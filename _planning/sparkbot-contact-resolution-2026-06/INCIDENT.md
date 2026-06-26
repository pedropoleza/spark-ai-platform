# Incidente-âncora + evidência de prod — resolução de contato (2026-06-26)

> Caso reportado pelo Pedro (print da conversa Sabrina × SparkBot). Grounding do estudo.

## A conversa (rep Sabrina, rep_id `214d1281…`, location `K9b92VcD0KdCMIn60y0W`)
- **08:00** proativo (briefing): "3 reuniões hoje: 12PM **Fernanda** (Recrutamento 2º encontro)…"
- **09:45** proativo (`ghl_task_reminder`): "🔔 Follow-up recrutamento com **Fernanda Lira** … a tarefa vence em ~15min. Quer marcar como concluída, adiar…?"
- **10:55** REP: "**Fernanda Lira** follow up de recrutamento semana que vem dia 6"
- **10:55** BOT (Sonnet 4.6, chamou `search_contacts`): "**Não achei a Fernanda Lira no CRM.** Pode me passar o telefone ou email dela pra eu localizar?"

## Prova #1 — a contato EXISTE; a busca exata é o culpado (probe `scripts/probe-fernanda-search.ts`)
| Query | Resultado |
|---|---|
| `"Fernanda Lira"` (o que o bot fez) | **0 resultados** |
| `"fernanda lira"` (lower) | 0 |
| `"Fernanda L"` | 0 |
| `"Fernanda"` | 3 — outras Fernandas, **não ela** |
| `"Lira"` (sobrenome, grafia certa) | **1 → "fernan­ada lira"** (`58OGJEO8yPtucmBXjZoq`), phone +1 732 978 2721 |

→ **A contato está cadastrada com o PRIMEIRO NOME DIGITADO ERRADO: "fernanada lira"** (um "a" a mais). A busca do GHL exige todos os tokens batendo (AND); "Fernanda" ≠ "fernanada" (1 char) → 0. Buscar só "Lira" acha. **Um fuzzy match (trigram) "Fernanda Lira"→"fernanada lira" daria ~0.9** e resolveria.

## Prova #2 — o sistema TINHA o contactId e jogou fora (herança falhou)
Lembrete `assistant_scheduled_tasks` id `5aa5b196…`, `task_payload`:
```json
{ "title": "Follow-up recrutamento com Fernanda Lira",
  "contact_id": "58OGJEO8yPtucmBXjZoq",   // ← o MESMO id da "fernanada lira"
  "ghl_task_id": "p8PujANcV5NBJtNFAsoV", "due_at": "2026-06-26T14:00:00Z" }
```
Mas a mensagem proativa persistida em `sparkbot_messages.metadata` só guardou `reminder_id` — **`contact_id` NÃO foi pra conversa nem pro contexto do próximo turno**. Quando a rep respondeu, o bot não tinha vínculo nenhum com `58OGJEO8` e re-buscou do zero.

→ **Falha dupla, as duas evitáveis:** (1) herdar `contact_id=58OGJEO8` do proativo = zero busca; (2) fuzzy resolver "Fernanda Lira"→"fernanada lira" ~90% = auto-confirma.

## Tamanho do problema (sistêmico, não isolado) — `sparkbot_messages`, 7 dias
- **45** msgs "não achei / não encontrei / não localizei"
- **28** msgs "me passa o telefone/email/sobrenome"
- **14 reps distintos** afetados (~metade da base ativa de ~28)
- 1117 msgs de agent no total → o "não achei" aparece em ~4% das mensagens do bot (e numa fração bem maior das CONVERSAS)
- **Todos em Sonnet 4.6** — NÃO é o fallback gpt-4.1. É comportamento estrutural.

## Modos de quebra (do texto do próprio bot em prod)
- **Typo no cadastro**: "fernanada" (caso âncora).
- **Acento**: "pode ser que esteja cadastrado diferente (Barbara SEM ACENTO)".
- **Nome completo vs primeiro**: "Fernanda Lira" 0 / "Lira" acha.
- **Apelido/grafia**: "Jorge Juniot → quer que eu tente Junior ou só Jorge?".
- **Telefone**: "não achei nenhum contato com ESSE NÚMERO" (normalização BR/US).

## As 2 partes do fix (validadas pela evidência)
1. **Herança de contexto de contato** — proativos (task/appointment/followup) carregam `contact_id`; persistir um "contato ativo da conversa" (+ tool results de search/create no chat) e injetar no prompt cacheado → bot herda sem re-buscar.
2. **Motor de busca inteligente** — resolver fuzzy (trigram + unaccent + apelido + telefone por sufixo) ranqueado por recência de atividade, com **score**: ≥~90% auto-confirma inline ("Quer marcar com Fernanda Lira?"), ambíguo → `present_options`, "não achei" só como último recurso real. SEM reabrir a alucinação de contact_id (re-valida a pista, não inventa).
