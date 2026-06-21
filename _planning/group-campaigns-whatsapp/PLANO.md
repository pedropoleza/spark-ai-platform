# Campanhas em GRUPOS de WhatsApp via SparkBot + API Stevo

> Pedro 2026-06-18 (caso Matheus Curty: "postar 2 posts nesses grupos às 7:30am").
> Plano gerado por workflow de design (5 superfícies + síntese adversarial), ancorado
> no código real + probe ao vivo da API Stevo. **Status: aguardando aprovação do Pedro.**

## Visão

Capacidade nova: o rep usa pelo **SparkBot (DM)** e pela **área de Campanhas do /hub** pra
disparar posts em GRUPOS de WhatsApp. Seleciona grupos (lista vinda do Stevo), escreve N
**variações** da mensagem (anti-spam), define horários (ex.: 7:30 e 12:00), e o sistema agenda
com **pacing anti-ban** (intercala grupos, varia conteúdo, espaça envios).

Fica **leve** porque é ~80% **reuso** do motor de campanha que já existe (Bulk V2): mesmas
tabelas, mesmo claim atômico, mesmo cron, mesmo tripé pausa/retoma/cancela. Só entra **1
`delivery_channel` novo** (`whatsapp_group`) e **1 branch de envio** no runner. A fluidez vem de
**UMA multitool** `group_campaign` com `action` discriminado (não 8 tools soltas). **Gate de
Termos Parte 2** (riscos reais de ban) antes de qualquer disparo. Conservador por design:
**Fase 1 só roda em instância Stevo DEDICADA** — nunca sobre o número compartilhado que carrega
o DM de todos os reps.

## Fundação confirmada ao vivo (probe `scripts/probe-stevo-groups.ts`)

- **`GET /group/list`** retorna `{data:[...], message:"success"}` com os grupos do número **e os
  membros embutidos** numa só chamada. Campos: `JID` (`xxx@g.us`), `Name`, `OwnerJID`,
  `Participants` (array), `ParticipantCount`, **`IsAnnounce`** (só admin posta), `IsLocked`, `Topic`.
  (`GET /group/myall` voltou `null` na instância sparkbot.)
- **Envio a grupo**: `POST /send/text {number:"<jid>@g.us", text, formatJid:true, mentionAll?, delay}` —
  o swagger suporta; **ainda não exercitado em prod** → testar antes (Fase 0).
- O número "sparkbot" enxerga só **os grupos dele** (hoje 3: "Comunidade Spark ⚡️" 108 membros,
  "Visionarios" 4, outro 2). → confirma que cada rep precisa do **próprio número/instância** pros
  grupos dele.
- O "GRUPO" (maiúsculo) + JID-como-email é como o **GHL MOSTRA** grupos importados (serve pra
  busca/dedup ao importar membros). A fonte da verdade é a **API Stevo direto**.

## Arquitetura (decisões resolvidas, ancoradas no código)

1. **REUSAR `bulk_message_*`** (NÃO tabelas novas). `bulk-management.ts` (pausa/resume/cancel = o
   "tripé") já opera sobre `bulk_message_jobs.status`; o runner já pula se `status!='running'`.
   Aditivos mínimos: `delivery_channel` CHECK += `'whatsapp_group'` (00050:54); `bulk_message_jobs`
   += `target_type` DEFAULT `'contacts'` + `group_targets` jsonb; `bulk_message_recipients` +=
   `target_jid` + `group_name`.
2. **1 branch no runner** (`bulk-message-runner.ts:716`): `sendToContact()` está hardwired em
   `GHLClient.post('/conversations/messages',{contactId})` — grupo **não é endereçável por
   contactId**. Fix: `if target_type==='groups' → getStevoInstance(location_id) → sendGroupText(JID)`.
   Resto intacto (claim `claim_bulk_recipients` SKIP LOCKED, `isInBlockedHours`, `MAX_PER_TICK=5`,
   counters, reclaim H37). **Opt-out por contato é SKIPADO** pra grupo (optout é por phone, não JID).
3. **Cliente Stevo de grupo** (`webhook/stevo-groups.ts`, irmã de `stevo-send.ts`): reusa
   `stevoPostJson` + creds. ⚠️ **`normalizeStevoNumber` (stevo-send.ts:72) DESTRÓI o JID de grupo**
   (faz `split('@')[0].replace(/\D/g)`) → pro grupo NÃO normalizar; mandar `number='<jid>@g.us'`
   + `formatJid:true`.
4. **MULTITOOL `group_campaign`** (`tools/group-campaigns.ts`) com `action` discriminado — 1 tool:
   `list_groups`/`group_members`/`preview` = **safe** (read-only mesmo em test-mode); `import_members`
   = medium; `schedule` = **high** (exige `confirmed_by_rep`, gate H8); `pause`/`resume`/`cancel`
   delegam pro `BULK_MANAGEMENT_TOOLS`. Test-mode gate herdado de graça.
5. **Caso Matheus (2 posts/dia no mesmo grupo) = CAMPANHA RECORRENTE** (`bulk_message_sequences` +
   `recurring-runner`, já respeita quiet_hours+timezone). Evita a colisão `UNIQUE(job_id,contact_id)`
   (00050:103) sem relaxar a constraint. 1 ocorrência por tick.
6. **Hard-gate multi-tenant (Fase 1)**: campanha de grupo SÓ em location com instância Stevo
   **DEDICADA** provisionada manual (servidor a partir de $5). A tool **RECUSA** quem só tem a
   compartilhada → isola o risco de ban ao rep do número dedicado, nunca derruba o DM de todos.
   Schema: coluna `kind('shared'|'dedicated')` em `stevo_instances`; resolver `getStevoInstanceForRep`.
7. **Módulo/entitlement**: `group_campaigns` = módulo novo (`agent_modules`, audience `rep`),
   entitlement por location, atrás de flag `GROUP_CAMPAIGNS_ENABLED` (default OFF / log-first). Só
   **rep-facing** (SparkBot) no MVP; lead-facing NÃO posta em grupo.
8. **Terms Parte 2**: reusa `parseTermsResponse` + `buildTermsInteractive` (2ª instância do mesmo
   mecanismo) + coluna aditiva `group_campaign_terms_accepted_at/_rejected_at` em `rep_identities`
   + 3º gate no `executeTool` (entre test-mode :197 e confirmation :218).
9. **Anti-ban = camada FINA no MVP** (a Surface C de 6 subsistemas é sobre-engenharia): pacing alto
   + jitter + **interleave** de grupos (já existe `bulk-messages-v2.ts:1065`) + **variação** de
   conteúdo (`generateVariation`/variator já existe; spintax determinístico de fallback) + **1
   advisor heurístico** de spam-score (regex em código, NÃO LLM-call; só sugere reescrita, bloqueio
   duro só em score extremo). Cap por número + circuit breaker → Fase 3.
10. **Visualização de grupos** (pedido 1) = config do **PAINEL Stevo** (sessão + sync de grupos),
    runbook do time, NÃO código nosso. `/group/myall` vazio = config do painel.

## Fases

### Fase 0 — Decisões + setup + fundação (BLOQUEANTE)
- 🤝 Rodar `scripts/probe-stevo-groups.ts` e CAPTURAR output — confirmar shape de `/group/list` +
  `/group/info`. (Parcial: já rodei, `/group/list` confirmado; falta `/group/info`.)
- 🤝 **Probe de ENVIO**: 1 post a grupo-sandbox via `POST /send/text {number:'<jid>@g.us',formatJid:true}`
  — confirmar que funciona em prod; testar grupo `announce` (só admin) pra ver o erro.
- 👤 DECISÃO servidor dedicado: provisionamento MANUAL da agência (SparkBot só dá nudge + ticket)
  ou self-serve? Fornecedor + fluxo "chamar suporte" + preço ($5+).
- 👤 DECISÃO compliance/copy: aprovar o TEXTO dos Termos & Segurança Parte 2 + a lista de claims que
  o advisor sinaliza (ex.: "rende 11%/retira a qualquer momento").
- 👤 Liberar visualização de grupos no painel Stevo (sessão + sync).
- 🤖 Migration aditiva (criar arquivo + aplicar via MCP).
- 🤖 Provisionar 1 instância Stevo DEDICADA de teste (`kind='dedicated'`).

**Saída:** shape confirmado por output real; 1 envio a grupo-sandbox OK; copy dos Termos aprovada;
decisão dedicado tomada; migration em staging.

### Fase 1 — Cliente + multitool + send-path + termos (MVP, flag OFF)
- 🤖 `webhook/stevo-groups.ts` (listGroups/getGroupInfo/sendGroupText; cache; JID preservado).
- 🤖 `tools/group-campaigns.ts` (multitool `group_campaign` com `action`); registro atrás de flag+entitlement.
- 🤖 Branch no runner (`target_type==='groups'→sendGroupText`); skip opt-out; **announce+não-admin
  bloqueado no PREVIEW** antes de agendar.
- 🤖 Terms Parte 2 (texto + interactive + 3º gate; dispara aceite ANTES).
- 🤖 `getStevoInstanceForRep` (dedicada → permite; compartilhada → RECUSA com msg clara).
- 🤖 Anti-ban v1 (interval ~300s/floor 180s/jitter; interleave; variação).
- 🤖 `scripts/test-group-campaign.ts` (parity + dry-run; JID preservado; gates; recusa compartilhada).

**Saída:** 1 campanha real (instância dedicada de teste) dispara/pausa/retoma/cancela; termos
bloqueiam sem aceite; flag OFF até validar 1 conversa real.

### Fase 2 — UX no /hub + recorrência (caso Matheus) + advisor
- 🤖 Rota `/hub/campaigns/groups` com tabs [Contatos][Grupos] (não novo item na sidebar); `/new`
  espelha `campaign-wizard.tsx`, `/[id]` espelha `detail-view.tsx`.
- 🤖 Seleção de grupos (lazy-load `/group/list`, busca por nome/JID, "ver membros" drawer, multi-select);
  editor de variações reaproveita o A/B renomeado "Variações anti-spam".
- 🤖 **PARIDADE campo-a-campo** wizard novo vs Bulk V2 (anti-pattern CLAUDE.md — não marcar done sem cruzar).
- 🤖 Recorrência (2 posts 7:30/12:00) via `bulk_message_sequences` + `recurring-runner`.
- 🤖 Advisor anti-spam (`scoreSpamRisk` regex → warning + sugestão; bloqueio duro só em score extremo).
- 🤝 `import_members` opt-in por campanha (normalizePhone BR + dedup; tag isolada `grupo:nome` que NÃO
  entra em bulk de contato).

**Saída:** wizard de grupo no /hub com paridade; caso Matheus roda recorrente; advisor sugere reescrita.

### Fase 3 — Robustez anti-ban séria + liberação gradual
- 🤖 Cap por NÚMERO (`group_daily_cap`/`group_hourly_cap`) + ledger atômico + warmup (ramp).
- 🤖 Circuit breaker por health da instância (Connected/LoggedIn false → pausa SÓ jobs de grupo, não o
  DM proativo). Kill-switch `GROUP_CAMPAIGNS_ENABLED`.
- 🤝 Ligar a flag pra 1 location dedicada real; hypercare 48h (Sentry + admin_signals).
- 👤 Decidir abertura (só dedicadas vs self-serve).

## Risk register (top)
| Risco | Prob/Impacto | Mitigação |
|-------|--------------|-----------|
| **BAN do número COMPARTILHADO** (1 instância carrega o DM de todos) | Alta/**Crítico (sistêmico)** | Hard-gate: grupo SÓ em instância DEDICADA; tool recusa a compartilhada; servidor dedicado nos Termos como proteção real |
| Forma da API de grupo + envio não exercitada em prod | Alta/Alto | Fase 0 bloqueante: probe + 1 envio a sandbox antes de código de prod |
| `sendToContact` runner hardwired em GHL/contactId | Certa/Crítico | Branch `target_type==='groups'→sendGroupText(JID)` + dry-run |
| `normalizeStevoNumber` destrói o JID `@g.us` | Alta/Alto | `sendGroupText` NÃO normaliza; teste cobre JID preservado |
| Colisão `UNIQUE(job_id,contact_id)` no 2-posts/dia | Média/Médio | Modelar como campanha RECORRENTE, não 2 rows |
| Grupo `announce` (só admin posta) | Média/Médio | Detectar announce+isAdmin no preview, bloquear antes |
| Conteúdo idêntico + msg a não-contatos = gatilho de ban | Média/Alto | Variação obrigatória + interleave + interval + advisor; Termos cobrem o residual |
| Stevo SPOF sem API de status (apagão 06-17) | Média/Médio | Cache + degradação graciosa; breaker pausa jobs de grupo |

## Decisões que precisam do Pedro (pra Fase 1 começar)
1. **Servidor dedicado**: manual (agência provisiona, SparkBot só dá nudge+ticket) ou self-serve? Fornecedor/preço/fluxo de suporte?
2. **Aprovar a cópia** dos Termos & Segurança Parte 2 + a lista de claims que o advisor sinaliza.
3. **Confirmar o hard-gate**: campanha de grupo SÓ em instância DEDICADA, tool recusa a compartilhada?
4. **MVP é só DISPARO** (não processar replies dentro do grupo)?
5. `group_campaigns` = **módulo pago novo** ou add-on do módulo `bulk`?
6. Caso Matheus = campanha **RECORRENTE diária** (confirma)?
7. Quem libera a visualização de grupos no painel Stevo e quando? (bloqueia o probe da Fase 0)

## Fora do MVP
Replies dentro do grupo; tabelas `group_campaign_*` separadas; self-serve de dedicado; cap por
número/warmup/breaker (Fase 3); os 6 subsistemas anti-ban de uma vez; scanner de compliance no
DM/Bulk V2; lead-facing postando em grupo; import automático de membros; capar add/create de grupos.
