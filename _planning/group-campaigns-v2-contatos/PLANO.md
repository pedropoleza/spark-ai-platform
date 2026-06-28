# PLANO — Campanhas em Grupo de WhatsApp via Contato-GHL (H46 / GROUP_CAMPAIGNS_V2)

> Decision code: **H46** (grupos-como-contatos). Flag de rollout nova: **`GROUP_CAMPAIGNS_V2`** (default OFF / log-first), separada da legada `GROUP_CAMPAIGNS_ENABLED` do H40 — que será retirada.
>
> Plano consolidado de 6 dimensões de design + crítica adversarial incorporada. PT-BR. Solo dev (Pedro).
> Substitui conceitualmente `_planning/group-campaigns-whatsapp/PLANO.md` (H40, arquitetura direto-Stevo, nunca rodou em prod).

---

## 1. Resumo executivo + a correção arquitetural vs H40

### 1.1. A tese (o que muda de fato)

O H40 tratou "grupo de WhatsApp" como um **endereço fora do GHL** (JID `@g.us`), com um **transporte paralelo** (Stevo `/send/text` direto) e um **gate de infraestrutura próprio** (`stevo_instances.kind='dedicated'`). **Isso é a arquitetura ERRADA pra esta estrutura.**

Um GET ao vivo (contato `gqN8HUwxzaTLmGUtsORh`, location `RkFnbOYKJvJfBEaU1ycO`, rep Matheus Curty) provou que **um grupo de WhatsApp JÁ É um contato normal no Spark Leads**:

- `firstName`/`lastName`: nome termina em "GRUPO"/"grupo" (ex: "Brasileiros Philadelphia GRUPO").
- `email` = **o JID do grupo** (`120363382820048510@g.us`; legado `12159770585-1623533526@g.us`). Sempre `@g.us`.
- `phone` = placeholder (`+1201555xxxx`). `type="lead"`. `customFields=[]`. Tag ex: `"grupos disparo - matheus"`.
- Conversa `TYPE_PHONE`; mensagens `TYPE_CUSTOM_SMS` (Stevo = custom-SMS provider plugado no GHL).
- Posts dos membros chegam como **INBOUND** com attachments (o GHL já recebe texto + mídia do grupo).
- **Enviar ao grupo = `POST /conversations/messages { type:"SMS", contactId:<id do contato-grupo>, message, attachments:[url] }`** — a MESMA rota de qualquer contato. Anexo nativo validado (H41, probe F5).

**Consequência:** disparo a grupo = disparo a contato comum. O `contact_id` do recipient deixa de ser o JID e passa a ser **o ID real do contato-grupo no GHL** (`gqN8…`). Some o canal Stevo direto; some o gate de instância dedicada como gate de código. Grupos passam a ser CONTATOS no pipeline GHL/Bulk V2/follow-up que **já existe**.

### 1.2. Máquina existente que REUSAMOS (não reinventar)

| Peça | Arquivo:linha | Reuso |
|---|---|---|
| Envio de texto | `ghl/operations.ts:708` `sendMessageToContact(client, contactId, message, "SMS")` | Idêntico p/ grupo |
| Envio de mídia nativa | `ghl/operations.ts:741` `sendMediaToContact(client, contactId, url, caption, "SMS")` | Anexo nativo (probe F5) |
| Bulk V2 | `bulk_message_jobs`/`bulk_message_recipients` (`UNIQUE(job_id,contact_id)`); `bulk-message-runner.ts` | Claim atômico, pacing/jitter, variação, quiet-hours, opt-out |
| Recorrência | `recurring_campaigns` + `recurring-runner.ts` | Job filho por ocorrência |
| Task Orchestrator (H41) | `task_drafts`/`draft_steps` → `followup_sequences`/`followup_messages`; `followup-runner.ts` | N-msgs/1-alvo, pause-on-reply/DND/opt-out |
| Signed-URL on-demand | `reaction-engine.ts:206-214` (`createSignedUrl(path, 600)`) | Padrão canônico de mídia |
| Bucket privado | `agent-media` (00116, 25 MB, signed URLs) | Reuso com path-prefix |
| Descoberta de grupos | Filter Engine (`email` `contains` server-side) + `tools/contacts.ts` `search_contacts` | Achar contatos `@g.us` |

### 1.3. O que RETIRAMOS (morte do caminho direto-Stevo)

- `webhook/stevo-groups.ts` `sendGroupText` (envio direto via `/send/text`).
- `repositories/stevo-instances.repo.ts` `getStevoInstanceForRep` (gate `kind='dedicated'`).
- `bulk-message-runner.ts:737-738` branch `target_type==='groups'` → `sendToGroup` + a função `sendToGroup` (`:827-856`).
- `recurring-runner.ts:226-297` branch que monta recipients por JID.
- `stevo_instances.kind` como **gate de código** (a coluna fica no schema, vira telemetria; o conselho de número dedicado migra pros Termos).

### 1.4. O que o Pedro PEDIU (requisitos)

1. **Controle total por-grupo:** agendar, **EDITAR**, **MUDAR HORÁRIO**, **VER o que está programado EM CADA GRUPO**, pausar/cancelar.
2. **Mensagens, ÁUDIOS e DOCUMENTOS:** o rep manda áudio/imagem/ficheiro pro bot, o sistema **GUARDA** isso como ativo reutilizável e permite disparar nos grupos. Não é só texto.
3. "Cria o planeamento e vê a melhor maneira de implementar."

### 1.5. Reconciliação das contradições inter-seção (resolvidas pela crítica adversarial)

Os 6 sub-planos de design discordavam em pontos críticos. **Este plano fixa as decisões finais:**

| Conflito | DECISÃO FINAL |
|---|---|
| Mídia: `media_url` (path) vs `media_id` (FK) | **`media_id uuid` (FK)**; signed URL resolvida NO ENVIO (TTL 600s). NUNCA persistir signed URL nem path cru numa coluna que o runner mande literal. |
| Biblioteca de mídia: estender `media_library` vs tabela nova | **Tabela nova `rep_media`** (zero risco no `send_media` lead-facing scoped por `agent_id`). |
| `target_type='groups'`: switch de envio vs rótulo | **Rótulo SEMPRE** (`target_type='groups'` permanece). O ENVIO decide por `recipient.is_group`, ignorando `target_type` no roteamento. Cockpit filtra `WHERE target_type='groups'` (funciona). |
| Descoberta: `ends_with` server-side vs `contains` | **`email contains '@g.us'` (server-side, suportado — `capabilities.ts:77`)** + `detectGroupContact` re-validando o shape. `ends_with` é CLIENT-SIDE (`capabilities.ts:78`) → estoura cap 5000 em org grande. |
| Números de migration (00117/00118 reivindicados, já existem) | **Sequencial a partir de 00119**, uma migration por dimensão, dono único (ver §7). |

---

## 2. Modelo de dados & identificação de grupos

### 2.1. Princípio

O grupo já tem `contact_id` estável, já está na location, já passa pelo Filter Engine. O modelo de dados **não inventa entidade nova** — ensina o sistema a RECONHECER quais contatos são grupos e tratá-los com regras especiais (pular opt-out/DND, não normalizar phone, falar pelo nome amigável).

- **Ação:** sempre `contact_id` (rota `/conversations/messages`).
- **Identidade técnica:** `jid` (= `email`) — diagnóstico/dedup/audit.
- **Fala:** `group_name` — o bot diz "vou postar no *Brasileiros Philadelphia*".

### 2.2. Detector de contato-grupo (função pura testável)

Novo módulo: **`src/lib/account-assistant/group-contacts/detector.ts`**. Sem I/O, 100% testável. Fonte ÚNICA da verdade.

```ts
type GroupContactSignal = {
  isGroup: boolean;
  jid: string | null;          // normalizado lower-case, validado @g.us
  confidence: "certain" | "likely" | "weak";
  reason: "email_jid" | "name_suffix" | "tag" | "none";
};

detectGroupContact(contact: {
  email?: string|null; firstName?: string|null; lastName?: string|null;
  name?: string|null; tags?: string[]|null;
}, opts?: { groupTagHints?: string[] }): GroupContactSignal

extractGroupJid(email: string): string | null   // valida shape /^[\w.-]+@g\.us$/i
```

**Precedência (curto-circuita na 1ª que casa):**

1. `email` termina em `@g.us` (após `trim().toLowerCase()`, valida regex `/^[\w.-]+@g\.us$/i`) → `confidence:"certain"`, `jid=email`, `reason:"email_jid"`. **Sinal primário e ÚNICO confiável pra ENVIO.**
2. `email` ausente MAS nome termina em token "GRUPO"/"grupo" (`/\bgrupos?$/i` após `deburr` de `contact-resolver/normalize.ts`) → `confidence:"likely"`, `jid:null`, `reason:"name_suffix"`. Heurística de resgate só p/ LISTAGEM.
3. `tags` contém uma das `groupTagHints` (partial match deburr) → `confidence:"weak"`, `reason:"tag"`. **Sozinha NÃO marca `isGroup:true`** — exige co-sinal; serve só como filtro de busca.

**Blindagem anti-falso-positivo (crítica A4/A8):**
- Contato pessoa cujo `lastName` é "Grupo": sinal de nome é `likely`, NUNCA `certain`. O pipeline de **ENVIO** exige `jid` resolvido (só do `@g.us`). Sem JID → fluxo de contato normal.
- DM individual termina em `@s.whatsapp.net`/`@c.us`, não `@g.us`. O detector só casa grupo.
- **Critério de segurança (S1):** `isGroupContact = email?.toLowerCase().endsWith("@g.us") === true` — só o email decide pular opt-out/DND. Nome/tag são descoberta, não classificação de segurança.

### 2.3. Cache local `group_contacts` (não query ao vivo a cada turno)

**Por quê cache, não pull-all toda vez:** `ends_with @g.us` é client-side (`capabilities.ts:78`), e mesmo `contains @g.us` server-side em org com 5000+ contatos pode estourar o cap defensivo do filter-engine (`executor.ts`, `hit_safety_cap`) e **perder grupos silenciosamente** além da página varrida. Grupos são poucos (dezenas) mas dispersos entre milhares.

**Tabela `group_contacts` (migration 00119, ver §7):** cache local materializado por sync, com query GHL como fallback/refresh. Chaveada por `location_id` (string GHL, **sem FK a `locations`** — robusto a location não-sincronizada, ver §2.5). NÃO chaveada por `rep_id` (grupos vivem na location; o targeting "meus grupos" é por tag).

**Sync (`group-contacts/sync.ts` — `syncGroupContacts(ctx)`):**
1. Filter Engine `{ field:"email", op:"contains", value:"@g.us" }` (server-side, reduz pull). Resultado passa por `detectGroupContact` (defesa contra `contains` casar "x@g.us.algo").
2. Complementa por **tag de grupos** (se configurada) e **nome `contains "grupo"`** (server-side) p/ pegar grupos sem email JID — estes ficam `confidence:"likely"`, `jid:null` → **não disparáveis** até o rep corrigir o cadastro.
3. Upsert por `(location_id, contact_id)`. Marca `is_archived=true` os que sumiram.
4. Cache em memória 10min (padrão filter-engine) por cima do SELECT.

**Freshness:** `list_groups` lê o cache; se `max(last_synced_at)` > TTL (6h) ou vazio, dispara `syncGroupContacts` inline (1ª chamada do dia paga; resto instantâneo). Rep força com "atualiza meus grupos".

### 2.4. Targeting de N grupos (3 modos → `contact_id[]`)

1. **Por tag** (`"grupos disparo - matheus"`): caminho preferido p/ "todos meus grupos". Tag configurável em `rep_identities.profile.preferences.group_tag` (JSONB, sem migration — mesmo padrão de `default_calendar_id`). Filtro local: `WHERE tags @> ARRAY[<tag>]`.
2. **Por lista de nomes**: `resolveGroupTargets` (substitui `resolveGroups` de `group-campaigns.ts:110`) casa nome contra o cache (exato → includes → `deburr`), devolve `{ contact_id, jid, name }[]` + `notFound[]`.
3. **`['all']`/"todos os grupos"**: todos do cache da location (`is_archived=false`), ou da tag se configurada.

Targeting sempre escopado por `ctx.locationId`.

### 2.5. Multi-location & locations não-sincronizadas

- O **detector é puro** → funciona mesmo se a location estiver ausente de `locations`.
- O **sync usa `ctx.locationId`** (string GHL do token), não o UUID interno de `locations`. `group_contacts.location_id` é o `locationId` string, **deliberadamente desacoplado** (sem FK).
- ⚠️ **MAS o ENVIO depende de `locations.company_id`** (`bulk-message-runner.ts:744-748`, `followup-runner.ts:347-350` retornam `"location não sincronizada"`). A location do Matheus (`RkFnbOYKJvJfBEaU1ycO`) **pode não estar em `locations`**. → **Auto-heal de `locations` vira PRÉ-REQUISITO do envio** (não opcional): o sync de grupos faz `upsert` mínimo em `locations` (`location_id`, `company_id` do token, `timezone` do GHL). **Decisão de bloqueio: validar ao vivo que `RkFnbOYKJvJfBEaU1ycO` tem linha em `locations` com `company_id` antes do E2E** (senão o send falha antes de qualquer POST).

### 2.6. Anti-contaminação: contato-grupo é `type='lead'` (crítica A8)

O contato-grupo aparece em `search_contacts`/`get_contacts_filtered`, pode entrar em targeting F27 e em bulk "para todos os leads" — disparar um fluxo de VENDA pra um grupo é absurdo. **Dono: este trabalho transversal é parte do MVP (F5).**
- Filtro implícito `email not_contains '@g.us'` (client-side) nos caminhos lead-facing que NÃO são campanha de grupo: `tools/contacts.ts` `search_contacts`, `get_contacts_filtered`, e `checkContactMatchesTargeting` (`src/lib/queue/targeting.ts`, F27).
- **👤 Alertar Pedro:** cada grupo = 1 contato consumido no billing/limites do GHL.

---

## 3. Caminho de envio unificado & retirada do H40

### 3.1. Caminho unificado (ancorado no código)

- **Texto:** `sendMessageToContact(client, contactId, message, "SMS")` → `POST /conversations/messages {type:"SMS", contactId, message}` (`operations.ts:708`). Nenhuma mudança de assinatura.
- **Mídia:** `sendMediaToContact(client, contactId, url, caption, "SMS")` → `{type:"SMS", contactId, message:caption, attachments:[url]}` (`operations.ts:741`). Probe F5 confirma anexo nativo, caption limpa.
- `sendToContact` (`bulk-message-runner.ts:740`) já fala essa língua. Grupo entra no MESMO loop **sem ramo especial** — basta o recipient ter `contact_id` real e (novo) carregar `media_id`.

### 3.2. `target_type='groups'` vira RÓTULO, nunca switch de envio

**Decisão final (reconcilia a contradição [controle]×[envio]):** `target_type='groups'` **permanece** (já existe, 00113). É um RÓTULO p/ telemetria e p/ a cockpit achar campanhas de grupo (`WHERE target_type='groups'`). O **roteamento de ENVIO ignora `target_type`** — grupo cai no `sendToContact` normal porque tem `contact_id` real. O que muda de comportamento (pular opt-out/DND/cooldown) é decidido por **`recipient.is_group`** (booleano derivado de `email @g.us` no agendamento).

Por que `is_group` por-recipient e não `target_type`:
- protege campanha **mista** (cada recipient decide sozinho);
- independe de o LLM ter setado `target_type` certo;
- a regra "pular opt-out" fica acoplada ao FATO (é grupo), não ao rótulo.

### 3.3. Diff de runtime

**`bulk-message-runner.ts`:**
- `:737-738` — **DELETAR** early-return `if (job.target_type === "groups") return sendToGroup(...)`.
- `:827-856` — **DELETAR** `sendToGroup` + imports dinâmicos `getStevoInstanceForRep`/`sendGroupText`.
- `:237` — trocar `if (job.target_type !== "groups")` (opt-out pre-check) → `if (!recipient.is_group)`.
- `:323` — trocar `if (job.target_type !== "groups")` (cooldown) → `if (!recipient.is_group)`.
- `:201-217` — o pre-check em batch que monta `byLoc` p/ `filterOutOptOutContacts` deve **excluir** recipients `is_group=true`.
- `:758-770` `ensureContactAssignedTo` — **PULAR p/ contato-grupo** (`if (!recipient.is_group)`). ⚠️ Crítica-crítica (A1/S5): não sobrescrever o `assignedTo` do contato-grupo, que define qual número entrega (ver §6.1).
- `:785-790` `trySend` — se `recipient.media_id` setado: resolver `createSignedUrl(600s)` e POST com `attachments:[signedUrl]` (= `sendMediaToContact`); senão, caminho atual idêntico.

**`recurring-runner.ts`:**
- `:226-297` — **REESCREVER** branch de grupo: não monta `target_jid` a partir de `group_targets[].jid`. Monta recipients por `contact_id` real: `group_targets` muda de `[{jid,name}]` para `[{contact_id,name,jid?}]`; `is_group:true`; `target_jid: g.jid ?? null` (audit). Mantém `respect_quiet_hours:false`. NÃO chama Stevo.
- `:217` — quiet-hours guard pode permanecer usando `target_type==='groups'` como rótulo de composição (recorrência de grupo pula quiet-hours por design do rep). **Não** usar `target_type` p/ rotear ENVIO.

**`materializer.ts`** (Task Orchestrator → followup):
- `:60-64` `composeText` — **MATAR** o workaround que enfia a URL no texto. `message_text` vira caption LIMPA.
- `:159-166` — copiar `media_id`/`media_type` do `draft_step` pro `followup_messages` (ver §5).

**`followup-runner.ts`:**
- `:338-360` `sendFollowupMessage` — se `media_id` presente: fetch `rep_media.storage_path` → `createSignedUrl(600s)` → POST com `attachments:[url]`. Sem `media_id` → caminho atual (texto puro). Atualizar `rep_media.last_used_at`.
- `:207` `checkContactDnd` — guard `if (isGroupContact) skip` ANTES (ver §6.3).

**`reaction-engine.ts`** — **NÃO tocar** (lead-facing, scoped por `agent_id`; é a referência canônica de signed-URL).

### 3.4. Retirada segura — risco-zero de migração

**`GROUP_CAMPAIGNS_ENABLED` está OFF em prod, NUNCA foi ligado** (confirmado: só em `config.ts:17`, `tools/index.ts:69`, `admin/cron-health/route.ts:29`; nenhum `.env`). Logo: 0 recipients de grupo em voo, 0 `recurring_campaigns target_type='groups'`, 0 `stevo_instances.kind='dedicated'`. **Deletar, não depreciar.**

| Artefato | Arquivo:linha | Ação |
|---|---|---|
| `sendToGroup` | `bulk-message-runner.ts:827-856` | Deletar |
| Branch `target_type==='groups'` no send | `bulk-message-runner.ts:737-738` | Deletar |
| `sendGroupText` | `webhook/stevo-groups.ts` | Deletar |
| `listStevoGroups`/`parseGroup`/`StevoGroup` | `webhook/stevo-groups.ts` | Deletar (descoberta agora é por contato `@g.us`; membros caem do MVP, ver §4/§8) |
| `getStevoInstanceForRep` + `DedicatedStevoResult` | `stevo-instances.repo.ts:106-134` | Deletar (manter `getStevoInstance`/`upsertStevoInstance` — DM fallback usa) |
| `resolveDedicated` + gate | `tools/group-campaigns.ts:52-88,197-198,393-395` | Substituir por resolução de contatos-grupo |
| `isGroupCampaignsEnabled` | `config.ts:17` | Substituir por `isGroupCampaignsV2Enabled` |
| `stevo_instances.kind` (coluna) | schema | **Não dropar** (DROP em prod = risco); vira telemetria, perde papel de gate |
| `scripts/probe-stevo-groups.ts` | scripts/ | Deletar |

**Manter:** `getStevoInstance` (`stevo-instances.repo.ts:56`, DM fallback); `normalizeStevoNumber` JID-preserve (`stevo-send.ts`, foi um fix, não custa).

**Correção de bug de migração de código (crítica L):** `scheduleOneShotGroup` hoje grava `contact_id: g.jid` (`group-campaigns.ts:507`) e o recurring `contact_id: g.jid` (`:271`). **Trocar para `contact_id: <ID GHL do contato-grupo>`** — senão o novo caminho manda pro JID, que não é endereçável via `/conversations/messages`.

### 3.5. Gate de paridade H40 vs V2 (obrigatório por CLAUDE.md)

Antes de marcar done, cruzar campos/ações:
- **Preservados:** schedule / pause / resume / cancel / list_campaigns / list_groups / preview / variations / recurrence / interval / spam-advisor.
- **Novos:** edit / reschedule / list-por-grupo / mídia.
- **Deltas como DECISÃO DE DESIGN documentada:** (a) sem gate `kind='dedicated'` → conselho nos Termos; (b) descoberta por email-JID em vez de `listStevoGroups`; (c) `group_members` (participantes) cai do MVP (GHL não expõe). Marcar cada um neste PLANO.

---

## 4. Cockpit de controle por-grupo (tools, schema)

### 4.1. Modelo mental: a unidade é "post programado em um grupo"

Cada linha que o rep controla = um `bulk_message_recipients` pending de um job de grupo OU uma `recurring_campaigns` de grupo. O rep pensa em "grupo"; o sistema agrega por `contact_id`/`group_name`. **Não precisa tabela nova** — SELECTs sobre as tabelas existentes.

### 4.2. Estratégia: ABSORVER granularidade nas 2 tools existentes (sem tool nova)

Manter 2 tools (1 safe, 1 high) preserva o gate H8 por-tool, o test-mode gate, e o budget de tools no prompt (custo H44). As capacidades novas entram como `action` novas.

### 4.3. `group_campaign_info` (risk: **safe**) — actions

| Action | Fonte | Nota |
|---|---|---|
| `list_groups` | cache `group_contacts` (sync se stale) | `[{name, contact_id, jid, member_count?, tags}]`. Remove `admin_only/isAnnounce` (vinha só do Stevo). |
| `group_members` | — | **FORA DO MVP** (GHL não expõe participantes) → "não consigo listar membros por aqui". |
| `preview` | `resolveGroupTargets` + `scoreSpamRisk` + ETA pacing | Sem `announce_only` (gap documentado). |
| `list_campaigns` | `bulk_message_jobs`/`recurring_campaigns` `WHERE target_type='groups'` | Inalterado. |
| `scheduled_by_group` ⭐ | agregação por grupo (abaixo) | "ver o que tá programado EM CADA GRUPO" (req #1). |
| `group_schedule` ⭐ | idem, escopo 1 grupo | "o que tem no Philadelphia?". |

**`scheduled_by_group` — a consulta-chave:**
```sql
-- 1) pending one-shot agrupado por grupo:
SELECT r.contact_id, r.group_name, r.id AS recipient_id, r.scheduled_at, r.status, r.label,
       COALESCE(r.personalized_message, j.message_template) AS text_preview, j.id AS job_id
FROM bulk_message_recipients r JOIN bulk_message_jobs j ON j.id = r.job_id
WHERE j.rep_id=:rep AND j.location_id=:loc AND j.target_type='groups'
  AND j.status IN ('running','paused') AND r.status='pending'
ORDER BY r.contact_id, r.scheduled_at;
-- 2) recorrências de grupo:
SELECT id, label, cron_expression, timezone, enabled, next_run_at, filter_config, message_template
FROM recurring_campaigns
WHERE rep_id=:rep AND location_id=:loc AND target_type='groups' ORDER BY created_at DESC;
```
Resposta agrupada por `contact_id`, com `summary_text` pré-formatado p/ WhatsApp (padrão `dashboard_summary`). O bot mostra por NOME; `recipient_id`/`recurring_id`/`job_id` ficam no payload p/ agir depois (anti-alucinação H45/H41: relê, não inventa id).

### 4.4. `group_campaign` (risk: **high**, H8) — actions granulares

```jsonc
action: [ "schedule", "pause", "resume", "cancel",
          "edit_message", "reschedule" ]   // edit_message/reschedule novos
// alvos granulares (precedência no handler):
recipient_id   // 1 post pendente (de scheduled_by_group)
recurring_id   // 1 regra recorrente
group          // todos os posts+regras DAQUELE grupo
job_id         // job inteiro (delega bulk_reschedule_job)
// (nenhum) → todas as campanhas de grupo do rep (legado)
// params: new_message, new_time, media_id, media_type
```
**Precedência de escopo:** `recipient_id` > `recurring_id` > `group` > `job_id` > nenhum. Entrega "pausa só nesse grupo" sem quebrar "pausa tudo".

### 4.5. Implementações por capacidade

**`edit_message`** (req #1 "editar a mensagem"): `UPDATE bulk_message_recipients SET personalized_message=:new, edited_at=now(), edit_count=edit_count+1 WHERE id=:rid AND status='pending'` (JOIN job p/ checar `rep_id`/`location_id` — anti-IDOR, padrão `bulk_reschedule_job`). `status='pending'` obrigatório; se já `sending`/`sent` → 0 rows → erro honesto ("esse já tá saindo"). Spam advisor no `new_message`. Difere de `bulk_edit_pending_job` (que muda o template do JOB inteiro).

**`reschedule`** (req #1 "mudar horário"):
- **(a) post** (`recipient_id`+`new_time` ISO): `UPDATE ... SET scheduled_at=:t WHERE id=:rid AND status='pending'`. Valida futuro (`>now-60s`).
- **(b) recorrência** (`recurring_id`+`new_time` 'HH:MM'/cron): `UPDATE recurring_campaigns SET cron_expression=... ` via `dailyTimeToCron` + **sempre** recomputa `next_run_at` via `computeNextRunAt` (senão fica no horário velho — crítica). ⚠️ **DST/edge (crítica medium):** o bot deve dizer EXPLÍCITO que "os posts de hoje já agendados não mudam; vale da próxima ocorrência" e validar weekday/hora no fuso IANA (lição H42 Manuela). Se a ocorrência de hoje já materializou, oferecer reagendar também os pending de hoje.
- **(c) job inteiro** (`job_id`): delega `bulk_reschedule_job` (offset preservado).

**pause/cancel por grupo:** resolve `contact_id` → cancela posts pending daquele grupo (`status='cancelled'`) + desabilita recorrências daquele grupo (`enabled=false`). Sem escopo → legado (todas do rep).

**"Pausar TEMPORARIAMENTE 1 grupo num job multi-grupo" (crítica high):** `skipped`/`cancelled` são terminais. **DECISÃO: adicionar `bulk_message_recipients.paused_at` (nullable)**; o claim do runner passa a exigir `paused_at IS NULL`. Pause-por-grupo = setar `paused_at` nos recipients daquele `contact_id`; resume = limpar. Custa 1 coluna + 1 cláusula. **Entrega o "controle total por-grupo" que o Pedro pediu** (sem isso, cancelar+reagendar perderia texto/variações/mídia montados).

### 4.6. Recorrência por-grupo (caso Matheus "2 posts/dia 7:30")

- 1 recorrência = 1 horário; "2 por dia" = 2 rows `recurring_campaigns` (cron distinto). Rep vê/edita cada uma.
- **N posts DIFERENTES no mesmo dia/mesmo grupo no MESMO job** colide com `UNIQUE(job_id,contact_id)` → rotear pelo **followup materializer** (resolve N-msgs/1-alvo), tratando grupo como contato. One-shot single-post segue no bulk.

### 4.7. UX no chat (anti-alucinação, H45/H41)

1. Sempre `scheduled_by_group`/`group_schedule` ANTES de mutar (relê o estado real, pega ids dali).
2. Mostra por NOME, age por id (nunca expõe UUID cru).
3. Confirm antes de mutar (H8): "No *Philadelphia* tem o post das 14:30. Troco o texto? ✅/✏️".
4. Pós-mutação ecoa o ESTADO REAL (count de rows afetadas): "Reagendei 1 post ✅" só se UPDATE = 1 row. 0 rows → diz a verdade.
5. Recorrência: deixa claro o escopo temporal (posts de hoje não mudam).

Prompt: estender a seção GATED por `GROUP_CAMPAIGNS_V2` em `prompt-builder.ts` com 4 exemplos ("ver programado", "muda texto do post das 14h no grupo X", "passa o 7:30 pra 8h", "cancela só no grupo Y"). GATED OFF = prompt idêntico.

---

## 5. Pipeline de mídia (inbound → biblioteca → outbound)

> Requisito #2. Hoje a mídia inbound é transcrita/descrita e **jogada fora**; os runners só mandam texto. 3 gaps confirmados: `followup_messages`/`bulk_message_recipients` sem colunas de mídia; `materializer.ts:60` enfia URL no texto; `followup-runner.ts:338-360` e `bulk-message-runner.ts:785-790` só mandam `message`.

### 5.1. Decisões de arquitetura

| # | Decisão | Justificativa |
|---|---|---|
| D1 | **Tabela nova `rep_media`** (não estender `media_library`) | `media_library` é `agent_id NOT NULL` (lead-facing); `reaction-engine.ts:206` faz `.eq('agent_id',...)`. Misturar fragiliza o `send_media`. Tabela nova = zero risco. |
| D2 | Reusar bucket `agent-media` com prefixo `rep-media/{rep_id}/{uuid}.{ext}` | Bucket já existe (00116), privado, signed-URL, mimes certos. |
| D3 | Persistir = INTERCEPTAR, não re-buscar | O binário já trafega no parse (`input-parser.ts:111` p/ arquivos; download p/ áudio). Re-download numa URL que pode ter expirado é frágil. |
| D4 | **`media_id` (FK), signed URL gerada NO ENVIO (TTL 600s), NUNCA persistida** | Signed URL expira → anexo quebra dias depois. Asset = `storage_path` estável; URL = efêmera por envio. Resolve a contradição inter-seção. |
| D5 | Referência em contexto = PISTA validável (id real), espelha H45 "CONTATO EM CONTEXTO" | Anti-alucinação: bot nunca inventa `media_id`. |
| D6 | 1 asset → N disparos (FK, não duplica upload) | Mesma mídia vai pra N grupos. |
| D7 | Migrations aditivas/nullable; sem `media_id` = comportamento de hoje | Gate de paridade. |
| D8 | Flag `REP_MEDIA_ENABLED` (default OFF / log-first), gateia tools + captura | Captura inbound pode ligar antes do outbound. |

### 5.2. Captura inbound (rep → bot → guarda)

**Schema `rep_media` (migration 00121, ver §7):** `id`, `rep_id` (FK `rep_identities`, ON DELETE CASCADE), `hub_location_id`, `storage_path`, `mime_type`, `media_kind` ('audio'|'image'|'document'), `size_bytes`, `original_name`, `transcription` (áudio Whisper), `caption_text` (imagem/doc), `short_label`, `source` ('whatsapp'|'web'), `expires_at` (nullable, retenção), `created_at`, `last_used_at`. Índices `(rep_id, created_at DESC)` e `(hub_location_id)`. RLS deny-anon (padrão 00088).

**Persistência no parse (`input-parser.ts`):** adicionar sink opcional (padrão do `audioMetaSink`):
- **Áudio** (`:38-54`): `transcribeAudioFromUrlVerbose` já baixa o buffer (`audio-transcriber.ts:106`) mas não o expõe → refactor leve p/ devolvê-lo opcionalmente. Subir → `rep-media/{rep_id}/{uuid}.ogg`, gravar `media_kind='audio'`, `transcription`.
- **Imagem/PDF** (`:111`): buffer já na mão antes do `processFile`. Subir → `media_kind` mapeado, `caption_text` = summary/extracted truncado, `original_name`.
- CSV/XLSX **NÃO** viram mídia disparável (é dado; segue `analyze_tabular_data`).
- Best-effort/fail-soft (try/catch, nunca quebra o turno). Helper novo `account-assistant/rep-media/capture.ts` `persistRepMedia()` (mantém `input-parser.ts` puro). O `processor.ts` chama pós-parse. Reusa SSRF guard (`validateExternalUrl`) + `file-processor` (sniff/limites).
- Web UI: `/api/sparkbot/upload` (hoje pass-through) persiste via `persistRepMedia` (`source='web'`).

**`short_label` determinístico (sem LLM extra):** áudio→`"Áudio {Ns} — {~60 chars transcrição}"`; imagem→`"Imagem {filename} ({tamanho})"`; PDF→`"PDF {filename} — {N} chars"`.

### 5.3. Referência em contexto (bot "lembra" da mídia recente)

Espelha H45 `active-contact.ts`. Novo `account-assistant/rep-media/recent-media.ts`:
- `getRecentRepMedia(supabase, repId, {hubLocationId, windowHours, cap})` → últimas N, `created_at DESC`, cap ~5, fail-soft.
- `renderRecentMediaBlock(items)` → bloco `# MÍDIAS RECENTES DO REP` no **runtime context (user message, NÃO no system — H44 F1, cache-safe)**:
  ```
  # MÍDIAS RECENTES DO REP
  Mídias que você recebeu de mim (pra disparar use o id EXATO, nunca invente):
  - [media_id: abc123] Áudio 45s — "fala sobre renda do seguro..."
  - [media_id: def456] PDF apresentacao.pdf — 12.000 chars
  NUNCA invente um media_id; se não tiver certeza, me pergunte.
  ```
- Wire no `processor.ts` (mesmo lugar do `renderContactInFocusBlock`). GATED por `REP_MEDIA_ENABLED`.

### 5.4. Outbound (fechar os 3 gaps)

**Schema (migration 00120, ver §7):**
```sql
ALTER TABLE followup_messages
  ADD COLUMN IF NOT EXISTS media_id uuid REFERENCES rep_media(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE bulk_message_recipients
  ADD COLUMN IF NOT EXISTS media_id uuid REFERENCES rep_media(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_type text;
ALTER TABLE draft_steps ADD COLUMN IF NOT EXISTS media_id uuid;  -- hoje tem media_url; deprecar uso de URL crua
```
- `media_id` (FK), NÃO `media_url` (que algum runner mandaria literal e expiraria).
- **Materializer** (`:159-166`): copia `media_id`/`media_type` do step → msg; `message_text` LIMPO (mata `composeText`-com-URL).
- **followup-runner** (`:338-360`): se `media_id` → fetch `storage_path` → `createSignedUrl(600s)` → `attachments:[url]`. Select adiciona `media_id, media_type`.
- **bulk-runner** (`:785-790`): idem em `sendToContact`; `claimBulkRecipients` select adiciona `media_id, media_type`.
- **Grupos = mesmo caminho** (são contatos): anexo nativo via GHL→Stevo, mesma rota provada F5.

### 5.5. Tools de mídia (GATED `REP_MEDIA_ENABLED`)

- `list_rep_media` (safe): `{limit?, kind?}` → `[{media_id, kind, label, created_at, used_count}]`.
- **Estender `add_step`/`edit_step`** (orchestrator) com param `media_id` (preferir vs tool nova — menos cache/prompt). Resolvers travam `rep_id` (IDOR-safe H41).
- **Estender `group_campaign action:'schedule'`** com `media_id`/`media_type` (não tool nova).
- Prompt: seção `# MÍDIA NOS DISPAROS` GATED.

### 5.6. ⚠️ Áudio outbound em **.wav** (decisão Pedro 2026-06-28) — PROBAR

| Tipo | Inbound | Outbound | Status |
|---|---|---|---|
| Imagem | ✅ Vision | ✅ `attachments:[url]` nativo | **Provado (F5)** |
| PDF/documento | ✅ file-processor | ✅ arquivo nativo | **Provado (F5/H41)** |
| Áudio | ✅ Whisper | **`.wav` via `attachments:[url]`** (Pedro: enviar em .wav) | **PROBAR .wav** |

**Decisão Pedro: o áudio sai em `.wav`.** Implicação: o áudio que o rep manda PRO bot chega como `.ogg`/opus (formato WhatsApp) → **transcodificar p/ `.wav` no outbound** (lib de áudio, ex. `ffmpeg`/`fluent-ffmpeg` — confirmar dependência disponível na Vercel; senão um serviço/edge) OU aceitar só `.wav` que o rep faça upload. Persistir o asset já normalizado em `.wav` no `rep_media` (não transcodificar a cada disparo). **Probe obrigatório** `scripts/probe-rep-audio-outbound.ts` (subir `.wav`, signed-URL, POST `type:"SMS" attachments:[url]` pro contato de teste) ANTES de prometer áudio nos grupos: validar que chega tocável no WhatsApp via GHL→Stevo (não link/arquivo genérico). Tamanho: bucket 25MB; WhatsApp ≈16MB; `.wav` é pesado (PCM) → vigiar o limite, considerar bitrate/compressão. **NÃO anunciar "manda áudio pros grupos" até o probe verde.**

---

## 6. Segurança / anti-ban / opt-out / Termos

### 6.1. ⚠️ O número que envia (DECISÃO #1 do Pedro — crítica CRITICAL)

Sem o gate `kind='dedicated'`, o `ensureContactAssignedTo` (`bulk-runner:758-770`) roteia o outbound pelo número do `assignedTo` do contato. Se for o número do REP — o MESMO do DM do SparkBot — **um ban no grupo derruba o copiloto inteiro do rep.** Os caps diários propostos não bastam sozinhos (eram constantes decorativas).

**✅ DECISÃO DO PEDRO (2026-06-28): o número é O MESMO do DM do SparkBot.** Sem número/instância separada. O risco de ban é **ACEITO e DIVULGADO ao rep, exatamente como no disparo em massa (bulk)**. A mitigação NÃO é isolamento de número — é **caps + pacing + variação + aviso explícito nos Termos** (§6.6). Um ban no grupo pode derrubar o DM; o rep sabe disso ao aceitar.
- **Não sobrescrever o `assignedTo`** do contato-grupo (a integração do Stevo já o cria/atribui — ver §2/§9 #2): `if (!recipient.is_group)` no `ensureContactAssignedTo`. O número que entrega é o do rep (= o do DM) por construção; o assign não muda isso.
- **Caps anti-ban ENFORÇADOS** (não decorativos) em `group-campaigns/config.ts`, com query real no `schedule` e por-ocorrência no recurring:

| Constante | Valor | Enforcement |
|---|---|---|
| `GROUP_MAX_GROUPS_PER_DAY` | 10 | query `bulk_message_recipients` `is_group=true` `sent_at::date=today` por location |
| `GROUP_MAX_MSGS_PER_GROUP_PER_DAY` | 2 | idem por `contact_id` |
| `GROUP_MAX_MSGS_PER_DAY_TOTAL` | 20 | idem por location |
| `GROUP_INTERVAL_FLOOR_SECONDS` | 180 (existe) | piso pacing |
| `GROUP_DAILY_RAMP` (warm-up) | — | **FORA DO MVP** (follow-up) |

Se estourar: recusar educadamente ("já postei o limite seguro de hoje pra proteger seu número; agendo pra amanhã?").
- ✅ **RESOLVIDO (Pedro 2026-06-28):** número = o do DM, ban aceito conscientemente e avisado ao rep (como no bulk). Sem provisionar número dedicado.

### 6.2. Opt-out: nunca rodar p/ contato-grupo (crítica HIGH — auto-destrutivo)

Posts de membros chegam como INBOUND no contato-grupo. Um membro digitando "parar"/"sair" → `processInboundForOptOut` marcaria o **grupo inteiro** como opt-out → campanha some silenciosamente. **Blindar nos 2 pontos:**
1. **Envio:** `bulk-runner:237,323` por `!recipient.is_group` (já em §3.3).
2. **Inbound:** gate determinístico em `webhook-handler.ts:136-137` ANTES de `processInboundForOptOut` E em `:75-76` ANTES de `onContactInboundReceived` (pause-on-reply): se `contact.email` termina `@g.us` → **não marca opt-out, não pausa sequência, não responde**. O webhook carrega o email (1 GET ou do payload). **Sem isto a feature se autodestrói no 1º membro que digita "sair".**

### 6.3. DND: não filtrar contato-grupo

Bulk-runner **não checa DND** (confirmado — só opt-out + quiet-hours). DND só no `followup-runner.ts:207` (`checkContactDnd`, fail-SAFE = não envia se não confirma). Um contato-grupo com `dnd:true` por engano silenciaria o grupo. **Guard `if (isGroupContact) skip` ANTES de `checkContactDnd`** (`followup-runner:207`). `seqInfo` carrega `is_group`/email (propagar do materializador).

### 6.4. Quiet-hours: preservar (rep escolhe o horário)

`respect_quiet_hours:false` no job de grupo (já em `group-campaigns.ts:494` e `recurring-runner.ts:257`). O bulk-runner só checa se `job.respect_quiet_hours` (`:265`) → independe de `target_type`. Recurring-runner `:217` mantém o pulo via rótulo. Caso Matheus 7:30 intacto.

### 6.5. Anti-ban: tudo continua, religado ao caminho GHL

O ban é no **número da location** (Stevo plugado). Preservar: pacing/jitter (`computeBatchedScheduledAts`, piso 180s), variação de texto (`variation_mode='light'` ou `variations[]` round-robin), spam advisor (`scoreSpamRisk`). Risco NOVO (1 número p/ DM+grupo) mitigado por §6.1.

### 6.6. Termos Parte 2: manter consentimento, reescrever ponto 3

Preservar: 3 pontos de consentimento; **reject NÃO silencia o SparkBot** (`processor.ts:210,224-227`, inviolável); reject reversível. **Reescrever ponto 3** (`terms.ts:171`):
> "3️⃣ *O número usado é o da sua conta.* As campanhas saem pelo MESMO número que você usa comigo. Se o WhatsApp bloquear por excesso, **você perde os dois** — campanhas E nossa conversa. Por isso eu limito grupos/mensagens por dia (pra te proteger). O ideal pra volume é um *número separado só pra campanhas* (parceiro monta, ~$5). Mas não é obrigatório pra começar."

Ajustar copy: `DEDICATED_SERVER_NUDGE` deixa de ser erro de bloqueio → nudge opcional. Tutorial "Enable group view" do painel Stevo → substituído por "não achei grupo cadastrado como contato — me passa o nome ou pede pro admin sincronizar".

### 6.7. Inbound do grupo (membros postando) — bot ignora

**👤 Decisão (recomendo):** ignorar 100% do inbound de contato-grupo p/ resposta automática + opt-out + pause. Mesmo gate `@g.us` de §6.2. (Responder dentro do grupo / processar membros = fora de escopo.)

---

## 7. Migrations & flags

> ⚠️ Última migration real = **00118**. `00117`/`00118` JÁ EXISTEM em prod. Numerar sequencial **a partir de 00119**, dono único por arquivo. Cruzar `ls supabase/migrations/` antes de escrever número. Todas aditivas/nullable, header comentado, decision code H46, aplicar via MCP + arquivo.

| Migration | Dono | Conteúdo |
|---|---|---|
| **00119_group_contacts_cache.sql** | §2 | Tabela `group_contacts` (cache local) + índices `(location_id) WHERE NOT archived`, `UNIQUE(location_id, jid)`. |
| **00120_outbound_media_columns.sql** | §5 | `media_id`(FK rep_media)+`media_type` em `followup_messages` e `bulk_message_recipients`; `media_id` em `draft_steps`. |
| **00121_rep_media_library.sql** | §5 | Tabela `rep_media` + índices + RLS deny-anon. (Bucket `agent-media` reusado, sem migration de bucket.) |
| **00122_group_cockpit.sql** | §4 | `bulk_message_recipients`: `is_group boolean DEFAULT false`, `label text`, `paused_at timestamptz`, `edited_at timestamptz`, `edit_count int DEFAULT 0`; índice parcial `(contact_id, status, scheduled_at) WHERE status='pending'`; COMMENT da virada de semântica do `target_type` (rótulo, não gate). `group_targets`/`target_jid`/`stevo_instances.kind` ficam (COMMENT "deprecated H46"), **não dropados**. Backfill defensivo `is_group=true WHERE target_jid IS NOT NULL` (no-op em prod). |

`recurring_campaigns.group_targets` muda de shape (jsonb, sem DDL): `[{contact_id, name, jid?}]` — COMMENT.

**Flag:** `GROUP_CAMPAIGNS_V2` (default OFF / log-first). `config.ts` → `isGroupCampaignsV2Enabled()`. `tools/index.ts:69` troca `isGroupCampaignsEnabled()`. `admin/cron-health/route.ts:29` renomeia chave. `.env.example` documenta (`+ RECURRING_CAMPAIGNS_ENABLED=1` p/ recorrência). Flag `REP_MEDIA_ENABLED` separada (captura pode ligar antes).

---

## 8. Fases de rollout (cada uma validável isolada, flag OFF)

### F0 — Pré-requisitos & probes
- ✅ **Decisões do Pedro (2026-06-28) baixadas:** número = o do DM (ban aceito+avisado, sem dedicado); contato-grupo criado automático pelo Stevo (persiste no GHL); áudio sai em `.wav`; billing 1 grupo=1 contato ok.
- Probe ao vivo: `scripts/probe-group-contacts-live.ts` — lista contatos-grupo do Matheus por `email contains @g.us` na location `RkFnbOYKJvJfBEaU1ycO` (valida `gqN8…` aparece).
- **Validar `RkFnbOYKJvJfBEaU1ycO` tem linha em `locations` com `company_id`** (senão auto-heal vira pré-req do send).
- Probe áudio outbound **`.wav`**: `scripts/probe-rep-audio-outbound.ts` (§5.6) — inclui transcode `.ogg`→`.wav` se o áudio vier do WhatsApp.

### F1 — Detector + descoberta + cache + envio de texto via GHL
`group-contacts/detector.ts` (puro) + `sync.ts` (cache) + migration 00119. `list_groups` lê cache. `group_campaign action:'schedule'` monta `bulk_message_jobs target_type='groups'` (rótulo) + recipients `contact_id`=ID GHL real + `is_group=true`. Runner entrega via rota GHL existente (sem branch). Opt-out/DND/cooldown pulados por `!recipient.is_group`. Auto-heal de `locations` no sync.
**Saída:** smoke `executeTool('group_campaign',{schedule})` cria job+recipients corretos; probe ao vivo posta texto em 1 grupo real; opt-out pulado.

### F2 — Blindagem de segurança inbound + caps anti-ban enforçados
Gate `@g.us` no `webhook-handler.ts` (opt-out/pause/resposta ignorados p/ grupo). Caps diários ENFORÇADOS (query real) no `schedule`/recurring. Termos ponto 3 reescrito.
**Saída:** membro digitando "sair" NÃO opt-outa o grupo; cap diário recusa o 11º grupo educadamente.

### F3 — Cockpit por-grupo (editar/reagendar/ver/pausar)
Migration 00122. Actions `scheduled_by_group`/`group_schedule` (safe) + `edit_message`/`reschedule` + escopo granular pause/cancel + `paused_at` no claim do runner. Prompt GATED.
**Saída:** smoke edita 1 recipient pending (runner respeita); editar `sending` retorna erro limpo; pause-por-grupo num job multi-grupo funciona (claim exige `paused_at IS NULL`).

### F4 — Pipeline de mídia (inbound→biblioteca→outbound)
Migrations 00120+00121. `persistRepMedia` no parse + `/api/sparkbot/upload`. `recent-media.ts` no runtime context. Runners mandam `attachments:[signedUrl]`. Materializer copia `media_id`. Tools `list_rep_media` + `media_id` em `add_step`/`schedule`. GATED `REP_MEDIA_ENABLED`.
**Saída:** rep manda imagem → aparece em `list_rep_media` → agenda no grupo → grupo recebe arquivo NATIVO. PDF idem. Áudio só se probe F0 verde.

### F5 — Recorrência por-grupo + anti-contaminação + retirada do H40 + paridade
Reescrever branch de grupo no `recurring-runner` (contatos, não JID). Filtro `email not_contains @g.us` em `search_contacts`/`get_contacts_filtered`/targeting F27. Deletar Stevo-direto (§3.4). `GROUP_CAMPAIGNS_ENABLED`→`V2` nos 3 call-sites. `.env.example`. Gate de paridade documentado. Reescrever `test-group-campaign.ts`. Deletar `probe-stevo-groups.ts`.
**Saída:** `grep -rE 'sendGroupText|listStevoGroups|getStevoInstanceForRep' src/` = 0; recorrência de grupo gera job filho diário sem colidir UNIQUE; contato-grupo não aparece em busca lead-facing; tsc/build/parity verdes.

### Para ligar em prod (👤)
`GROUP_CAMPAIGNS_V2=1` (+ `RECURRING_CAMPAIGNS_ENABLED=1`) + `REP_MEDIA_ENABLED=1` na Vercel + validar 1 caso real (Matheus) + avisar.

---

## 9. Riscos & decisões pendentes do Pedro (👤)

| # | Severidade | Item | Resolução / pendência |
|---|---|---|---|
| 1 | ✅ | **Número que entrega no grupo** | **RESOLVIDO (Pedro 2026-06-28): é o MESMO do DM.** Ban aceito + avisado ao rep (como no bulk). Sem número dedicado. Mitigação = caps + pacing + variação + Termos. Design pula `ensureContactAssignedTo` p/ grupo. |
| 2 | ✅ | **Quem cria/sincroniza o contato-grupo** | **RESOLVIDO (Pedro 2026-06-28): criação AUTOMÁTICA via integração do Stevo; o contato persiste normalmente no GHL** (não some quando o grupo muda). Sem criação manual. Resta tratar o send-fail legível se o grupo for deletado no WhatsApp mas o contato persistir (GHL aceita, Stevo dropa) — marcar recipient `failed`. |
| 3 | 🟠 | **Opt-out auto-destrutivo** | RESOLVIDO no design (gate `@g.us` no webhook, F2). É bloqueador de implementação, não de decisão. |
| 4 | 🟠 | **Áudio outbound não provado** | RESOLVIDO por probe F0. Se falhar → fallback documento ou fora do MVP. |
| 5 | 🟠 | **`locations` não-sincronizada quebra o send** | RESOLVIDO: auto-heal vira pré-req (F0/F1). Validar Matheus ao vivo. |
| 6 | ✅ | **Contaminação lead-facing (type=lead)** | RESOLVIDO no design (filtro `not_contains @g.us`, F5). **Pedro ciente (2026-06-28): cada grupo = 1 contato no billing GHL — ok.** |
| 7 | 🟡 | **`group_members` (participantes)** | **FORA DO MVP** (GHL não expõe). **👤** confirmar ok. |
| 8 | 🟡 | **Retenção de mídia (LGPD)** | `expires_at` + cron de limpeza desenhado, implementação follow-up. |

---

## 10. Testes

**Unit puros:**
- `detector.test`: `isGroupContact` (email `@g.us` ✓ certain; nome "...GRUPO" ✓ likely sem jid; placeholder phone não basta; contato normal ✗; `@s.whatsapp.net` ✗).
- `materializer`: cópia de `media_id` step→msg; `message_text` LIMPO (sem URL).
- Agregação `scheduled_by_group` (agrupar por grupo).
- `clampGroupInterval`/`dailyTimeToCron`/`computeNextRunAt` (existem — reusar).
- Caps anti-ban (query mock de recipients sent hoje).

**Smoke via `executeTool` (mock GHL)** — espelha `smoke-task-orchestrator.ts` (18/18): schedule → conta jobs/recipients; `edit_message` de pending; `reschedule`; `attach media`; `scheduled_by_group`; pause-por-grupo. ⚠️ Garantir test-mode mock ANTES do `/conversations/messages` (não materializar recipients reais que o cron dispare).

**Probe ao vivo (1 grupo real Matheus, `RkFnbOYKJvJfBEaU1ycO`):**
- `probe-group-contacts-live.ts`: descobre por `email contains @g.us`.
- `e2e-group-v2-live.ts` (espelha `e2e-orchestrator-live.ts`): agenda → runner entrega texto no `gqN8…` → confirma inbound/outbound; depois com anexo.
- `probe-rep-audio-outbound.ts`: áudio nativo (§5.6).

**Critérios de saída por fase:** F1 = texto chega + opt-out pulado; F2 = "sair" não opt-outa + cap recusa; F3 = editar pending muda entrega, editar em-voo barrado, pause-por-grupo OK; F4 = arquivo nativo entregue; F5 = zero refs Stevo-direto + sem contaminação + paridade documentada + verdes.

**Reescrever** `test-group-campaign.ts` (hoje 43/43) pros novos invariantes (detector `@g.us`, montagem `target_type='groups'`+`is_group`+`contact_id` real, edição pending, skip opt-out por `is_group`, mídia). Asserts de `sendGroupText`/`kind='dedicated'` saem.

---

## Arquivos-âncora (paths absolutos)

- Tools a reescrever: `/Users/pedropoleza/conductor/workspaces/AI platform/missoula/src/lib/account-assistant/tools/group-campaigns.ts` (`:52-88` resolveDedicated, `:110-143` resolveGroups, `:393-395`, `:456-546` scheduleOneShot, `:507` contact_id=g.jid→real, `:548-626` recurring)
- Runner (deletar/editar): `.../src/lib/account-assistant/proactive/bulk-message-runner.ts` (`:201-217`, `:237`, `:323`, `:737-738`, `:758-770`, `:785-790`, `:827-856`)
- Recorrente: `.../src/lib/account-assistant/proactive/recurring-runner.ts` (`:217`, `:226-297`, `:271` contact_id=g.jid→real)
- Materializer: `.../src/lib/account-assistant/task-orchestrator/materializer.ts` (`:60-64`, `:159-166`)
- Followup send: `.../src/lib/account-assistant/proactive/followup-runner.ts` (`:207` DND, `:338-360` send, `:347-350` company_id)
- Envio GHL reusável: `.../src/lib/ghl/operations.ts` (`:708`, `:741`, `:111` ensureContactAssignedTo)
- Signed-URL canônico: `.../src/lib/ai/reaction-engine.ts` (`:206-214`)
- Stevo-direto a deletar: `.../src/lib/account-assistant/webhook/stevo-groups.ts`; `.../src/lib/repositories/stevo-instances.repo.ts` (`:106-134`)
- Opt-out/inbound: `.../src/lib/account-assistant/proactive/optout-detector.ts` (`:143`, `:166`); `.../src/lib/account-assistant/webhook-handler.ts` (`:75-76`, `:136-137`)
- Descoberta: `.../src/lib/account-assistant/filter-engine/capabilities.ts` (`:77` email contains server-side, `:78` ends_with client-side); `.../src/lib/account-assistant/tools/contacts.ts`
- Config/flag: `.../src/lib/account-assistant/group-campaigns/config.ts` (`:17`, `:23-43`); `.../src/lib/account-assistant/tools/index.ts` (`:69`); `.../src/app/api/admin/cron-health/route.ts` (`:29`)
- Termos: `.../src/lib/account-assistant/group-campaigns/terms.ts` (`:171`); `.../src/lib/account-assistant/processor.ts` (`:210`, `:224-227`)
- Captura inbound: `.../src/lib/account-assistant/webhook/input-parser.ts` (`:38-54`, `:111`); `.../src/lib/ai/audio-transcriber.ts` (`:106`); `.../src/app/api/sparkbot/upload/route.ts`
- Migrations base: `.../supabase/migrations/00113_group_campaigns.sql`, `00116_agent_media_bucket.sql`, `00118_locations_deauthorized_at.sql` (última real); novas 00119-00122
- Testes: `.../scripts/test-group-campaign.ts` (reescrever), `probe-stevo-groups.ts` (deletar), `e2e-orchestrator-live.ts`/`smoke-task-orchestrator.ts` (espelhos)
