# Plataforma Modular de Agentes — PLANO (fonte da verdade)
### FORGE-3 · 2026-05-24 · 🤖 Claude · 👤 Pedro · 🤝 Híbrido

> Reestruturação grande: SparkBot vira **incluso/grátis**; Venda, Recrutamento e
> **Custom agents** viram **upsell pago**, montados a partir de **módulos** que
> se encaixam. Venda/recrut atuais viram **templates**. Decidido com Pedro
> 2026-05-24 numa rodada de discovery. Migração é segura: **nenhum cliente usa
> as IAs lead-facing em prod hoje** (só SparkBot); piloto = **Alves Cury Financial**.

---

## 1. Decisões travadas (Pedro, 2026-05-24)

| # | Decisão | Valor |
|---|---------|-------|
| D1 | **Motor** | Único, = o do SparkBot (loop rico, tools Claude-callable, confirmation gate). Venda/recrut/custom migram pra ele. |
| D2 | **Eixo audiência** | `rep-facing` (SparkBot, incluso) × `lead-facing` (venda/recrut/custom, pago). Vira dimensão de 1ª classe (guardrails, tools e objetivo diferem). |
| D3 | **Conexão** | Cada agente lead-facing vive numa **sub-account** com canal próprio (Stevo/WhatsApp, IG DM, +). SparkBot só fala com **rep/user**. |
| D4 | **Provisioning** | Você/agência provisiona sub-account + canal **antes**; cliente só **compõe** o agente (tipo + módulos). |
| D5 | **Canais** | **Multicanal desde o V1** → camada de canal; motor agnóstico (WhatsApp ligado primeiro, IG DM/outros em ondas). |
| D6 | **Entitlement** | **Liberação manual (admin) agora**; self-serve (Stripe/GHL) fase 4. |
| D7 | **Onboarding** | **Wizard guiado** (tipo → conexão → módulos) primeiro; **IA-builder** conversacional depois. |
| D8 | **Anatomia do módulo** | bundle **versionado** `{ prompt_fragment + allowed_tools[] + settings_schema + guardrails }`. Catálogo **curado pela agência** (cliente não cria módulo no V1). |
| D9 | **Não-limitar + mudança em massa** | custom = instância de template sobre o **motor completo**; módulos = toggles + **override livre**; mass change = editar **módulo/template base versionado** e agentes **herdam** (com opção de fixar versão). Sem sandbox. |
| D10 | **Templates** | Venda + Recrut = 2 templates seed; no V1 **só a agência cria/edita template**; cliente **clona/adapta a instância**. Salvar template próprio = fase 4. |
| D11 | **Agente temporário** | `expires_at` opcional → na data **pausa sozinho** (não deleta; conexão preservada pra reativar). |
| D12 | **"Arquivos MD"** | = comportamento/prompt que hoje vive em TS (`prompt-builder.ts`, `sales-prompt-builder.ts`, `behavior-blocks.ts`) + `agent_configs` JSONB → extrair pra **módulos versionados**. (Confirmar com Pedro se ele quis dizer outra coisa.) |

**Aberto (não-bloqueante, default assumido):** catálogo final de módulos (seed abaixo, extensível). Pedro pode adicionar.

---

## 2. Estado atual (do discovery)

- **3 tipos** em `agents.type`: `account_assistant` (SparkBot, rep-facing), `sales_agent`, `recruitment_agent` (lead-facing). `UNIQUE(location_id, type)`.
- **Dois motores hoje:** SparkBot = webhook síncrono + **88 tools** + Claude (`src/lib/account-assistant/`). Venda/recrut = fila (`message_queue` + cron) + **~8 ações fixas** (`action-executor.ts`) + OpenAI (`src/lib/queue/` + `src/lib/ai/`).
- **Sem controle de acesso** hoje (qualquer user cria qualquer agente).
- **Billing** por-location (wallet GHL, markup 10%, cap mensal) via `usage_records`.
- **Sem `.md` em runtime** — comportamento em TS + DB.

---

## 3. Arquitetura alvo (camada modular)

```
Template (seed/curado)  →  Agente (instância numa sub-account)
                              ├─ audience: rep | lead
                              ├─ módulos ligados (composição + settings + override)
                              └─ canal (WhatsApp/Stevo, IG DM, …)
        Motor unificado: assembler de prompt + resolver de tools + loop + canal
        Entitlement: (location, capability) liberado manual/compra
```

**Peças novas (DB):**
- `agent_templates` — base versionada por audiência (seed: sales, recruitment).
- `agent_modules` — catálogo curado. `{ prompt_fragment, allowed_tools[], settings_schema, guardrails, audience_scope }`, versionado.
- `agent_module_instances` — composição por agente (módulos ligados + settings + override + ordem).
- `agent_entitlements` — `(location_id, capability)` → granted_by/at, source(manual|purchase), expires_at, status.
- `agents` ganha: `audience`, `template_key`, `expires_at`.

**Peças novas (código):**
- **Prompt assembler** — system prompt = template base + fragmentos dos módulos ligados (ordenados) + override do agente. O prompt do SparkBot vira o template `rep-facing` decomposto.
- **Tool resolver** — tools = união das `allowed_tools` dos módulos ligados, filtrada por audiência + entitlement.
- **Camada de canal** — normaliza inbound/outbound (WhatsApp→IG→…) e roteia mensagem → sub-account → agente.
- **Registry de módulos (código) + catálogo (DB):** definição do módulo (fragment/tools) mora em **registry TS versionado** (type-safe, mass-change via deploy); o DB guarda o catálogo (pra UI listar/compor), settings por-agente e **override de fragment opcional** (edição sem deploy). Runtime: usa fragment do DB se setado, senão o do registry por `key`.

**Catálogo de módulos seed (D8 — extensível):**
`behavior` (comportamento/naturalidade), `active_hours` (janela de tempo), `followup`, `qualification` (data fields), `scheduling` (agendamento), `compliance` (anti-spam/opt-out, lead-facing), `channel` (WhatsApp/IG/…), `crm_ops` (notes/tasks/tags/opps), `knowledge` (carrier/empresa KB).

---

## 4. Fases (responsável + critério de saída)

### Fase 0 — Fundações 🤖 (ESTA)
- Schema aditivo (templates/módulos/instâncias/entitlements + `audience`/`expires_at` em agents) + backfill audience + seed entitlement dos agentes lead ativos (Alves Cury).
- Tipos + repositório.
- **Gate de entitlement** flag-gated (`AGENT_ENTITLEMENTS_ENFORCED`, default OFF / log-first): SparkBot sempre liberado; lead-facing exige entitlement ativo OU admin.
- Liberação manual via script (UI admin = Fase 3).
- Testes do gate.
- **Saída:** 🤖 migração aplicada + tsc/build verde + teste do gate passa; 🤖 SparkBot intocado (zero mudança de comportamento).

### Fase 1 — Motor unificado (rep-facing primeiro) 🤖 — BASE PRONTA (2026-05-24)
- ✅ Assembler (`assembler.ts`) + flag `AGENT_MOTOR_UNIFIED` (default OFF) + harness de paridade (`test-motor-parity.ts`, 7/7). SparkBot roda pelo motor (delega) com output idêntico.
- ✅ 4 módulos decompostos (seções CONTÍGUAS do prompt): `behavior`, `scheduling`, `channel`, `knowledge` em `modules/*.ts` + `registry.ts`. Builder faz spread (fonte única, parity-guarded).
- ⚠️ **Limite da decomposição verbatim atingido**: as seções restantes do prompt do SparkBot ou são NÃO-contíguas (um módulo está espalhado em vários pontos → extrair exigiria REORDENAR o prompt, que muda a ordem = risco de comportamento → precisa eval supervisionado, NÃO fazer no automático) ou são COMPUTADAS (`buildTonesSection`/`buildMemorySection`/conversational/guided — já são funções encapsuladas). O tool-resolver ainda não foi construído (SparkBot usa o registry completo hoje; lead-facing precisará de subset — Fase 2).
- **Saída:** 🤖 paridade 7/7 + tsc/build verdes ✅. 🤝 diff de paridade ao vivo em N conversas reais antes de ligar `AGENT_MOTOR_UNIFIED` (pendente — supervisionado).

### Fase 2 — Lead-facing + multicanal 🤖 — QUASE PRONTA (2026-05-24)
- ✅ Venda/recrut entram no motor (assembler delega → paridade 5/5 `test-sales-parity.ts`); `queue-processor` roteia atrás da flag `AGENT_MOTOR_UNIFIED`. Módulo `bulk` no catálogo (00076).
- ✅ **Composição a partir dos módulos** (`assembleLeadFromModules`): custom lead-facing monta o prompt do subset/ordem de módulos que ligou; reusa as section functions do sales builder via `LEAD_MODULE_FRAGMENTS`. `test-lead-compose.ts` 9/9. (Sem paridade — custom = novo.) Esta é a peça que habilita custom agents (ponte pra Fase 3).
- ⏳ Falta (precisa da integração AO VIVO — Pedro): **IG DM inbound** (outbound já suporta o enum IG; inbound de evento IG precisa da conexão real conectada pra wirar+testar); módulo `compliance` lead-facing dedicado (conteúdo); validar piloto Alves Cury; retirar pipeline antigo (fila).
- **Saída:** 👤 piloto Alves Cury validado ao vivo; 🤖 composição a partir do registry ✅.

### Fase 3 — Custom agents + onboarding 🤖🤝
- Wizard (tipo → conexão → módulos) · clonar template → instância · ciclo de vida do temporário · UI admin de entitlement.
- **Saída:** 👤 Pedro cria um custom agent de evento ponta-a-ponta pela UI.

### Fase 4 — Escala comercial 🤝👤
- Self-serve (Stripe/GHL) + IA-builder conversacional.

---

## 5. Riscos & mitigação
| Risco | Mitigação | Resp |
|---|---|---|
| Quebrar SparkBot ao decompor prompt | Fase 1 atrás de flag + teste de paridade antes de cortar | 🤖 |
| Gate de entitlement travar criação legítima | flag OFF/log-first + seed dos ativos + SparkBot sempre liberado | 🤖 |
| Multicanal inflar escopo | abstração desde já, canais ligados em ondas (WhatsApp 1º) | 🤖 |
| Migração lead-facing | risco ≈ 0 (sem uso em prod); validar no Alves Cury | 🤝 |

## 6. Rollback
Tudo aditivo. Reverter = reverter commit + (se preciso) `DROP` das tabelas novas. SparkBot e pipeline atual intocados até a flag de paridade ligar.
