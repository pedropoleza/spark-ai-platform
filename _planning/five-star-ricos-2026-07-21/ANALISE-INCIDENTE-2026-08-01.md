# Five Star Ricos — Incidente 2026-08-01 (queixas Roberta/Marcia no grupo)

> Análise a pedido do Pedro 2026-08-01. Fonte: prints do "Grupo Suporte Spark - Marcia" (grupo NÃO sincronizou no OS — ver §4) + forense nos 2 bancos (AI Agent Hub `vyfkpd…` + Sparkleads OS `nsqwgj…`).
> Estado da conta: **agente de vendas DESATIVADO às 21:33 UTC de 01/08** (pedido da Marcia 16:14 ET "desativa a IA pra mim"). Sem sangramento ativo.

## Timeline do dia (UTC)

| Hora | Evento |
|---|---|
| 08:35–09:34 | Caso Adriana Cruz (+15089330382): booking OK → erro falso 2× (§2) |
| 13:45–17:40 | **Wallet bloqueada de novo** — 22 `wallet_blocked_skip` |
| 17:50:02 | Flush em massa da fila (recovery) → IA responde lote de msgs velhas (respostas "10-15 min depois" dos prints) |
| 18:09 (14:09 ET) | Roberta lista os números no grupo |
| 20:14 ET→? | Marcia: "desativa a IA" |
| 21:33 | Agente `status='inactive'` |

## 1. "IA manda explicação logo depois do welcome, cliente nem falou nada"

**Mecânica provada** (ex.: +14845445596, 01:04–01:06; +18574689491, 17:38–17:56):
1. Lead clica no anúncio (IG/FB) → WhatsApp entrega o **texto pré-preenchido do anúncio** ("Quero entender como funciona o seguro com benefício em vida.") — o lead não digitou nada. O OS anota como `📢 Veio de anúncio (…)` no message_queue.
2. Workflow do GHL manda welcome (texto + áudio + bloco 💰 pedindo dados).
3. A IA processa a msg do anúncio (delay MC-3 de 120s) e **responde a pergunta do anúncio do zero**: re-explica o produto E re-pede os dados — 25s depois do bloco da equipe (caso 484) ou 16 min depois (caso 857, atrasada pela wallet).

**Por que a IA não sabe do welcome:** `lead_history_config.enabled=false` → o histórico do turno é só inbound + as próprias respostas da IA. **As mensagens do workflow nunca entram no contexto.** E `allow_silent_turns=false` (MC-9 off) → o motor obriga a responder algo em todo turno.

**Volume**: 15–27 leads de anúncio/dia — todos levam a duplicação.

**Rastreio de código (origin/main = prod; a branch local `fix/3-frentes-onda0-1` está ATRÁS e não tem H58/MC-*):**
- A msg `📢 Veio de anúncio…` é composta no **spark-os** (`src/lib/wa/inbound.ts:1034-1041`, toggle `ctwa_tag_enabled` default ON; aplica tags `ctwa-lead`/`anuncio`/`anuncio-{app}`) e chega no AI platform como inbound comum.
- **Nenhum gate cobre**: MC-3 (+120s) trabalha CONTRA (foi feito pra garantir resposta a lead de anúncio); F52/takeover classifica welcome de workflow como não-humano de propósito; should-respond exige `handoff_policy.enabled`.
- **REGRESSÃO descoberta**: silêncio por flag está MORTO em prod — `parseAIResponse` hardcoda `should_send_message: true` (`openai-client.ts:744`), contradizendo o docstring MC-9 (713-720). Único sinal funcional = marcador `[[NAO_ENVIAR]]` no texto. E o override `lead_question` do MC-9 casa `?` de URL (`lead-silence.ts:70`) — a URL do anúncio forçaria resposta mesmo com gate ON.

**Fix (escada):**
- (a) **Só-config, hoje**: regra no override — "mensagem começa com 📢 Veio de anúncio → equipe já mandou boas-vindas automáticas; NÃO se apresentar/explicar/re-pedir dados; no máximo 1 linha de acolhimento". Resolve ~80% sem deploy.
- (b) **Config+deploy pequeno**: ligar `allow_silent_turns=true` + ensinar `[[NAO_ENVIAR]]` no contexto de anúncio; exige 2 micro-fixes: (i) restaurar pass-through do flag em `openai-client.ts:744`; (ii) strippar URLs antes do `includes("?")` em `lead-silence.ts:70`.
- (c) **Determinístico (fecha de vez)**: na agregação do grupo (`queue-processor.ts:185-228`), regex `^\s*📢\s*Veio de anúncio` como único conteúdo → skip do turno com audit `ad_context_skip` (ou body sintético "responda 1 linha/silêncio"), gateado por config por-agente.
- Complemento: ligar `lead_history_config.enabled=true` (bot passa a ver o welcome do workflow no histórico).

## 2. "Agendou e no mesmo minuto disse que o horário não está disponível" (Adriana Cruz)

**Mecânica provada no execution_log:**
- 09:03:48 lead: "terça as 4" · 09:04:19 lead: 2ª msg em rajada (31s > debounce de 20s → turno separado)
- 09:04:20 turno 1: `book_appointment` **success** (8/4 16:00, appt `a8Y8uhOSQsVhWo80perR`) + "Terça às 4 PM confirmado!"
- 09:04:49 turno 2: LLM **re-emite** `book_appointment` pro MESMO horário → guard H58 bloqueia ("start_time nao esta na lista de 40 horarios reais…" — o slot sumiu porque o turno 1 acabou de ocupá-lo) → executor manda a msg fixa **"Desculpa, nao consegui agendar nesse horario"** ([action-executor.ts:156](../../src/lib/ai/action-executor.ts)).
- 09:33 repete o padrão no reagendamento pra 17:00 (sucesso + "5 PM não está disponível" 20s depois).

O agendamento estava lá certinho — a mensagem de erro era falsa. Guard H58 fez o trabalho (impediu duplicata real no calendário), mas o caminho de erro vira contradição.

**Rastreio de código (origin/main):**
- Debounce agrupa só `status='pending'` (`inbound-message/route.ts:905-911`); msg1 já estava `processing` → msg2 vira fila própria. MC-6 (`queue-processor.ts:143-183`) é ADIAMENTO, não fusão — turno separado sempre.
- Turno 2 só "sabe" do booking pelo TEXTO do chat (fetch racy ~15s após o envio); **o appointment nunca é lido pré-LLM** (zero fetch de `/appointments` no queue-processor) e `conversation_state.status='booked'` **não é injetado no prompt**. LLM sem estado determinístico → re-book esperado.
- Guard H58 (`slot-guard.ts:47-73`) compara contra free-slots do turno; o free-slots do GHL **desconta o appointment recém-criado** → "ocupado por ele mesmo" é indistinguível de "indisponível".
- Ironia: `findExistingAppointment` (action-executor.ts:404-421) faria PUT/no-op e salvaria o caso — mas o slotCheck lança na linha 396, ANTES. O throw casa `isBookingConflictError` → hardcoded "Desculpa, nao consegui agendar" (262-278) substitui a resposta inteira e fura até o MC-9.
- Mesmo double-fire se reproduz no reschedule (466-468); agravante: reschedule é delete-then-create (490-502) com delete em try/catch vazio — create falhar após delete = reunião some.

**Fix mínimo (código):** no `!slotCheck.ok` (book 396-398 e reschedule 466-468), ANTES de lançar: `findExistingAppointment`; se existir e `|start_time − existente| < 60s` → **sucesso idempotente** (log `book_appointment_idempotent`, sem throw, sem mensagem de erro). 1 fetch extra só no caminho que já falha; zero mudança no caminho feliz. Complementos: injetar estado `booked` no prompt + regra "nunca re-chamar book_appointment se já agendado".

## 3. "Nome do cliente volta sozinho pro nome do WhatsApp" — CONFIRMADO (spark-os)

**Toda mensagem inbound do lead re-envia o `pushName` do WhatsApp pro GHL** via `POST /contacts/upsert` (casa por telefone = UPDATE) → sobrescreve o nome que a equipe editou no CRM. Não é cron; é o próprio inbound — "depois de um tempo volta" = na próxima mensagem do lead.

- Gate errado: `spark-os/src/lib/wa/inbound.ts:1005-1009` — só checa `cfg.create_contacts`; nome vai SEMPRE.
- `upsertContact` manda `name` sem probe de existência: `spark-os/src/lib/wa/ghl.ts:60-84`.
- **Fix mínimo**: condicionar o `name` a "contato novo" — o padrão já existe no MESMO arquivo pro avatar (`if (contactIsNew)`, inbound.ts:1118); ou usar `hasPriorMessages` (já chamado 20 linhas abaixo) / `searchContactByPhone` antes.
- Mesmo bug no inbox interno do OS (tabela própria): `spark-os/src/lib/stevo/webhooks.ts:549-554` (`contacts.update({full_name: pushName})` em contato existente).

## 4. Grupo "Suporte Spark - Marcia" não sincroniza no OS

Três camadas (todas confirmadas no código):
1. **Sessão morta**: o número pessoal do Pedro (+1 786 771-7077, sessão `3d9d42c8`) está `disconnected` / `ban-signal:loggedout`. Última msg recebida 28/07 02:06 UTC. Sessão deslogada não recebe NADA.
2. **Grupo é opt-in**: mesmo com sessão viva, mensagem de grupo é descartada antes de gravar se o grupo não estiver `enabled` em `wa_groups` (default false; `groups_auto_enable` default false) — `spark-os/src/lib/wa/inbound.ts:645-665`. O grupo da Marcia nem existe em `wa_groups`.
3. **Silêncio por decisão operacional**: a sessão foi **mutada em 31/07** de propósito (limpeza pós-flood de alertas, `_planning/WA_AVISOS_OPERACAO.md` §7-8) → o cron `wa-alert-eval` filtra `muted` e nunca alertou. Além disso `wa-number-down:*` é client-facing → skip no time, e `WA_ALERT_DELIVERY_ENABLED` foi removida da Vercel em 31/07 (caso Raquel). Ou seja: sessão morta é invisível **por design atual**.

**Fix (👤 operacional):** re-parear a sessão do Pedro (QR) OU mover o grupo pra sessão do inbox de suporte; depois habilitar o grupo em `wa_groups` (sync/enable no portal). Decisão pendente: como reintroduzir alerta de sessão interna caída sem voltar o flood (ex.: Discord-only com `WA_ALERT_DISCORD_WEBHOOK`, que hoje está vazia).

## 5. Wallet — problema recorrente da conta

3º episódio (28/07 teve 40h; hoje 13:45–17:40 UTC). Recovery funcionou (flush 17:50) mas o efeito colateral são as respostas atrasadas em lote. **Fix definitivo é do lado da cliente**: auto-recharge com threshold > $0 no billing do Spark Leads (pegadinha conhecida: trigger "< $0" trava).

## 6. Estado de configs relevantes (01/08)

- `allow_silent_turns=false` · `lead_history_config.enabled=false` · `handoff_policy.enabled=false` (lead pede humano → ninguém é avisado) · `debounce_seconds=20` · `activation_mode='trigger_once'` (ok, do review 28/07) · follow-up 3 toques/24h (ok, do ajuste 21/07)
- Auto-pause por humano FUNCIONANDO (11 pausas em 36h, `auto_pause:human_message:history`) — equipe trabalha o inbox e a IA sai da frente.

## Plano de correção (proposta, aguardando go do Pedro)

| # | Fix | Onde | Tipo |
|---|-----|------|------|
| F1 | Regra de anúncio no override (não re-explicar; 1 linha) | config `system_prompt_override` | 🤖 config, sem deploy |
| F2 | `lead_history_config.enabled=true` | config | 🤖 config, sem deploy |
| F3 | Idempotência do booking (sucesso silencioso se appt já existe no mesmo horário; book + reschedule) | `action-executor.ts` (AI platform) | 🤖 deploy |
| F4 | Gate determinístico de contexto de anúncio (`ad_context_skip`, por-agente) | `queue-processor.ts` | 🤖 deploy |
| F5 | Restaurar pass-through `should_send_message` + fix `?`-de-URL no MC-9; depois ligar `allow_silent_turns` na Marcia (validar no test chat) | `openai-client.ts:744`, `lead-silence.ts:70` + config | 🤖 deploy + validação |
| F6 | Nome só na criação (pushName não sobrescreve contato existente) + mesmo fix no inbox interno | spark-os `inbound.ts:1005`, `stevo/webhooks.ts:549` | 🤖 deploy (spark-os) |
| F7 | Re-parear sessão do Pedro (QR) ou mover grupo pro número de suporte; habilitar grupo em `wa_groups` | operacional OS | 👤 Pedro |
| F8 | Auto-recharge da wallet com threshold > $0 (billing Spark Leads da conta) | conta da cliente | 👤 Roberta/Marcia (instruir) |
| F9 | Decidir canal de alerta pra sessão interna caída (Discord-only?) sem voltar o flood | ops OS | 👤 decisão Pedro |
| F10 | Reativar o agente da Marcia SÓ depois de F1-F3 no ar + teste | — | 🤝 |

Ordem sugerida: F1+F2 (imediato, config) → F3 (P0 de código) → F6 → F4/F5 → reativar (F10) → F7/F8/F9 em paralelo.

## Execução (2026-08-01/02) + review adversarial

- **F1+F2 aplicados** (override +seção LEAD DE ANÚNCIO; lead_history ON). **F3/F4/F5** implementados em worktree limpa (commits na branch `fix/marcia-incidente-0108`); **F6** no spark-os. Migration 00130 aplicada em prod; `suppress_ad_context_turn=true` na Marcia.
- **Review adversarial (workflow 20 agentes, 5 lentes × refutação): 14 achados confirmados** → rodada v2 aplicada:
  - Ad-gate: skip duro → **transformação** (`ad_context_softened`) — o wrapper CTWA carrega o texto REAL do lead (pre-fill OU digitado); skip engolia pergunta genuína, consumia frase de ativação (trigger_once-por-frase) e tirava o lead do follow-up.
  - Booking: `pickFutureAppointment` prefere o appointment que casa o instante (2+ futuros); reschedule-noop exige `appointment_id` batendo.
  - Silêncio: gate-OFF mantém fallback legado (mudez só opt-in); audit `gate_on` real + `model_silent_fallback`; regex de URL preserva "?" solto.
  - spark-os: name vira **auto-heal** (novo OU sem nome ganha pushName; nome editado intocável) + retry.
- **Pendências novas (do review, pré-existentes, NÃO corrigidas agora):**
  - [ ] **MC-3 dropa a 2ª msg do lead** na janela de 120s (`inbound-message/route.ts:728-733` conta pending sem filtro de status) — lead novo sem tag que digita 2ª mensagem antes do tag do workflow perde a mensagem. Classe própria de fix; tocar com cuidado (rota compartilhada).
  - [ ] **`lead_history` de agente com override só funciona com `LEAD_CACHE_OPTIMIZED=1`** (gap F37: caminho de override não inclui `buildLeadHistorySection`; só entra via runtime-context cacheOptimized). NÃO desligar essa env sem saber que mata a memória do lead da Marcia/afins — o `lead_history_loaded` continuaria logando como se nada.
  - [ ] Silence-gate 8/10 e lead-awareness 35/36 falham em origin/main (pré-existente, não relacionado).
