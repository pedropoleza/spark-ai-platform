# REVIEW — Coerência da lógica do sistema (Plataforma Modular)

> Pedro 2026-05-25: "revisão geral da lógica — tem que ter sentido, um caminho, um guia, tudo redondo. Acha o que não está claro ou confuso." Foco: config, ferramentas (ex. disparo em massa), modelo rep×lead.
> Auditoria feita lendo o runtime real (webhook inbound, queue-processor, prompt builders, tools, catálogo de módulos), não só a UI nova.

---

## TL;DR — os 3 problemas que mais pesam

1. **🔴 Agente Custom criado pela IA não roda.** O builder cria `custom_agent`, mas TODO o runtime de lead (roteamento de inbound, opt-out, handoff, prompt builder) só conhece `sales_agent`/`recruitment_agent`. Custom nasce **morto**: nunca recebe nem responde mensagem. O motor unificado que trataria custom está atrás de flag OFF. → **bloqueia o cutover** (entregaríamos um builder que faz agentes que não funcionam).
2. **🔴 "Disparo em massa" como capacidade do agente é uma miragem** (sua intuição estava certa). O módulo `bulk` é tagueado lead-facing, mas todo o sistema de bulk é **ferramenta do SparkBot (rep)** — o rep manda o SparkBot disparar. Um agente de lead com "Disparo em massa" ligado **não dispara nada**. E o conceito certo (agente que **inicia conversa**) não existe.
3. **🟠 A config mistura mundos rep e lead.** Vários campos que mostro pra um agente de lead só fazem sentido pro SparkBot (e vice-versa). O usuário mexe em coisa que não faz nada.

---

## 1. Modelo rep × lead — como REALMENTE funciona hoje

| | **SparkBot (rep)** | **Agentes de lead (venda/recrut)** |
|---|---|---|
| Fala com | o operador (você) | os leads/clientes |
| Motor | `webhook-handler` → `processor` (direto) | `message_queue` + `queue-processor` (assíncrono) |
| Inicia conversa? | **Sim** (proativos, lembretes, bulk) | **Não** — só responde inbound |
| Roteamento | `isSparkbotHub(location)` | targeting_rules (tag/campo/stage) + canal + working_hours |
| Follow-up | `followup_sequences` (rep monta sequência) | `follow_up_config` (no queue-processor) |
| Bulk | ferramenta do rep (`bulk-messages-v2`) | **não existe** |

**Custom** deveria ser lead-facing, mas **não está em lugar nenhum do runtime de lead** (ver 🔴 #1).

---

## 2. Inconsistências críticas (quebram a lógica)

### C1 🔴 — `custom_agent` sem runtime
- `inbound-message/route.ts` roteia inbound só pra `["sales_agent","recruitment_agent"]` (linhas do `.in("type", …)` em routing, opt-out e handoff). `custom_agent` é ignorado.
- `sales-prompt-builder` monta prompt só pra sales/recruitment. Custom dependeria do `assembleSystemPrompt` (assembler) — que só roda com `AGENT_MOTOR_UNIFIED` ON (hoje OFF).
- **Efeito:** o builder com IA cria um `custom_agent` pausado; mesmo se ativar, ele nunca recebe mensagem nem teria prompt.
- **Conserto (escolher 1):**
  - (a) Adicionar `custom_agent` ao roteamento + ligar o caminho do assembler pra custom (precisa validar 1 conversa real); ou
  - (b) No V1, **custom = sales/recruitment + módulos** (tratar custom como um sales/recruitment "turbinado" no runtime), até o motor unificado estar validado.
- **É bloqueante pro cutover.**

### C2 🔴 — "Disparo em massa" é do rep, não do agente
- Catálogo: módulo `bulk` = `audience_scope='lead'` (00076). Realidade: `bulk-messages-v2/bulk-management/bulk-runner` vivem em `account-assistant/tools` (SparkBot) — o **rep** dispara, não o agente.
- O bulk atual é **broadcast one-shot** (N filtros × N templates, com disclaimer + pacing). Não é "agente puxando conversa".
- **Efeito:** ligar "Disparo em massa" num agente de lead não faz nada. Conceito confuso.
- **Conserto:** ver Seção 5 (repensar como "Prospecção / iniciar conversa" — sua proposta).

---

## 3. Incoerências de modelo (confundem o usuário na config)

### M1 🟠 — Campos rep aparecem em agente lead (e vice-versa)
Hoje a config mostra quase os mesmos campos pra todo agente. Mas:
- **Só fazem sentido pro SparkBot (rep):** `confirmation_mode` (gate de confirmação), `daily_proactive_limit`, `quiet_hours`, `no_response_threshold` (silêncio de proativo), `allowed_ghl_users`. Num agente de venda, não rodam.
- **Só fazem sentido pro lead:** `qualification`/data_fields, `objective`, `post_booking`, `follow_up_config`, `targeting_rules`, `deactivation_rules`, `handoff_messages`.
- **Efeito:** o usuário ajusta "Limites & Avisos → proativos por dia" num agente de venda achando que limita algo — não limita.
- **Conserto:** a config já está "ciente de módulos" (fase recente); falta ficar **ciente de audiência no nível de CAMPO** — só mostrar o que roda pra aquele tipo. Ex: "Limites & Avisos" do lead = volume + opt-out + LGPD; do SparkBot = proativos/dia + quiet hours + silêncio.

### M2 🟡 — Dois "follow-ups" com o mesmo nome
- `follow_up_config` (lead, roda no queue-processor) **≠** `followup_sequences` (SparkBot, sistema F1-F14 que o rep monta por contato). Mesma palavra, dois mecanismos diferentes. Decidir a nomenclatura (ex.: lead = "Retomada automática"; rep = "Sequências de follow-up").

### M3 🟡 — Canais: SMS↔WhatsApp
- `enabled_channels` guarda `"SMS"/"WhatsApp"/"Instagram"`; a UI mostra WhatsApp/IG; `ASSISTANT_OUTBOUND_CHANNEL=SMS` roteia SMS→WhatsApp (Stevo). Funciona, mas o "SMS" no banco vs "WhatsApp" na tela pode confundir quem debugar. Padronizar a leitura.

### M4 🟡 — "O que faz" (módulos) vs flags de config
- Resolvido em parte (toggle único). Mas pra `qualification`/`scheduling`/`knowledge` o "ligado/desligado" é só a composição modular — o runtime legado (sales-prompt-builder) usa os dados (data_fields/calendar/kbs) **independente** do módulo estar on/off enquanto `AGENT_MOTOR_UNIFIED` estiver OFF. Ou seja: desligar "Qualificação" no card **não para** a qualificação no runtime atual. Incoerência entre o que o toggle promete e o que acontece.

---

## 4. Lacunas de fluxo / guia (o "caminho")

- **G1 🟠 Sem onboarding/guia.** O usuário entra no Hub e cai numa config densa sem um "comece por aqui". Falta um caminho: criar agente → revisar 3 coisas essenciais → testar → ativar. (O builder com IA é ótimo pro custom; venda/recrut caem direto na config sem direção.)
- **G2 🟡 Provisionamento de canal** aparece como "provisionado pela agência" sem dizer COMO conectar. O usuário não-tech fica sem ação.
- **G3 🟡 Estados de erro/vazio** existem, mas não há um "health" do agente ("falta conectar canal", "sem perguntas de qualificação", "pausado há X dias").

---

## 5. ★ Disparo em massa repensado (sua proposta) — "Prospecção / Iniciar conversa"

**Problema:** hoje "bulk" = broadcast one-shot do rep. Você quer: **o AGENTE inicia conversas** com uma lista (por tag), no ritmo certo, e depois **conduz** a conversa (não é só uma mensagem).

**Modelo proposto (módulo lead `outreach`, substitui/renomeia o `bulk` lead):**

1. **Quem inicia?** — toggle no agente: `só responde` × `também inicia conversas` (proativo). Default: só responde.
2. **Lista por tag (Filter Engine, que já existe):**
   - filtro de **1+ tags** (AND/OR) — reusa o FEL (`get_contacts_filtered`).
   - opcional: + estágio de pipeline / campo (o FEL já suporta).
3. **Ritmo & horário (pra ficar redondo):**
   - msgs por hora / por dia (cap),
   - respeita o **working_hours** do agente,
   - espalha no tempo (não dispara tudo de uma vez — reusa o `bulk-message-runner` pacing),
   - 1ª mensagem = abertura definida (ou a IA gera baseada no propósito),
   - dedup (não reabordar quem já está em conversa ativa / opt-out).
4. **Depois de iniciar:** a resposta do lead entra no **fluxo normal do agente** (qualifica, agenda, etc.) — é conversa, não broadcast.

**Reuso:** Filter Engine (tags) + bulk-runner (pacing/throttle) + motor de conversa do lead. O que falta é o **disparo da 1ª mensagem pelo agente** + marcar o `conversation_state` como "iniciada pelo agente" pra o inbound subsequente rotear pra ele.

**Distinção que tem que ficar clara na UI:**
- **SparkBot → "Disparo em massa"** = você (rep) manda o assistente disparar um aviso/campanha pra uma lista (one-shot).
- **Agente de lead → "Prospecção"** = o agente puxa conversa com uma lista e conduz. (Dois nomes, dois conceitos.)

---

## 6. Ordem recomendada (antes do cutover)

| # | Ação | Por quê |
|---|------|---------|
| 1 | **Resolver custom_agent runtime** (C1) | senão o builder entrega agente morto — bloqueante |
| 2 | **Separar config por audiência no nível de campo** (M1) | tira a confusão "mexo e não faz nada" |
| 3 | **Renomear/realinhar bulk** (C2/§5): rep="Disparo", lead="Prospecção" (mesmo que Prospecção entre como "em breve" no V1) | conceito redondo |
| 4 | **Coerência toggle↔runtime** (M4): ou liga `AGENT_MOTOR_UNIFIED`, ou deixa claro que alguns toggles são "composição" e não "liga/desliga runtime" | o toggle tem que dizer a verdade |
| 5 | Guia/onboarding leve (G1) + health do agente (G3) | dá o "caminho" |
| 6 | Nomenclatura follow-up (M2) + canal SMS/WhatsApp (M3) | polimento |

**Cutover (Fase I) só depois de #1** — é o que garante que o que o usuário cria realmente funciona.

---

## 8. Plano de implementação (Pedro 2026-05-26: "faz todos, manda bala")

Ordem de execução (commit por item, tsc+build verde em cada, teste no fim):

- **P0 — Canais (clarificação).** Modelo de 3 canais: **WhatsApp Web/SMS** (Stevo, "SMS custom provider" → valor DB `SMS`), **WhatsApp API** (Meta → valor DB `WhatsApp`), **Instagram** (`Instagram`). UI mostra os 3 rótulos amigáveis; config de canais vira editável (enabled_channels). Sem mudar o runtime de roteamento (só rótulos + edição).
- **P1 — custom_agent runtime (BLOQUEANTE).** Adicionar `custom_agent` ao roteamento de inbound (webhook), opt-out, handoff e ao caminho de prompt. No queue-processor, custom monta prompt via `assembleSystemPrompt` (caminho custom do assembler) sem depender da flag global — gate local por tipo. Custom passa a receber/responder.
- **P2 — Config ciente de audiência (campo a campo).** Helper `fieldAppliesTo(field, audience)`. Lead vê: qualificação/objetivo/agendamento/follow-up/targeting. SparkBot vê: confirmação/proativos-dia/quiet-hours/silêncio. Esconder o que não roda pro tipo.
- **P3 — Prospecção (agente inicia conversa).** Módulo `outreach` (lead). Config: quem inicia (só responde × inicia) + filtro de tags (FEL) + ritmo (msgs/hora, cap/dia, respeita working_hours, espalha). Backend: cron que seleciona contatos por tag, dispara 1ª mensagem (pacing via padrão do bulk-runner), cria conversation_state "iniciada pelo agente". Renomear bulk: rep="Disparo", lead="Prospecção".
- **P4 — Coerência toggle↔runtime + nomenclatura.** Toggle de módulo reflete o que roda; follow-up lead="Retomada automática" × rep="Sequências".
- **P5 — Guia + health do agente.** "Comece por aqui" + indicadores (sem canal, sem perguntas, pausado).

Flags de segurança: tudo atrás do preview gate; custom runtime testado com 1 conversa real antes de soltar; prospecção nasce desligada (opt-in).

### Status (2026-05-26)
- ✅ **P0 canais** (350485b) — 3 tipos + config editável.
- ✅ **P1 custom_agent runtime** (350485b) — roteia/responde/testa no caminho de lead provado.
- ✅ **P2 config por audiência** (66b0bbd) — campos rep/lead separados.
- ✅ **P3 Prospecção (config + modelo)** (8aaa20d) — coluna outreach_config, módulo `outreach` (lead), `bulk`→rep, categoria "Prospecção" com a estrutura do Pedro (tag → ritmo → horário → abertura), opt-in.
- ⏳ **P3 Prospecção (dispatcher)** — cron que seleciona contatos por tag, dispara a 1ª mensagem com pacing e cria conversation_state "iniciada pelo agente". É um SENDER → go-live supervisionado (padrão do repo: gated por `OUTREACH_ENABLED` + teste supervisionado antes de soltar). **Próximo passo dedicado.** Reusa: FEL `executeContactsFilter` (tags), `/conversations/messages` (envio canal-aware), conversation_state (dedup/roteamento da resposta), pacing do bulk-runner.
- ⏳ **P4 nomenclatura** — sem colisão real na UI do /hub (lead "Follow-up" é o único exposto; `followup_sequences` do SparkBot não aparece lá). Vira nota de doc, não mudança de UI.
- ⏳ **P5 guia + health do agente** — polimento (comece-por-aqui + indicadores). Não-bloqueante.

---

## 7. O que JÁ está coerente (não mexer)
- Roteamento sales/recruitment por targeting + canal + working_hours + debounce: sólido.
- `follow_up_config`, `data_fields`, tons, instruções, objective, post_booking, working_hours: **rodam de verdade** pra venda/recrutamento (queue-processor + sales-prompt-builder).
- Entitlement gate (flag-aware) + Acessos (admin) + billing (uso real): coerentes.
- SparkBot: proativos, bulk, follow-up sequences, confirmation gate — maduro e funcionando.
