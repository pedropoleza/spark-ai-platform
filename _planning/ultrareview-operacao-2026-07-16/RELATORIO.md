# Ultra-review de OPERAÇÃO — RELATÓRIO (2026-07-17)

> Workflow multi-agente: **33 agentes** (9 dimensões + 24 verificações adversariais), ~22 min, banco de prod read-only + arquivos locais.
> **75 achados**; dos 24 P0/P1 verificados: 21 CONFIRMED, 1 PLAUSIBLE, 2 REFUTED (a verificação adversarial pegou 2 conclusões erradas antes de chegarem aqui).
> Digest bruto por dimensão: `/private/tmp/.../scratchpad/digest.txt`; resultado íntegro no journal do workflow `wf_79fb90b0-a1b`.

---

## 🔴 P0 — agir agora (4)

### P0-1. Loop bot-a-bot na conta da Fabiana (CONFIRMED, vivo)
O número do agente lead-facing da location da Fabiana (`+15613881520`) foi identificado como REP (identidade fantasma `d23d0501`, criada 07-01). Resultado: o SparkBot manda proativo → o agente lead-facing responde como lead → o SparkBot trata como rep → loop. **112 msgs AI-com-AI só em 07-15** (2 rajadas, cadência ~30s), ativo desde 07-02, último inbound 07-16 18:46. No meio do loop o bot executou ação REAL (agendou mensagem pra Evelisy). O inbound do outro bot reseta o silence-gate → nunca pausa sozinho. Existem 3 rep_identities "FABIANA CAMPOS" duplicadas.
**Fix:** neutralizar a identidade fantasma + bloquear proativos pra esse número (imediato); detector genérico de loop (cadência regular + auto-reply + mesmo par) com pause+signal (médio prazo — mesma família do fix merge-field da Jussara).

### P0-2. Billing vazando: 2 wallets sem fundos, ~$72 acumulados e crescendo (CONFIRMED)
- Location `7pXJZ8WUq0GpVh0Qd2Ew` (Gian, a MAIS ativa da semana): $42.75 não cobrados desde 07-08 (982 records; ritmo ~$200/mês).
- Location `b1ttBRVEnm5joFvP2UXO` (Gustavo): $28.97 desde 06-30 (255 records).
- Sinais irmãos: "Billing: cobrança no wallet GHL falhou" 2.462 occ; erro estoura ATÉ o handler do cron proativo (tick pode morrer no meio).
**Fix:** 👤 cobrar recarga dos 2 clientes; código: retry de cobrança nos records com claim pendente + sinal dedicado "wallet sem fundos há N dias" + isolar a falha de charge pra não derrubar o tick do cron. Decisão de produto: bot continua respondendo com wallet vazio? (hoje sim, por design do cap).

### P0-3. Token OAuth da agência exposto via anon key — 24 dias sem rotação (CONFIRMED)
Tabela "Token Refresher" (projeto Supabase do widget, repo spark-side-bar) com policy `anon read USING(true)`; anon key pública no JS do widget → qualquer um lê o token e controla as ~287 sub-contas. SQL de fix pronto no README do widget. **Só o Pedro executa** (rotacionar OAuth + DROP POLICY + REVOKE). Pendência mais antiga e de maior blast radius do backlog.

### P0-4. Luciano: blackout de 6 DIAS e 8 horas — o caso era muito maior que o conhecido (CONFIRMED)
Última resposta do bot 07-10 04:10 UTC → próxima 07-16 12:00 (resumo matinal). **10 mensagens mortas em 7 dias** (não 3), incluindo a resposta "quente, não dispare pra Contrato Fechado" que completava o disparo dele, 2 "Oi" e "E aí, vai voltar pro trabalho?". Ele voltou com "estava de Férias?" — perda de confiança explícita. usage_records prova: nenhum turno LLM sequer completou. Assinatura geral: **11/11 silêncios da semana têm fluxo bulk pesado pendente no contexto**; zero admin_signal no momento da morte; p99 de latência já é 51,2s (a 9s do precipício de 60s). O guard anti-timeout existente para gracioso no turno N e morre calado no turno N+1 (caso Fabiana: prometeu tag em 26 contatos, "ok", morte).
**Fix (o mais importante de código da review):** deadline absoluto de turno ~55s que persiste resposta parcial honesta + emite admin_signal; checar deadline DENTRO dos loops de escrita em massa; watchdog inbound-sem-outbound. Bônus: destravar o disparo do Luciano na mão (~3 semanas tentando: antes falhava com 422 visível no filtro do segment, depois virou timeout mudo).

---

## 🟠 P1 — bugs reais recorrentes (12)

| # | Achado | Evidência-chave | Fix | Esforço |
|---|--------|-----------------|-----|---------|
| P1-1 | **Termos ignoram aceite digitado** — Willian Poubel tentou ~12x ("1. Aceito ✅", "eu aceito os termos", "1 aceito"), gate determinístico devolveu o mesmo reenvio em <100ms, ele sumiu (churn) | canal web_ui mostra fallback numerado; `parseTermsResponse` (terms.ts:77-80, whole-word na 1ª palavra) não parseia o próprio formato que o bot exibe | reproduzir + corrigir parser; destravar Willian na mão + proativo de re-engajamento; signal quando rep recebe termos 3+× | S |
| P1-2 | **Mensagens longas CORTADAS no WhatsApp** — Andrea recebeu 2 de 4 mensagens, 2× seguidas; bot não sabe. **Causa achada pelo verificador: é o NOSSO cap de 3 bolhas** (`splitResponseIntoMessages`, sparkbot-send.ts:46 `parts.slice(0, 3)`), não limite do Stevo | msgs de 2.106/2.021 chars completas no DB, entrega truncada | subir/remover o cap de 3 bolhas ou avisar o LLM do truncamento; crítico pra output em lista | S |
| P1-3 | **Falsas confirmações seguem sendo o atrito nº 1** — tell "agora sim / de verdade" 12× em 5 reps na semana; caso Nathalia: bot prometeu 3× "lembrete 10 min antes de cada reunião" (feature que NÃO existe), zero linha no DB, rep a 1 passo do churn (proativos dela já pausados) | coherence-gate/anti-repeat pegando diariamente (84+24+20 occ) — guards seguram, LLM insiste | prompt: proibir prometer lembrete recorrente inexistente; médio: implementar `pre_meeting` reminder real; reconquistar Nathalia | M |
| P1-4 | **Agendamento DUPLICADO por confirm duplo** (Caua 2×) — 2 bubbles de confirm vivos → 2 create_appointment; rep: "Você marcou 2 vezes" | turnos 01:38:25 + 01:38:33; padrão repetiu no caso Marcos | dedup determinístico no create_appointment (mesmo contato+calendar+start em ~5min → rejeitar retryable) e/ou invalidar bubble antigo | M |
| P1-5 | **Jussara: 32 conversas seguem PAUSADAS (estoque)** — o fix 2bfd419 previne pausas novas mas não limpa o backlog; 2 leads ativos engolidos AGORA (11 e 10 msgs) | conversation_state reason `auto_pause:human_message:history` | despausar em lote (com ok da Jussara), priorizar YmxiYv2j e 0Wi8VFGT | S |
| P1-6 | **Marina: mesma doença, 81 conversas pausadas** — 43/67 (64%) dos ai_paused da semana; IG all-source="app" sem userId (análogo, literal diferente da Jussara) | detector de merge-field NÃO cobre (msgs humanas não têm merge-field) | validar com Marina se ela assume DMs na mão; aviso-à-dona já cobre daqui pra frente; decidir despause em lote | M |
| P1-7 | **Imagem exótica derruba os 3 tiers LLM lead-facing** — sticker .webp → 400 nos 3 modelos → 3 turnos mortos (batch poisoning); recuperação foi acidental | signal 452933f4; fallback repassa a MESMA imagem quebrada | sanitizar anexo antes do LLM; em 400 de imagem, re-tentar sem o bloco (`[imagem não processada]`) | M |
| P1-8 | **Follow-up zumbi: 11 rows presas em 'processing' pra sempre** — branch `ai_paused_at` faz `continue` sem UPDATE (follow-up-scheduler.ts:303-309); claim só pega 'pending' | 11 rows em prod (oldest 06-21) | marcar cancelled (ou re-agendar com backoff) + limpeza das 11; reaper de claims órfãos >1h | S |
| P1-9 | **Follow-up insiste em contato deletado** — falha attempt por attempt (22 occ "DND falhou": GHL 400 contact not found) em vez de cancelar a sequência | 27 rows failed; irmãos pending refalham dias depois | em CONTACT_NOT_FOUND, cancelar TODA a sequência do (agent, contact) | S |
| P1-10 | **Herança de contato em foco ainda falha DENTRO da conversa** (defeito A do H45, variante inbound) — Melissa: criou "Diego Maia" e 3min depois "não achei o Diego"; Josiana: bot re-buscou "Jason" ignorando a resposta "Sheysson" | proativo grava contact_id mas contact_name=NULL degrada a pista; turnos inbound não gravam | é o H47-F3 (contexto que não se perde) — gravar contact_id nos turnos inbound + injetar "CONTATO EM CONTEXTO" do último contato usado | M |
| P1-11 | **Resolver: typo de 1 letra no meio ainda escapa** — "Nilzete" não achou "Niuzete Fialho" (Dice 0,67 < corte); mesma classe do caso-motivador do H45 | Gian corrigiu a grafia na mão | degrau Levenshtein ≤1-2 no 1º nome → needs_confirm em vez de not_found | S |
| P1-12 | **Alertas push MUDOS** — cron 5min + dead-man heartbeat prontos rodando no vazio; falta 1 secret na Vercel | route.ts:293; TODOS os incidentes desta review dependeram de reclamação de cliente | 👤 Pedro seta `ALERT_TELEGRAM_BOT_TOKEN`+`CHAT_ID` (ou `ALERT_SLACK_WEBHOOK`) — maior ROI-por-decisão do backlog | S |

**Nota (PLAUSIBLE):** o gigante "nenhum agente casou o targeting" (62,5k occ, 40% do ruído) segue vivo na Fivestar, MAS o lead dos samples estava sendo atendido por um HUMANO da conta na mesma janela — não é "lead 100% ignorado". Fica a recomendação estrutural: agregar o sinal por location/dia + aviso-ao-dono quando o MESMO lead insiste 3+× sem match (a versão sistêmica do fix da Jussara).

---

## ✅ Validações positivas (fixes recentes FUNCIONANDO em prod)

1. **H50 weekday-guard VALIDADO** — Caua marcou 15 reuniões pós-deploy, todas no dia certo; a guarda corrigiu 2 bookings ("sábado 19/07"→18/07) e zero reclamação nova. Residuais P2: o LLM ainda erra a data no TEXTO do confirm (3× "sábado 19/07" em 24h — a guarda salva a tool, não o confirm) e turnos seguintes re-narram de memória. Falta observabilidade (nenhum signal quando a guarda rejeita).
2. **H45 contact-resolver VALIDADO** — taxa de "não achei" caiu de 7,0% → ~3,3% (**-50%**) com volume +35%; needs_confirm salvou 2 quase-erros; **zero ação em contato errado** em 14 dias. Neuminha do Luciano = comportamento correto.
3. **H44 Fase 1 VALIDADA** — cache-write **-46%/semana** (27,1M → 14,7M tok) na virada 25→26/06; input não-cacheado/turno -60%. A validação pós-deploy 👤 pode ser dada como feita.
4. **Job 8d622ac4 (H49): JÁ RESOLVIDO** — cancelado em 07-10 com motivo auditado; Jussara retomou 07-16 com 3 jobs novos 42/42 enviados. (CLAUDE.md/contexto estavam stale — a verificação adversarial pegou.)
5. **Guards do H49 disparando como projetado** (bloqueio honesto planilha→disparo); nenhuma regressão dos deploys 07-14/15/16 no funil de sinais.
6. **Alves Cury: Bruna/Bruno estão ACTIVE desde 07-15** — memória dizia "inactive aguardando cutover". ⚠️ Confirmar se o cutover foi intencional e o N8n foi desligado. Bug menor: Bruno pulou o mesmo lead 4× (regra message-contains com o texto EXATO do anúncio — lead que escreve com as próprias palavras é ignorado).
7. **Motores agendados saudáveis** — 0 scheduled_tasks vencidas; orquestrador H41 em dia; pause-on-reply ok; resumo matinal RODA normal (achado de "cobertura irregular" foi REFUTADO — artefato de query em tabela de estado); pós-reunião 149 sends/8d.

## ❌ Refutados pela verificação adversarial (não agir)

- "Resumo matinal com cobertura irregular 2→6→2→21" — artefato: assistant_alert_state é estado (1 linha/rep), não log. Envios reais: 36 em 8 dias, série estável.
- "Job 8d622ac4 parado há 13 dias com decisão pendente" — cancelado em 07-10 com autorização do Pedro; Jussara notificada.

---

## 💡 Funil de ideias (53 missed_capability abertas — top 5 temas)

1. **Templates/biblioteca de conteúdo reutilizável** — 8 pedidos (o mais pedido E mais recente; extensão natural da Biblioteca de Fluxos F7)
2. **Relacionamento entre contatos** — 6 (vincular cônjuges, merge de duplicados)
3. **Agenda externa** — 6 (Google Calendar sync, Zoom link automático)
4. **Automação por trigger** — 5 (tag→fluxo, vencimento por custom field, handoff SparkBot→agente lead)
5. **Grupos de WhatsApp** — 3 (reps seguem pedindo; H46 aguarda decisão do número)

⚠️ ~40% do funil é duplicata (captura grava o mesmo pedido 2× em segundos) — dedup na captura + fechar duplicatas em lote → ~30-35 pedidos únicos reais.

## 💰 Custo (7d: $152,33 — projeção ~$650/mês, 2,3× o baseline)

- O H44 F1 funcionou, mas o volume explodiu (63 turnos/5 locations → ~1.900/29 em 6 semanas) e o contexto médio subiu (193K tok/turno no SparkBot; cache-read já custa ~$60/7d).
- Turno-monstro de **824K tokens** ($0,49) no topo; top 10 todos SparkBot 241-394K — mesmo perfil dos turnos que morrem nos 60s. Cap de orçamento por turno resolve custo E timeout juntos.
- **Cap de $100/mês vai bater em 1-2 locations até o fim do mês** (7pXJ $47,91 MTD; qz19 $43,97) — decidir antes: subir cap, avisar cliente ou absorver.
- Haiku 5,6% = default deliberado do dispatcher proativo (não é fallback); zero fallback GPT-4.1. 88,9% sonnet-4-6.
- Retomar Fases 2-4 do H44 (tiering) é o único caminho pra meta de ~$130-150/mês.

## 🧹 Higiene de backlog/repo

- **admin_signals:** fechar em lote ~105 (74 erros fósseis + 10 failures + ~20 duplicatas) → backlog cai de 196 pra ~90 (~55 acionáveis). Suprimir na captura: família "IPs únicos" (20 sinais/28k occ) e os 2 gigantes de inbound (viram contador diário). Re-tipar as 2 "ideias" de override (são auditoria). Sinal "inbound MUDO" (2.714 occ): 1 por episódio com cooldown; gap noturno é orgânico.
- **Repo:** branch `fix/3-frentes-onda0-1` 1 commit atrás da main com WIP sobreposto em queue-processor.ts (padrão exato do incidente 07-10→14); migration 00123 untracked (viola regra); `_planning` canônicos fora do git (humanização, activation-model-v2, raquel, SPARKOS-TRANSFER); CLAUDE.md stale em 3 pontos (H35 "pago", H43 pendência do orquestrador, H48 status); branches órfãs com trabalho preso (rep_notes F1; H46 com migrations 00120/00121 COLIDINDO com a main).
- **Churn:** 7 de 33 reps ativos zeraram na semana (~21%) — Willian é bug (termos), Luana merece re-engajamento, consolidar as 3 "FABIANA CAMPOS", Ana Paula a 1 proativo do pause.

---

## 📋 PLANO DE CORREÇÃO PROPOSTO

### Frente A — Decisões 👤 (só o Pedro; minutos cada)
1. Secret de alerta na Vercel (P1-12) — destrava a observabilidade inteira.
2. Cobrar os 2 wallets (P0-2) + política "responder de graça?".
3. Rotacionar token OAuth da agência (P0-3).
4. OK pra despausar Jussara em lote (P1-5) + o que fazer com as 81 da Marina (P1-6).
5. Confirmar cutover Alves Cury (N8n desligado?) — agentes JÁ ativos.
6. Cap $100: subir/avisar/absorver (bate ainda este mês).

### Frente B — Código Onda 1 (sem decisão, alto impacto)
1. **Timeout gracioso ~55s + signal** (P0-4) — o fix mais importante; inclui deadline dentro de loops de escrita.
2. Cortar o loop da Fabiana (P0-1: neutralizar identidade fantasma) + detector de loop genérico.
3. Cap de 3 bolhas do splitter (P1-2) — 1 linha + teste.
4. parseTermsResponse aceita o formato numerado do fallback (P1-1) + destravar Willian.
5. Follow-up: zumbi 'processing' (P1-8) + contato deletado cancela sequência (P1-9).
6. Dedup do create_appointment (P1-4).

### Frente C — Código Onda 2
7. Sanitização de imagem lead-facing (P1-7).
8. H47-F3 herança de foco (P1-10) + Levenshtein no resolver (P1-11) + contact_name no proativo.
9. Prompt anti-promessa de lembrete inexistente (P1-3) + implementar pre_meeting real.
10. Higiene signals em lote + dedup de captura de missed_capability.
11. Higiene repo (CLAUDE.md, migrations, branches, _planning no git).

### Frente D — Estratégico (planos existentes, priorizados por dor viva)
- H44 Fases 2-4 (custo 2,3×; cap por turno resolve custo+timeout).
- H51 ativação Marina (plano pronto, 3 decisões §4/§5 + Frente C 👤).
- Funil de ideias: templates/biblioteca (tema nº 1) → conecta com F7.
- Humanização Ondas 3-5 (12 de 14 gatilhos proativos seguem desligados).
