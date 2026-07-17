# Execução das correções — log e rollback (2026-07-17)

> Autorização do Pedro (2026-07-17): "Pode arrumar todos os pontos e deixar limpo" + decisão de wallet:
> "locations sem crédito → bloquear e falar que o saldo acabou; recarga na wallet do Spark; dúvidas: suporte +1 (786) 771-7077".

## Onda 0 — ações diretas em prod (DB, sem deploy)

### 0.1 Loop bot-a-bot Fabiana — identidade fantasma silenciada
- Alvo: `rep_identities` id `d23d0501-85fa-44f1-8e85-921d6b5a87bb` (+15613881520, location 7pXJZ8WUq0GpVh0Qd2Ew).
- Ação: `terms_accepted_at=NULL, terms_rejected_at=now()` → gate C1 do processor silencia 100% do inbound (`should_send:false`). `proactive_paused_at` já estava setado (silence-gate 2026-07-17 00:03).
- **Rollback**: `UPDATE rep_identities SET terms_accepted_at='2026-07-02 18:03:31.231+00', terms_rejected_at=NULL WHERE id='d23d0501-85fa-44f1-8e85-921d6b5a87bb';`
- Nota: identidades restantes da Fabiana: real `6c9da072` (+13479209661) e dup `576408a4` (+19543369092) — NÃO tocadas.
- Fix estrutural (código, UR-1): telefone de canal lead-facing nunca vira rep no identifyRep.

### 0.2 Jussara — despause em lote das 32 conversas falso-pausadas
- Alvo: `conversation_state` agent `a297dadc-873a-4803-885d-472c65414168`, reason `auto_pause:human_message:history`, paused não-nulo (32 rows, 2026-06-22→07-15).
- Ação: `status='active', ai_paused_at=NULL, ai_paused_reason=NULL, ai_resumed_at=now()` (mesma semântica do resume manual da UI — F52 só re-pausa se humano falar DEPOIS do resume; merge-field detector 2bfd419 já em prod).
- **Rollback**: re-pausar pelos pares (contact_id, ai_paused_at) abaixo:
  0Wi8VFGT@06-22 23:19 · RAdpJRUa@06-23 19:48 · ISuRoAZZ@06-23 23:15 · w52AgByY@06-24 23:04 · bX2blcgg@06-25 13:20 · Ry7ZHX6o@06-25 14:19 · YmxiYv2j@06-25 19:22 · xj0VXYBe@06-26 15:05 · Ef3DKaMQ@06-29 13:28 · 2LlrgDu6@06-29 14:00 · iJRsPp7e@06-29 14:59 · TqG5jYJy@06-29 18:05 · Au8BjnI0@06-29 18:39 · dabLrQfT@06-30 13:03 · dWNxDLHR@06-30 19:47 · vWd4bM8B@07-01 15:18 · 103rAp9q@07-01 15:36 · GT4yA9XZ@07-01 19:43 · 7KFoTVCX@07-03 14:45 · fWK4IxUy@07-03 16:02 · c2eqfKBV@07-05 15:00 · emcXOLrd@07-06 21:03 · aortlJ9J@07-06 22:36 · DCsy3Y6c@07-07 18:23 · zG49WMPJ@07-08 16:30 · D5i4Kda0@07-08 20:30 · xovnB76J@07-09 14:41 · ot4Mezse@07-09 16:47 · WDevMnvu@07-09 19:44 · DDpKpNmz@07-10 01:01 · 0314qxId@07-10 15:45 · upgM2xMc@07-15 17:24
- Marina (81 conversas, location A62s5EQj): **NÃO despausada** — canal IG, agente [TESTE], precisa validação com a Marina (aviso-à-dona do 2bfd419 cobre casos novos).

### 0.3 Willian Poubel — termos destravados
- Alvo: `rep_identities` id `f99a5868-6fd4-44de-897e-337a19b279a8` (terms_accepted_at era NULL, rejected NULL).
- Ação: `terms_accepted_at=now()` (equivalente ao acceptTerms; parser corrigido em UR-2 evita recorrência).
- **Rollback**: `SET terms_accepted_at=NULL`.

### 0.4 Follow-ups — limpezas
- 11 zumbis `status='processing'` com updated_at > 1h → `cancelled` (ids no RETURNING abaixo).
- 147 pending do agente inativo Gian `ad182fb1-08a5-4e2d-aa12-10bce317f870` → `cancelled` (rollback: `SET status='pending' WHERE agent_id='ad182fb1...' AND status='cancelled' AND updated_at >= '2026-07-17T04:00Z'`).
- 12 `followup_sequences` draft sem toque há >7d → `cancelled` + cancelled_reason 'higiene 2026-07-17 (ultra-review): draft órfão >7d'.

### 0.5 admin_signals — higiene em lote (rollback: `WHERE admin_notes LIKE '%higiene 2026-07-17%'` → status='open')
- 79 erros open com last_seen > 7d → `wontfix`.
- 13 failures open idem → `wontfix`.
- Família "IPs únicos" restante open → `wontfix` (ruído conhecido pool GHL; supressão na captura em UR-2).
- 2 "ideias" de override de calendário (083d6694, 7dc2a303) → `triaged` (é auditoria, não ideia; H50 validado).
- NÃO tocados: billing (6c40c1f8, 9d1facc3 — wallet fix em UR-1), inbound MUDO (1ba8b748), targeting gigante (f1bf4b37), structured output (195 occ), sinais novos <7d.

## Resultados — Onda 0 executada 2026-07-17 04:24 UTC ✅

| Ação | Resultado |
|------|-----------|
| 0.1 Fantasma Fabiana silenciada | 1 row (`terms_rejected_at=2026-07-17 04:24:16`) |
| 0.2 Jussara despausada | **32 conversas** → active (F52 só re-pausa pós-resume) |
| 0.3 Willian destravado | `terms_accepted_at=2026-07-17 04:24:20` |
| 0.4 Follow-ups zumbis | **11** → cancelled (10 Marina TESTE + 1 Gian hvCckXeu) |
| 0.4 Órfãos do Gian inativo | **147** → cancelled |
| 0.4 Sequências draft >7d | **12** → cancelled |
| 0.5 Sinais fósseis (error+failure) | **92** → wontfix |
| 0.5 Família "IPs únicos" restante | **6** → wontfix (14 já caíram no lote fóssil) |
| 0.5 "Ideias" de override (083d6694/7dc2a303) | **2** → triaged |

Sinais fechados/triados no total: **100** (backlog open de erros/failures caiu de ~141 pra ~49 vivos).

## Onda 1 + Onda 2 — código (H52), 2026-07-17

Worktree limpa em origin/main (`2bfd419`) — zero contato com o WIP do Alves Cury/H51 do working tree principal.

| Fix | Arquivos | Teste |
|-----|----------|-------|
| Wallet block (decisão Pedro: bloquear + avisar saldo; suporte +1 786 771-7077) | `billing/wallet-block.ts` (novo) + migration 00124 (aplicada em prod) + charge.ts + processor.ts + queue-processor.ts + dispatcher.ts + types | test-ur1-guards (copies/detector) |
| Anti-timeout (LLM call limitada ao budget + deadline por-tool) | `utils/deadline.ts` (novo) + llm-client.ts (Claude+OpenAI) + signal com last_tools | test-ur1-guards (withDeadline) |
| Loop-guard bot-a-bot | `account-assistant/loop-guard.ts` (novo) + processor.ts | test-ur1-guards (9 casos) |
| Splitter sem perda (cap 3→5, excedente fundido) | webhook/sparkbot-send.ts | test-ur2-fixes |
| Termos: aceite numerado/"eu aceito" + signal rep preso | terms.ts + processor.ts | test-ur2-fixes (11 casos incl. regressões LGPD) |
| Follow-up: zumbi ai_paused + contato deletado | queue/follow-up-scheduler.ts | (branch determinístico; cobertura via review) |
| Dedup create_appointment (±2min, bypass allow_duplicate) | tools/calendar.ts | regressões weekday 28/28 · override 25/25 · batch 11/11 |
| Imagem improcessável → retry sem imagem | ai/openai-client.ts | (guard anti-recursão: images=undefined) |
| Resolver: degrau Levenshtein ≤2 | contact-resolver/normalize.ts | test-ur2-fixes (7 casos) |
| Dedup captura missed_capability + prompt anti-promessa de lembrete | tools/identity.ts + prompt-builder.ts | — |

Suites: **test-ur1-guards 23/23 · test-ur2-fixes 27/27 · human-takeover 36/36 · weekday-guard 28/28 · override-gate 25/25 · appointments-batch 11/11 · tsc 0 · next build OK.**
Review adversarial (4 lentes + verificação) rodada ANTES do push — achados/fixes registrados abaixo.

### Review adversarial — resultado (2 rodadas)

**Rodada 1** (4 lentes × verificação, 15 agentes): 8 achados CONFIRMADOS na implementação — os graves: (a) anti-timeout ainda podia morrer mudo (timeout do SDK é POR TENTATIVA e re-tenta; chain de fallback re-ancorava 45s novos); (b) pausa do loop-guard era apagada pelo silence-reset de qualquer inbound (loop re-acenderia diariamente); (c) wallet não cobria o follow-up-scheduler; (d) gate do dispatcher checava location errada com overrideLocationId; (e) loop-guard silenciava power-user no web_ui; (f) dedup de missed_capability sem filtro de location matava o occurrence_count; (g) leads engolidos no bloqueio nunca reprocessados; (h) '1' seco nos termos seguia em loop. **Todos corrigidos.**

**Rodada 2** (2 lentes; verificadores caíram no limite mensal de subagents — verificação final inline): +2 P1 (reruns do coherence/anti-repeat re-ancoravam relógio novo → agora herdam `turnStartedAt+55s`; flag loop_guard sem expiração → decay 48h no threshold + expiração 7d na pausa) e 5 P2/P3 (clear incondicional vs kill-switch; reenqueue com janela +90s/order/skip-se-humano-respondeu; notify com CAS + owner-antes-do-cooldown + await; signal de downgrade primário→Haiku; piso do timeout 2s; gate do follow-up reordenado + teto 30d; termos '1)'/'(1)'; bullets nos termos de grupo). **Todos corrigidos.**

Suites finais: ur1 25/25 · ur2 33/33 · takeover 36/36 · weekday 28/28 · override 25/25 · batch 11/11 · tsc 0 · build OK. Migrations 00124 + 00125 aplicadas em prod.
