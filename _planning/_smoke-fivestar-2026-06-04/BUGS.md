# Smoke test Five Star Ricos — log de bugs (2026-06-04)

Conta: `jA6uzx6tONyTeocxw4Cj` (Five Star Ricos) · Agente de Vendas `7c0a72b7-e37c-463d-be56-73b7822a3037`
Contato de teste: +1 786 771 7077 (Pedro) · tag `smoke-test-ia` · targeting isolado.

Sessão de caça-bug disparada por um smoke test real. Achou **7 bugs** — vários
que NUNCA funcionaram em prod e passavam batido (sem Signal, sem Sentry).

| ID | Bug | Tipo | Causa raiz | Status | Commit |
|----|-----|------|-----------|--------|--------|
| F42 | Custom Menu Link tela branca | infra/UI | loop redirect /dashboard↔/hub (cutover pela metade) | ✅ deploy | `67b3c46` |
| F42.B | SSO 400 company_id vazio | infra | GHL menu link não manda company_id; schema exigia | ✅ deploy | `4ccaa0a` |
| F43 | Test chat travava 130s | sistema | free-slots do GHL pendurava sem timeout no GHLClient | ✅ deploy | `b14504d` |
| F45 | "Desculpa, tive um problema técnico" | prompt+sistema | override do cliente manda #Correto/`should_send_message` não-JSON → parse falha → genérica. Retry 1x antes da genérica | ✅ deploy | `1ab673e` |
| F46 | **Follow-up NUNCA enviou (3 semanas)** | sistema/DB | trigger `touch_updated_at` em `scheduled_followups` SEM coluna `updated_at` → todo UPDATE explode → runner retorna 0 silenciosamente. 86 follow-ups travados | ✅ deploy | `a46b3a5` (migration 00097) |
| F48 | Agente MENTIA sobre horários | sistema | `slots.slice(0,8)` truncava cada dia → só via até 3:30 PM com calendário até 23h | ✅ deploy | `1513f29` |
| F50 | Áudio manual não cai no gate de handoff | sistema | detecção de humano atrás do gate `missing_fields` (exige conteúdo) | ✅ deploy | `cea3cd3` |

## Bug central NÃO resolvível por código sozinho

**auto_pause_on_human_message NUNCA funcionou** (0 pausas `auto_pause:human_message`
em toda a história do banco). Vive no branch `direction==="outbound"` do webhook
`/api/webhooks/inbound-message`, que **nunca recebe dados**: o app do GHL
Marketplace **não assina o evento `OutboundMessage`** (docs só citam `InboundMessage`;
0 samples outbound; 0 pausas).

- **F50 (código, ✅):** removeu o gate `missing_fields` do caminho outbound (áudio
  manual agora chegaria à lógica). Deixa o código PRONTO.
- **F51 (👤 Pedro, GHL Dev Portal):** ASSINAR o webhook `OutboundMessage` no app do
  Marketplace. Sem isso, nenhum fix de código faz a pausa disparar.
- **F52 (código, opcional/robusto):** detectar "humano assumiu" lendo o histórico
  da conversa no queue-processor (funciona SEM depender do webhook outbound;
  pausa reativa quando o lead responde de novo). Mudança no hot path → merece
  implementação + teste dedicados, não hotfix ao vivo.

## Observabilidade (F49) — por que tudo isso passou batido

Nenhum desses bugs gerou **admin_signal** nem **Sentry** — todos falham de forma
NÃO-throwing (tratados / engolidos pelo supabase-js `{error}`). Por isso rodaram
semanas sem detecção. F49 propõe: parse_failed → signal; follow-up runner → checar
`result.error` em vez de engolir; capturar no Sentry.

## Follow-ups rastreados
- **F47** — follow-up-scheduler cria sequência nova a cada turno sem cancelar a
  anterior (80 follow-ups/contato após 8 turnos). Dedup por (agent_id, contact_id).
- **F49** — observabilidade de falhas silenciosas (acima).
- **F51** — assinar OutboundMessage webhook (Pedro).
- **F52** — fallback de handoff por histórico (opcional).

## Restaurar pós-teste (pendente)
- `agent_configs` do agente 7c0a72b7: targeting voltar de `tag:smoke-test-ia` pra
  `custom_field ai_status=Active` (original salvo na task #188). Modelo: Pedro
  optou por manter Sonnet (`claude-sonnet-4-6`) — não reverter.
- Remover tag `smoke-test-ia` do contato `1sfbr5EiFJ8jvoGxE2nO`.
