# Melhorias — Agente de Vendas Five Star Ricos (location jA6uzx6tONyTeocxw4Cj)

> Pedro 2026-07-21: cliente (dona da Five Star Ricos) mandou vários pontos de melhoria (áudios + prints). Analisar tudo, planejar, depois implementar. **Mais arquivos virão** — este doc é vivo.

## Alvo
- Agente **"Agente de Vendas"** `7c0a72b7-e37c-463d-be56-73b7822a3037` (sales_agent, ATIVO), persona **"Marcia"** (identity_mode human, equipe feminina — "a especialista"). Seguro de vida / benefício em vida. Canais SMS+WhatsApp. Modelo sonnet-4-6, fallback haiku.
- Config: `system_prompt_override` (8,9K chars), `custom_instructions` (524), KB **vazia**.
- Agente de Recrutamento (`42d034e9…`) existe mas está **inactive** — ignorar por ora.

## Transcrição dos 3 áudios da cliente (Whisper, 2026-07-21 ~12:56-12:58)
1. **(12:56)** "Isso foi follow-up... mas tá sem sentido, não tem conversa anterior. Mandou pra cliente que chegou agorinha. Eu já mando o áudio explicando o benefício em vida, então **a última mensagem [bloco pedindo os dados] tem que ficar — não tem necessidade [do bot] mandar outra**."
2. **(12:57)** "Concordo em fazer follow-up, mas não dessa forma. **O follow-up tem que ser simples e direto, só pra cobrar os dados.**"
3. **(12:58)** "Tá bem aleatório — cliente de ontem, do dia 19, e de hoje. **Duas variações de mensagem, mandou pra várias, não só uma.**"

## Prints (6 conversas: Maressa, Meire Cavaletti, Sandy)
Padrão recorrente: opener da equipe (áudio + bloco "O valor muda de pessoa pra pessoa… passa esses dados… ok? 🤗") → lead responde (áudio, provavelmente "quanto custa?") → **o bot responde re-explicando o produto por extenso E re-perguntando a data de nascimento** que o bloco já tinha pedido. Duplicação + mensagem longa.

---

## DIAGNÓSTICO (aterrado no código + prod)

### P1 — Follow-up agressivo e indiscriminado (reclamação #1 da cliente)
- Fonte: `scheduled_followups` (scheduler antigo, `src/lib/queue/follow-up-scheduler.ts`), NÃO o orquestrador H41 (`followup_sequences` tem 0 linhas p/ esse agente).
- Config viva (`agent_configs.follow_up_config` JSONB): `mode:ai_auto, intensity:7, max_attempts:10, min_delay_minutes:60, max_delay_minutes:14400` (10 dias).
- **10 toques agendados de uma vez** por contato (attempt 1→10, de +1h a +10 dias). Prod: 2637 cancelled, 300 pending, 44 sent; **170 contatos distintos** receberam; **36 pending nas próximas 24h**.
- Dispara **após CADA inbound** em conversa `active` (`queue-processor.ts:1349-1362`) → recria os 10 toques todo turno. **Bug F47 ao vivo**: contato `LBioosc…` teve 2 lotes de 10 criados com **91s de diferença** (cancela+recria = churn de 2637).
- 1º toque em **+1h** (`min_delay 60`) → lead que respondeu 1× e não voltou em 1h leva follow-up = "cliente que chegou agorinha".

### P2 — Conteúdo do follow-up: variado/produto em vez de "cobrar os dados"
- Texto NÃO é pré-armazenado (`custom_message` NULL em 100% das linhas) → gerado pela IA a cada envio via `buildFollowUpPrompt` + `processWithAI` (`sales-prompt-builder.ts:1289`). Daí as "duas variações".
- O prompt de follow-up JÁ tem gate "decida primeiro" bom (`[[NAO_ENVIAR]]` se adiou/recusou/última msg foi nossa) MAS o "SE FOR MANDAR" dá latitude ("#1 lembrete leve; #2-3 retome o assunto") → permite re-explicar. Falta a regra da cliente: **1 linha curta, SÓ cobrar o dado que falta**.

### P3 — Bot re-explica e re-pergunta na conversa (duplicação)
- Não é follow-up — é o fluxo principal (`system_prompt_override`). O bot re-explica o produto (que o áudio da equipe já cobriu) e re-pergunta a data que o bloco de intake já pediu.
- O `system_prompt_override` tem "não pergunte de novo dados já informados" mas nada sobre **não empilhar mensagem em cima do opener da equipe** nem **não re-explicar o produto**. A cliente: "a última mensagem tem que ficar, não precisa mandar outra".

### P4 — Dois sistemas de config de follow-up coexistindo (armadilha de clareza)
- Colunas `followup_*` (`followup_default_interval_hours:48, followup_default_sequence_length:2, followup_max_sequence_length:3`) contradizem o JSONB `follow_up_config` (10 toques/60min). **O runtime usa o JSONB** (`queue-processor.ts:1351`). As colunas confundem quem mexe na UI.

### P5 — KB vazia mas o prompt manda consultar FAQ/KB
- `knowledge_base` = 0 linhas, mas o `system_prompt_override` manda "verifique o documento FAQ", "use o knowledge base", "módulo 7". Instrução morta → risco de o bot alucinar que consultou algo.

### P6 — Higiene do prompt
- `custom_instructions` pede "não envie /n nas mensagens" — sintoma de newline mal tratado (o bot mandava `\n` literal). Verificar se ainda acontece.
- Prompt tem seções numeradas fora de ordem (0, 1, 7, 3.2… 8, 8) e um "should_send_message: false" que é contrato do parser antigo — revisar coerência.

---

## PLANO (rascunho — confirmar prioridades + aguardar demais arquivos)

### Frente A — Config desta location (rápido, sem deploy, resolve 70% da dor)
- 🤖 **A1** `follow_up_config`: baixar `intensity 7→3`, `max_attempts 10→3-4`, `min_delay 60→~1440` (24h) — follow-up deixa de cutucar o lead recém-chegado e vira "lembrete espaçado". (valores a confirmar com a cliente)
- 🤖 **A2** `follow_up_config.custom_prompt`: escrever a regra da cliente — "follow-up = 1 frase curta, só cobrar o(s) dado(s) que faltam; nunca re-explicar o produto; se a última msg foi nossa e o lead não respondeu, ficar quieto". (aditivo, não toca código)
- 🤖 **A3** `system_prompt_override`: adicionar regra anti-duplicação — não re-explicar o produto (o áudio da equipe já fez), não empilhar em cima do bloco de intake, responder objeção de preço em 1 linha ("os valores a especialista passa na ligação") + só pedir o dado que falta. Limpar refs a FAQ/KB inexistente.
- 🤖 **A4** Alinhar as colunas `followup_*` ao JSONB (ou zerar) pra não confundir a UI.

### Frente B — Estancamento imediato (decisão 👤)
- 🤖 **B1** Cancelar os **300 pending** (36 nas próx 24h) enquanto ajustamos — para de sangrar agora. Reversível.

### Frente C — Código (melhora TODOS os agentes lead-facing, precisa deploy + review)
- 🤖 **C1** Follow-up não agenda pra lead que só recebeu opener e nunca respondeu de verdade (exigir ≥1 inbound real / back-and-forth antes do 1º toque) — ataca "não tem conversa anterior".
- 🤖 **C2** Fechar o churn F47 de vez (não recriar a sequência inteira todo turno; só (re)agendar o próximo toque).
- 🤖 **C3** Endurecer o "SE FOR MANDAR" do `buildFollowUpPrompt` pra "1 linha, só cobrar o que falta" como default (beneficia todos), mantendo o `custom_prompt` como override.

### Frente D — Aguardando (👤 Pedro)
- Os **demais arquivos** que a cliente vai mandar (mais pontos). Absorver aqui antes de fechar o escopo.
- Confirmar valores de intensidade/intervalo/nº de toques que a cliente quer.

---

## EXECUÇÃO (2026-07-21, Pedro autorizou "faça todas as alterações")

**Estanca-sangramento**: 309 follow-ups pendentes cancelados (37 contatos) — o batch agressivo (10 toques/1h) parou.

**CU-5 — config/prompt (DB, sem deploy):**
- `follow_up_config`: intensity 7→3, max_attempts 10→3, min_delay 60→1440 (24h), max_delay 14400→10080 (7d), + `custom_prompt` = "follow-up 1 linha, só cobrar o dado que falta, sem re-explicar/valores, [[NAO_ENVIAR]] se a última msg foi nossa". Rollback: valores antigos acima.
- `system_prompt_override` (8895→10090 chars): inserida a **REGRA DE OURO** antes da seção "1) Objetivo" — não re-explicar o produto (o áudio da equipe já fez), não reenviar a lista nem re-perguntar dado já pedido, preço = 1 frase deferindo pra ligação, não empilhar em cima do bloco (fica quieto `should_send_message:false`), mensagem sempre curta. Rollback: remover o bloco.
- NÃO mexido: KB do carrier (`national_life_group` ativo, compliance rico), formato de resposta, agendamento — pra não regredir.

**CU-6 — reprocessamento**: 44 leads ACTIVE + recentes (últimos 3 dias) reagendados com a config nova via o código REAL de produção (`scheduleFollowUps`). Cadência verificada: toque 1 em 24h, toque 2 em ~2 dias, toque 3 em 7 dias. Leads velhos (>3d) e handed_off ficaram cancelados (não re-spamear — a queixa da cliente era exatamente o mix aleatório de leads velhos).

**CU-7 — stress test**: workflow multi-agente rodando. Prompt REAL dumpado (system 23,5K chars, regra de ouro presente, follow-up novo presente). 12 personas simulam contra o prompt real + juízes independentes + verificação adversarial + auditoria direta do prompt. ⚠️ Sem key Anthropic local (Sensitive na Vercel → env pull vazio); a simulação roda pelos agentes do workflow (infra Anthropic), fiéis ao prompt real.

**Frente C (código, HELD)**: F47 churn + gate "exigir conversa real antes do 1º toque" tocam `follow-up-scheduler.ts`/`queue-processor.ts` — que estão no WIP do H51 no working tree. Não mexi pra não colidir. Config já resolve o essencial da queixa.

---

## CU-7 — STRESS TEST (69 agentes: 12 personas simulam o prompt real + juízes + verificação adversarial + auditoria)

Rodado contra o prompt REAL (dumpado localmente, sem key — buildSystemPrompt é puro). **Achado crítico que eu tinha deixado passar:** a REGRA DE OURO mandava "fica quieto (`should_send_message:false`)" mas em lead-facing o motor força `should_send_message` SEMPRE true (`buildResponseFormatSection`) → a regra anti-empilhar estava **sabotada no runtime**. Além disso o override do cliente tinha contrato de saída legado (`#Correto`, `meeting_status:agendado`, "sem JSON") brigando com o schema JSON-only.

**Fixes aplicados no override + config (script `patch-fsr-prompt.ts`, 9 edições + 3 SQL de limpeza):**
1. REGRA DE OURO reframada: "responda o MÍNIMO, nunca re-explique/re-liste" (em vez de "fica quieto"). ✅ queixa #1
2. Colisão de preço quando NADA coletado → aponta pro bloco da equipe, não singulariza/re-pergunta a data (raiz literal da queixa #1). ✅
3. **COMPLIANCE DE SEGURO** virou REGRA ABSOLUTA sempre-ligada (nunca prometer aprovação/valor integral/cobertura; não equiparar a long-term-care; não conselho fiscal; sempre "depende da apólice"; avisar redução de benefício) — antes era só flag opt-in na KB atrás de gate. ✅
4. Seções 4/8 legadas alinhadas ao schema (`conversation_status:"booked"`, sem `#Correto`/`meeting_status`/"sem JSON"). ✅
5. `personality.name`: **"Assistente" → "Marcia"** (era frio e contradizia o próprio banimento da palavra "assistente"; o script de negação entregava o jogo). ✅
6. Exemplo de data consistente MM/DD (05/21/1994; era 21/05 invertido). ✅
7. Anti-tique: proíbe reciclar bordões ("certinho"/"na ligação"), corta fillers de robô, limita repetição do nome, varia horários entre msgs. ✅
8. Não re-pedir sobrenome à toa (nome vem do cadastro; não é campo rastreado). ✅
9. `follow_up_config.custom_prompt` reforçado: 1 dado que FALTA (lê os coletados), só `[[NAO_ENVIAR]]` pra silêncio, trata pergunta aberta do lead antes de cobrar. ✅ queixa #2

**HELD (código, precisa deploy + toca WIP do H51) — 👤 flag pro Pedro:**
- **Guarda weekday↔data (H50) NÃO existe pros agentes lead-facing** (só SparkBot). Pra um agente que AGENDA, é risco real de confirmar dia-da-semana errado (classe do caso Manuela). Recomendo portar `weekday-guard.ts` pro fluxo lead-facing.
- Fonte única de "agora" no runtime + filtrar slots já passados (parcialmente artefato do meu fixture, mas vale conferir `buildRuntimeContext`).
- F47 churn + `buildFollowUpPrompt` (marcadores duplos / lista estática) — contornados via custom_prompt; fix de raiz é código.

**Re-verificação (17 agentes) + polimento v3:** as 4 personas críticas passaram (queixa1=ok, compliance=protegido, naturalidade boa em 3/4). Veredito: queixa #1 e #2 resolvidas no caminho principal, compliance protegido. Fechei os PARCIAIS restantes no v3 (config, sem deploy): brecha do follow-up (nada-coletado → aponta pro bloco), exemplos que modelavam os bordões banidos ("certinho"/"Só me confirma"), rota de "quero falar com humano" no SYSTEM (`handed_off`), e linguagem de compliance branda ("não afirme proteção como certa"). Override final 8.895 → 12.339 chars.

## ESTADO FINAL — o que fica de código (👤 Pedro, precisa deploy / toca WIP)
1. **Guarda weekday↔data (H50) pros agentes lead-facing** — não existe (só SparkBot). Risco real de confirmar dia errado num agente que AGENDA. Portar `weekday-guard.ts`.
2. **Handoff real**: adicionei a regra de prompt pro "quero humano" (status `handed_off`), mas a NOTIFICAÇÃO de um humano depende de ligar `handoff_policy.enabled` (hoje false) + definir quem é avisado. Decisão da conta.
3. **`buildFollowUpPrompt` (código)**: os 5 exemplos de silêncio ainda dizem `message:""` em vez de `[[NAO_ENVIAR]]` (inconsistência pré-existente; meu custom_prompt reforça o marcador certo, mas o fix de raiz é código, shared, batch com o H51).
4. **F47 churn** + gate "exigir conversa real antes do 1º toque" — código no `follow-up-scheduler.ts`/`queue-processor.ts` (WIP H51).

Nada disso bloqueia o essencial da queixa da cliente, que foi resolvido em config.
