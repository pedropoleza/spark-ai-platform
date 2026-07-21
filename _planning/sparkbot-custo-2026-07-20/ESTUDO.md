# ESTUDO — Custo/tokens do SparkBot + auditoria de billing (2026-07-20)

> Pedro 2026-07-20: "estudo geral completo de como reduzir o custo... conferir também se o billing está correto... lance um exército de agentes". Caso âncora: Opta Finance (Andrea Saraiva/Sieder Madrona), $83/30d, resumo matinal $0,17, ações $0,20-0,37.
> Método: 31 agentes (6 lentes especialistas → verificação adversarial de cada achado top → crítico de completude). 22 achados sobreviveram; 2 foram REFUTADOS na verificação (registrados abaixo — tão importantes quanto os confirmados).
> Resultado bruto completo: journal do workflow `wf_fd90720f-dd4` (sessão 2e04f4af).

---

## 1. VEREDITO DO BILLING (a pergunta central)

**Não há sobre-cobrança. Há o OPOSTO: sub-cobrança sistemática e margem NEGATIVA.**

- 30d: custo real de provider ≈ **$573-581** (os $551 de `usage_records` + ~$32-58/mês de cache-write TTL 1h não computado) vs coletado líquido ≈ **$495** ($521 no wallet × 0,95 de fee GHL) → **net ≈ −$80/mês**.
- O markup de 10% não cobre nem o fee do GHL (~5%) + falhas de cobrança. A reclamação de "caro" NÃO procede como cobrança indevida — **o preço reflete MENOS que o custo real. O problema a atacar é o CUSTO.**
- Auditado SEM furo (nenhuma sobre-cobrança): Whisper ($0,006/min + markup ✓), Vision (tokens de imagem já em input_tokens ✓), idempotência eventId ✓, Max Price $5 (máx charge foi $0,87) ✓, cap mensal (0 acionamentos) ✓, custom-key sem dupla cobrança ✓.

### Os 3 furos de repasse (todos sub-cobrança)

| # | Furo | Tamanho | Fix |
|---|------|---------|-----|
| B1 | **TTL 1h cobrado a 1,25× quando a Anthropic fatura 2×** ($6/M vs $3,75/M no sonnet). `processor.ts:590` seta `cacheTtl:"1h"` em todo inbound; `llm-client.ts:490` ignora o split `ephemeral_5m/1h` do SDK; `pricing.ts` tem um único `cacheWriteInput`. | ~$56-63/mês de custo Anthropic invisível ao `cost_usd` (e ao repasse) | **Reverter pra 5m** (1 linha) — ver D1: o 1h é NET-NEGATIVO de qualquer jeito |
| B2 | **`claude-sonnet-5` fora do TOKEN_PRICING** → DEFAULT gpt-4.1-mini (5,5-8× abaixo). 3 agentes ativos (Bruna/Bruno Alves Cury, Raquel). Bônus: `claude-opus-4-6` está 3× ERRADO pra cima ($15/$75; real $5/$25). | ~$4/mês hoje; escala com a adoção; opus sobre-cobraria se usado | Adicionar sonnet-5 (intro $2/$0.20/$2.50/$10 até 31/08 → $3/$0.30/$3.75/$15), corrigir opus-4-6, adicionar opus-4-8/4-7; **promover o `console.warn` do DEFAULT a admin_signal** |
| B3 | **$85 de pendências** (1.305 recs): ~$62 nas 2 wallets sem saldo (7pXJ $32 + b1tt $29,54 há 3 sem) + $15,49 em claims órfãos que o retry NUNCA recupera + ~$4 espalhados. H52 já estancou o vazamento novo (run-rate residual ~$5-20/mês); 7pXJ recarregou hoje e o retry drenou $11,91 sozinho. | $85 one-time + ~$20/mês residual | Reaper de claims órfãos (claimed_at>1h e charged_at NULL → soltar); cobrar b1tt (dona NUNCA foi notificada — `wallet_block_notified_at` NULL, o aviso só dispara no gate lead-facing); `charge_fail_reason` no retry |

Menores: 4 caminhos LLM sem `trackAndCharge` (sequence-generator Sonnet, conversation-summarizer, bulk-variator, embeddings Voyage) ≈ $3/mês; gpt-4.1-nano do compressor e Voyage NÃO aparecem em usage_records (classe do mesmo furo do sonnet-5: serviço novo entra e cai fora do metering em silêncio).

---

## 2. ANATOMIA DO CUSTO (o que os $551/30d são)

- **96% do custo é Sonnet 4.6.** Decomposição: cache-WRITE $240 + cache-READ $176 = **76% do custo é mecânica de cache re-lendo/re-escrevendo prefixo**; fresh $84; output só $28.
- **H44 Fase 1 FUNCIONOU e o volume comeu o ganho**: custo/turno −23% ($0,144→$0,110) e write/turno −58% no degrau exato do deploy (~25/06); mas turnos +37%/5 semanas (724→995/sem) → conta semanal $102→$143. **Sem tiers de modelo, o custo escala linear com a adoção.**
- **Estrutura mudou: cache-READ é o maior componente (48%)** desde a semana 29/06. A alavanca dominante agora é encolher o PREFIXO, não o write.
- **Calibração corrige o mapa do H44**: o prefixo real (tools+system) é **~40-76K tokens, não 22-25K** (cold-writes clusterizam 64-80K; zero turnos no bucket 18-36K; bloco de tools sozinho ≈ 31-35K tok = ~48% do prefixo com **108 tools** em prod, não 93 — o task-orchestrator ligado soma 15). Turno médio faz **~2,4 chamadas LLM (p50 2, p90 4), não 6-8**. ⚠️ As lentes divergiram (40K vs 72K) — **instrumentar 1 turno real (logar payload por chamada) antes de cravar a Fase 2** (é a 1ª ação do plano).
- **Caso Opta Finance ($83)**: 94% do uso é do **Sieder** (1.367 de 1.458 msgs; Andrea: 91), ~21,5 interações/dia a $0,107/turno. Não é desperdício de "quase não usa" — é heavy-user pagando turno caro. Resumo matinal = $0,16/dia × 2 canais... (11 runs/$1,86 nos 30d dela).
- **Resumo matinal (todas as contas)**: 126 runs/24 locations = $19,22/mês com **cache_read=0 em 126/126** — estrutural: cadência 24h > TTL máx 1h; **nenhum fix de cache resolve**; 95% do custo é write premium jamais lido. Pós-reunião (Haiku): $21,72/mês, prompt subiu pra ~82K/run (carrega o prompt INTEIRO do SparkBot pra gerar 1 frase).
- **Lead-facing**: $99,5/30d e crescendo ~10× em 5 semanas. `LEAD_CACHE_OPTIMIZED` está **LIGADA desde ~01/07** (memória do projeto estava stale) — custo/turno já caiu 40%. Headroom restante: hit 45% vs 91% do SparkBot (~$10-15/mês) + roteamento Haiku (~$15-25/mês). Pipeline lead-facing NÃO foi dissecado como o SparkBot (lacuna declarada).
- **Zero-tool turns**: 26% dos turnos (867/mês) não chamam tool nenhuma e custam $69/mês carregando o catálogo inteiro — mas amostragem mostrou que a maioria é MEIO de fluxo (desambiguação, "sim" de H8), não small talk; roteamento tem que ser conservador.

---

## 3. PLANO DE REDUÇÃO (deduplicado pelo crítico — economias contadas UMA vez)

> Ordem por impacto÷(esforço×risco). Total realista: **~$150-250/mês de corte** sobre ~$550-600 + ~$60/mês de furo estancado + $85 one-time. Regra de ouro em TUDO: set de tools/prompt **estável POR CONVERSA** (mudar no meio = cache-miss total).

### Onda A — Quick wins (dias, risco ~zero)

| # | Ação | $/mês | Notas |
|---|------|-------|-------|
| A1 | **Reverter F4: TTL 1h → 5m** (`processor.ts:590`, 1 linha) | ~$60 (furo B1 zerado + ~$7 de custo real) | Verificado: 18% dos gaps são >1h (frios de qualquer jeito) vs 10% na janela 5-60min → o 1h é net-NEGATIVO. Decisão A-ou-B: se preferir manter 1h, tem que ler `ephemeral_1h` do SDK e cobrar $6/M (esforço maior, ganho menor) |
| A2 | **present_options como tool terminal** no loop (`llm-client`/`processor.ts:916`) | ~$27-30 | A chamada LLM seguinte (~76K tok, 683×/mês) é DESCARTADA pelo processor hoje. Guardas: só quando payload interativo é válido (15/682 inválidos usam o texto do LLM) e quando é a única tool do bloco |
| A3 | **pricing.ts**: sonnet-5 + opus-4-6 corrigido + opus-4-8/4-7 + admin_signal no DEFAULT (furo B2) | ~$4 (estrutural) | 30 min |
| A4 | **Resumo matinal → Haiku 4.5 + Batch API, SEM cache_control**; follow-ups agendados idem | ~$24 ($28→$4) | Batch = 50% off confirmado, stacka com cache. Submeter de madrugada + fallback síncrono; follow-up re-valida pause-on-reply antes de enviar. Pós-reunião no Batch = +$10,8 opcionais se latência de minutos ok |
| A5 | **disabled_tools no config do hub** com as ~16-18 tools zero-uso seguras (mecanismo existe, 0 uso: 29/29 configs vazios) | ~$10-15 | NÃO desligar: find_flow/apply_saved_flow/get_task_progress/generate_flow_pdf/send_media (biblioteca F7 da Jussara, lançada 29/06) e set_rep_preferred_name (caso Manuela). Lista segura: count_filtered, bulk_request_cap_override, bulk_edit_pending_job, bulk_cancel_all, switch_active_location, set_verbosity_preference, bulk_reschedule_job, delete_opportunity, get_bulk_job_progress, forget_rep_alias, list_my_locations, list_rep_aliases, bulk_resume_all, get_task, get_note |
| A6 | Fix da contradição do prompt: linha 160 ("TTL 30 min" — a ALUCINAÇÃO que o H49 proíbe na linha 479) + header "~43 tools"→108 | 0 (qualidade) | 2 linhas; remove a semente da mecânica inventada do caso Jussara |
| A7 | Cobranças: reaper de claims órfãos + notificar dona da b1tt + `charge_fail_reason` (furo B3) | $85 one-time + ~$20 residual | |

### Onda B — Fase 2 do H44 recalibrada (semanas, eval por etapa)

Pré-requisito: **B0 = instrumentar 1 turno real** (logar payload por chamada LLM) pra resolver a divergência 40K vs 76K e medir o baseline. Depois, em sequência, medindo cada etapa com as queries do `baseline-snapshot.md`:

| # | Ação | $/mês (contado 1×) | Risco |
|---|------|--------------------|-------|
| B1 | **Tool-tiering núcleo estável por conversa**: top-30/45 (93-98% dos 6,5K calls/30d) + cauda via **tool search nativo da Anthropic** (`tool_search_tool_bm25` + `defer_loading:true` — schemas descobertos são APPENDED, preservam o prefix cache). A alternativa caseira (expand_toolset re-rodando com catálogo cheio) custaria ~$86/mês em re-writes e come a economia — só o caminho nativo entrega | ~$50-55 | médio (cauda depende do LLM achar a tool; fallback GPT-4.1 não tem tool search → STRICT_CLAUDE_ONLY ou catálogo cheio no fallback) |
| B2 | **Dieta de descriptions**: 14 descriptions >800 chars → 1-3 frases (instrução comportamental fica SÓ na seção do system — fonte única); boilerplate confirmed_by_rep 23×349 chars → 1 linha (o `required` FICA — é load-bearing do anti-loop do fallback); dedup FEL_DOCS (4 cópias) | ~$40-50 (overlap parcial com B1) | médio — validar com test-weekday-guard/override-gate/smoke-task-orchestrator |
| B3 | **Globalizar o prefixo por-rep**: mover CONTEXTO DO REP + MEMÓRIA + **timezone/locale** (senão sobram 4 variantes por fuso) do system pro runtime context (padrão H44-F1) → tools+system byte-idênticos pros 55 reps do hub; 83% dos colds tinham outro rep quente <60min antes | ~$50 | baixo (MEMÓRIA já é "pista") |
| B4 | **Seções condicionais F9 por-seção** (gate único quase não economiza — união dos usuários = 72% dos turnos): BULK V2 (11,7K chars, a MAIOR seção, 0,7% dos turnos), Filter (0,6%), H33 (1,5%), Orquestrador → gate por-rep (4 de 49 reps usam) | ~$32 | médio (condição ESTÁVEL por conversa) |
| B5 | Proativos: F8 (mesmo tool-set do inbound em todas as regras — 12 arrays distintos hoje = 12 prefixos = cache 0) + system compacto (~6-8K) pros nudges one-shot (Pós-reunião não precisa de BULK/Filter/agendamento-admin pra 1 frase) | ~$14-28 | baixo |

### Onda C — Roteamento de modelo (H44 Fase 4 corrigida)

- **Correção essencial que o H44 não previa: cache é POR MODELO.** Turno avulso em Haiku no meio de conversa quente Sonnet sai ~70% MAIS CARO (perde o cache). Rotear **cold-starts e sessões inteiras**, nunca turno avulso.
- Router determinístico conservador (confirmações/saudações puras = só 7,3% das msgs; "sim" de H8 NÃO pode ser misroteado), log-first 1 semana antes de ligar. ~$20-25/mês.
- Novos gatilhos proativos (Ondas 3-5 do H43, ~12 desligados) **já nascem Haiku+Batch** — decisão de custo zero hoje que evita re-otimizar depois.
- **NÃO migrar pra Sonnet 5 por custo**: tokenizer gera ~+30% tokens; intro $2/$10 até 31/08 ≈ neutro, depois +30% de custo real. Só por QUALIDADE. Os 3 agentes em sonnet-5: ou voltar pra 4.6 ou manter cientes (com pricing.ts corrigido).

### Anti-findings (provados NÃO valer o esforço — não re-derivar)

- **Compressão de história (H44 Fase 3) NÃO se aplica ao SparkBot rep-facing**: 30 turnos ≈ só 1,6K tok (conversa curta de WhatsApp). Redirecionar o esforço pro tool-tier.
- **Reruns coherence/anti-repeat**: 0,24% dos turnos, ~$0,40/mês. Deixar como está (valor anti-alucinação alto).
- **Caps de tool_result**: já existe cap global 12K chars; fresh inteiro = $46/mês. Ajuste fino, não alavanca.
- **NÃO aposentar `search_contacts`**: é a tool #1 (1.636 calls = 25%, o resolver fuzzy do H45). O trio morto do filter-engine é count_filtered (0)/describe (2).
- 2 achados REFUTADOS na verificação: "wallet-blocked segue consumindo" (FALSO — H52 bloqueia ANTES do LLM; zero records pós-block; o $67 era legado pré-fix) e "LEAD_CACHE_OPTIMIZED desligada" (FALSO — ligada desde ~01/07, ganho já capturado).

---

## 4. GOVERNANÇA (pra o próximo furo não durar 3 semanas)

1. **Reconciliação mensal**: job comparando `sum(cost_usd)` × invoice real Anthropic/OpenAI (drift atual provado: ~8-12%). O furo do sonnet-5 ficou 3 semanas invisível; o do TTL desde 25/06.
2. **Circuit-breaker por CONVERSA/DIA**: único guard hoje é o cap mensal $100/location. Um loop de 200 turnos num dia = $84 sem alarme (caso Fabiana quase foi isso).
3. **Metering universal**: Voyage embeddings e gpt-4.1-nano fora do usage_records; chamadas abortadas por timeout nunca viram record.
4. **is_internal quase nunca dispara**: 1 de 224 rep_identities — revisar a detecção em camadas.
5. Modelo novo em `agent_configs` → checagem automática contra TOKEN_PRICING (signal se DEFAULT).

## 5. Decisões pro Pedro (👤)

1. **A1 (TTL) — reverter pra 5m ou corrigir accounting?** Recomendação: reverter (mais simples, mais barato, elimina o furo).
2. **Marina "[TESTE]"** = 3º maior consumidor ($63/mês). Cliente pagante (renomear) ou piloto (decidir se continua)?
3. Agentes Alves Cury/Raquel em sonnet-5: voltar pra 4.6 (recomendado por custo) ou manter?
4. Preço: NÃO subir markup agora (percepção de caro). Re-medir margem após A1-A7 + Onda B. Alternativa futura: repassar o custo REAL (com TTL correto) já resolve parte da margem.
5. Ondas 3-5 do H43 (proativos): aprovar a regra "nascem Haiku+Batch".
