# Finalização pré-launch — 2026-06-11 (madrugada)

**Método:** workflow `launch-final-review` (24 agentes, 2.3M tokens): reconciliou as 10 pendências do deep-review contra o main pós-fixes (016cc92 deployado) + varreu 6 áreas não-revisadas com lente launch-blocker + verificação adversarial. Em paralelo: checklist operacional (envs Vercel, crons, token, signals, wallet).

**Resultado da reconciliação:** 2 pendências FECHADAS (F47 followup-dedup já estava fixado em 2c38980; queue-claim era falso-positivo do review — claim é atômico, 282/282 msgs ok em 7d), 8 seguem abertas mas **só 1 achado novo bloqueia o núcleo**.

---

## 🔴 BLOQUEIA O AR (fazer antes do launch)

### 1. IDOR cross-tenant no `ui-auth` / `check-admin` (P1, blocks_core_launch, confirmado adversarialmente)
`src/app/api/agents/ui-auth/route.ts:68-105` — o caminho Firebase valida só `user_id`+`company_id` do idToken e **ignora o `locationId` do body** → emite JWT escopado em QUALQUER location. Qualquer user GHL (de qualquer agência) com o próprio idToken consegue token da location de uma vítima e chama os writes `contact-pause`/`contact-activate` (silencia/toggla agentes de contatos da vítima; writes puro-DB, funcionam cross-company). `check-admin/route.ts:101-118` tem o mesmo padrão. Mitigantes: exige `contactId` real (24 chars, não-enumerável); reads GHL cross-company falham.
**Fix (~horas):** exigir `claims.locations?.includes(locationId)` (o idToken já traz; `ghl-idtoken.ts:71` — hoje zero consumidores) e, se ausente, cair em `validateGHLUser` fail-closed (mesmo padrão do cookie SSO). Nas 2 rotas. Bônus: alinhar `isAdminClaims` (remove `type==='account'`) com o fix do sso.ts.

### 2. Dedup do webhook lead-facing está MORTO (trivial, ~30min, alto valor)
- `inbound-message/route.ts:733` lê `body.id`, mas o GHL manda `messageId` → `ghl_message_id` é **sempre null**.
- O índice UNIQUE da migration 00021 **não existe em prod** (drift — verificado em pg_indexes).
- Consequência HOJE: em toda conta com 2 apps, o texto do lead entra **duplicado no prompt** ("oi\noi"); dupla-resposta fica latente (entrega atrasada >17s, falha do push de debounce, reaper pós-crash).
- O smoke de hoje colapsou em 1 resposta por mecanismo determinístico (debounce alinha `process_after` + claim único + group-by) — mas o dedup de verdade é necessário.
**Fix:** `(body.messageId || body.message_id || body.id) || null` (paridade com webhook-handler do SparkBot) + `CREATE UNIQUE INDEX ... ON message_queue(ghl_message_id) WHERE ghl_message_id IS NOT NULL` em prod + arquivo de migration.

### 3. Wallet sem fundos — location `qz19EgcgJfyjdVg8krSz` (decisão de negócio)
Reps **Sieder Madrona** (usando agora), **Andrea Saraiva**, **Ailton Junior** — todos `is_internal=false`, wallet sem saldo → 70 charges falhados, $1.97 acumulado, billing-retry re-tentando a cada 5min sem desistir. Bot continua respondendo (by design). **Decidir: carregar a wallet OU marcar os reps como `is_internal`.**

---

## 🟡 NÃO bloqueia — primeiros dias pós-launch (P1s confirmados)

| Item | Resumo | Esforço |
|---|---|---|
| F51 race residual | Janela 0.3-5s entre POST e INSERT do execution_log; só morde com `auto_pause_on_human_message=true` (opt-in; **Alves Cury usa**). + Gap novo: textos do `reaction-engine` nunca entram no corpus anti-eco → pausa permanente | horas |
| update/delete_appointment | Não validam dono do appointment (viola D1; exploit trivial via conversa). Espelhar `checkBlockSlotPermission` de b265b49 | horas |
| reminder-runner órfão | Claim `running` sem reaper — série recorrente morre pra sempre se a lambda cair; invisível (list/cancel filtram pending). Espelhar 00102/H37 do bulk | horas |
| Stevo poller | Proativos stevo-direct gravam `ghl_message_id=null` → invisíveis pro poller (modo exato do incidente 2026-05-06). Persistir ids + canary de instância no cron | horas |
| Coherence gate (F54) | Loop-breaker OK (0 travadas em 316 turns), mas 100% dos samples de signal são falso-positivo; caso de HOJE criou lembrete duplicado. 3 fixes cirúrgicos (regex acento, contexto pipeline, claim retrospectivo) | horas |
| Webhook lead-facing sem auth | GHL não manda HMAC → endpoint público aceita forge (limitado por contactId não-enumerável + cost-cap). Stopgap: token secreto em query-string da URL do webhook | horas |
| KB: URL silenciosa | Fetch que falha (qualquer redirect!) grava a URL crua como "conteúdo" e devolve 201 | trivial |
| KB: cap mente | UI diz 15MB; Vercel corta em 4.5MB com erro opaco (testado em prod). Baixar cap pra 4MB com mensagem honesta | trivial |
| Carrier KB → lead | Bibliotecas internas (comissão/contatos/scripts) injetáveis em agente lead-facing se admin ligar o toggle. Esconder toggle pra lead OU exclude-list de categorias | trivial/horas |
| Multi-touch sequences | **NÃO ligar `BULK_SEQUENCES_ENABLED`** antes de fixar `refreshJobCounters` (job completa no step 1, steps 2+ nunca disparam). Wizard expõe o toggle sem aviso | horas |
| Flags com `\n` | `RECURRING/SEQUENCES/OUTREACH` setadas `"1\n"` na Vercel → comparação `!== "1"` falha → **efetivamente OFF** (runner_health confirma no_op). Pro launch é o estado certo; regravar os valores quando for ligar | trivial |
| customFieldId no payload | Top-level em vez de dentro do filtro; path nunca exercitado em prod (0 execuções), falha ruidosa. Pós-launch | horas |
| Cron URLs hardcoded | Jobs 8/10/11 com URL+secret hardcoded vs `cron_config` (job 12 já parametrizado) | trivial |
| Deadman /api/health | Falta flag "token de agência não atualiza há >X h" (P0-5 parte b) | horas |

## ✅ O que o review CONFIRMOU pronto
- **Pipeline lead-facing núcleo**: roteamento ativo-first, anti-eco F56, dedup de processamento determinístico, claim atômico, smoke E2E limpo em prod.
- **Prompt-injection (lead)**: ação em OUTRO contato impossível por construção (AIAction não tem contact_id); booking validado server-side pelo CRM; KB isolado por agent_id; custos bounded (truncs + caps). Riscos residuais = P2 de 1 DM.
- **Auth geral**: cookie SSO fail-closed; rotas por sessão escopadas; JWTs verificados (HS256/RS256+JWKS). O buraco é SÓ a emissão no caminho Firebase (item 1).
- **F47** (followup dedup) já fixado; **queue-claim** era falso-positivo.
- **Ops**: crons 8/8 sem falha 24h; token de agência fresco (37min); envs completas; Sentry configurado.

## ⚠️ Não-coberto (3 agentes morreram por session limit)
- `billing-leak` (sweep) — coberto parcialmente inline: wallet encontrada; bot não quebra com charge falho (by design). Custo LLM de lead-agent: não-auditado nesta rodada.
- `campaigns-live` (sweep) — parcial: flags efetivamente OFF; single-shot teve P0-1/opt-out/quiet-hours fechados. Rodada dedicada antes de liberar bulk amplo.
- Verify do finding "KB URL silenciosa" — evidência concreta (arquivo:linha), tratado como real.

## Veredito
**GO condicional pro núcleo** após fechar **itens 1 e 2** (~2-3h) + decisão da wallet (item 3). Manter flags de bulk/sequences/recorrentes como estão (OFF), sem swap de app GHL. Os 14 itens da tabela são a fila dos primeiros dias pós-launch, em ordem.
