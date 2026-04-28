# Code Review — Sales / Recruitment Pipeline (2026-04-28)

Escopo: módulos `src/lib/ai/*`, webhook `inbound-message`, processor da fila, crons. Foco em sales_agent + recruitment_agent. Account Assistant fora do escopo.

---

## Resumo executivo

O pipeline está **funcional e razoavelmente sofisticado** para o estágio do produto: turns estruturados nativos (não "LEAD:/AGENTE:" colado), prompt cache pelo separation system/runtime, rolling summarization de histórico, dual-provider OpenAI+Claude, reactions engine com `on_data_field_set` e dedup de disparos, sanitizer mecânico anti-greeting/anti-travessão, fallback de schema strict→json_object, e debounce com upsert de `process_after`. Sinais de maturidade: idempotência por `ghl_message_id` (constraint 23505), retry com backoff exponencial, fail-closed em targeting, opt-out interceptado pré-agente, anti-eco para detecção de handoff humano, request_id correlacionando logs.

**Principais riscos**: (1) `processGroup` em `src/lib/queue/processor.ts` é um monstro de ~600 linhas com responsabilidade misturada — qualquer regressão nesse arquivo é alto risco; (2) `prompt-builder.ts` (998 linhas) injeta um system prompt que pode chegar a 25-40k tokens com KB+feedback+behavior-blocks; o cache hit salva, mas latência de primeira chamada por conversa é alta; (3) **zero testes** — em todo `/src` não há um único `.test.ts`/`.spec.ts`. Para um pipeline com tantos branches (5 níveis de tom × 2 tipos × 4 objectives × N idiomas) isso é um risco real de regressão silenciosa; (4) **race condition latente** em `processMessageQueue`: o "atomic update→select" da linha 57-64 funciona em PostgreSQL, mas o `finally` na linha 130 grava `failed/completed` baseado em `errors > processed` — bug: marca TODO o batch como failed se UM grupo falhou (ver bug #C2 abaixo).

**Principais qualidades**: separação system_prompt (estável) vs runtime_context (volátil) bem feita pra cache hit; turns estruturados em vez de string colada; sanitizer com salvaguarda de "nunca deixar muda"; dispatch de slots fallible com guardrail (`slotsUnavailable`) que impede a IA de inventar horário; granularização do summary note com `segment_number`; opt-out e handoff bloqueando o agente antes de qualquer chamada de LLM (custo zero quando lead diz "STOP").

---

## Pontos fortes

- **Separação system prompt vs runtime context para cache** — `src/lib/ai/prompt-builder.ts:86-115` e `:122-206`. System prompt é byte-exact estável dentro de uma conversa; runtime (data/hora, slots, dados coletados) vai na user message. Implementação correta para `cache_control: ephemeral` no Claude (`openai-client.ts:271`) e prompt cache automático da OpenAI. Comentário em `:80-85` documenta a intenção. Excelente.

- **Turns estruturados em vez de string colada** — `openai-client.ts:30-34, :189-197, :258-264`. Cada turn anterior vira `{ role, content }` byte-exact entre chamadas, maximizando hit rate. Comentário em `:24-29` explica os 3 ganhos (qualidade semântica, menos tokens, cache). Não vi muitos sistemas fazerem isso direito.

- **Estado de turno explícito controlando saudação** — `prompt-builder.ts:122-150`. `priorTurnCount === 0` injeta greeting; turnos posteriores injetam um bloco de regra ABSOLUTA "não se apresente de novo" + lista de palavras banidas + nome do agente. Combinado com `sanitizeAgentMessage` em `openai-client.ts:325`, é defense-in-depth contra o modelo ignorar a regra. Decisão arquitetural certa.

- **Sanitizer mecânico de greeting/travessão** — `src/lib/ai/response-sanitizer.ts:64-104`. Loop com `guard < 15`, vocativo só após match de saudação na mesma iteração (evita comer "Então,"), salvaguarda `length >= 3` pra nunca deixar mensagem vazia. Comentário em `:1-13` explica o design. Sólido.

- **TypeFraming explícito sales vs recruitment** — `prompt-builder.ts:251-279`. Sem isso, com `custom_instructions` vazias os dois agentes geravam conversas idênticas. Comentário `:243-249` documenta que foi exatamente o sintoma reportado pelo usuário. Boa decisão de produto.

- **Granularização sales/recruitment downstream** — webhook `route.ts:182, :255, :401` filtra `.in("type", ["sales_agent", "recruitment_agent"])`; processor `processor.ts:204` idem. Roteamento por `agent_id` exato em `processor.ts:191-208` evita cross-contamination.

- **Idempotência por `ghl_message_id`** — webhook `route.ts:524-531, :545-547`. Webhook retry do GHL com mesmo ID retorna `skipped: duplicate` em vez de duplicar processamento. Constraint 23505 tratado.

- **Fail-closed em targeting** — webhook `route.ts:639-643`. Se GHL falha o `GET /contacts/{id}`, retorna `false` e bloqueia. Nada pior que um agente respondendo a contato fora do targeting.

- **Slots unavailable guardrail** — `processor.ts:438-444`, `prompt-builder.ts:177-181`. Quando free-slots falha após retries, injeta um bloco no runtime instruindo a IA a não inventar horário e prometer voltar. Isso é o tipo de detalhe que separa um sistema profissional de um demo.

- **Anti-eco em handoff detection** — webhook `route.ts:276-310`. Quando `source` do GHL não é confiável, normaliza ambas as strings e compara com últimas 10 mensagens da IA na janela de 90s. Boa heurística.

- **Parse failure loop detection** — `processor.ts:544-586`. Se IA retorna JSON inválido 2x seguidas, pausa a conversa em vez de cuspir "Desculpa, tive um problema técnico" indefinidamente. UX salva.

- **Atomic dispatch em `processMessageQueue`** — `processor.ts:57-64`. `UPDATE ... SET status='processing' ... RETURNING *` em uma operação evita 2 workers pegando a mesma fileira. O comentário `:55-56` documenta a intenção.

- **Behavior-blocks como registry** — `behavior-blocks.ts:55-280`. 4 dimensões × 5 bandas com diretrizes pré-escritas. `bandFromPercent` aplica buckets corretos `<20|<40|<60|<80|>=80`. `prompt-builder.ts:432-446` só injeta blocos quando `pct < 35 || pct > 65` — economiza tokens quando admin não mexeu nos sliders.

- **Reactions engine com dedup** — `reaction-engine.ts:86-105`, processor `:719-753`. `triggered_automations` array em `conversation_state` impede re-disparo. ReDoS guard em `reaction-engine.ts:66-72` é detalhe maduro.

- **Compressão de histórico cacheável** — `history-compressor.ts:43-56`. Se cached summary já cobre os turns antigos atuais, reusa. Só regenera quando `cutoff` avança. `regenerated: false` flag explícita.

- **Channel-aware send** — `action-executor.ts:39-46`, `reaction-engine.ts:30-37`. Mapeia canal pro `type` correto da API GHL (SMS/WhatsApp/IG/Email). 

- **Logs com `req_*` correlation id** — `processor.ts:179-183`. Toda execução tem ID único que aparece em `[Processor req=req_xxx contact=abcd1234]`. Debug fica viável em volume.

---

## Pontos fracos / Bugs

### CRITICAL

- **[C1] Marcar como `failed`/`completed` baseado em `errors > processed` é bug** — `processor.ts:128-133`. O `finally` está dentro do for-each de grupos, mas usa as variáveis acumuladas globais `errors` e `processed`. Se 1º grupo passa (`processed=1, errors=0`), 2º falha (`processed=1, errors=1`), o `finally` do 2º marca como `completed` (porque `errors > processed === false`). Pior: cada grupo lê os contadores no instante final, não no instante do try. **Fix**: usar variável local `groupFailed` capturada no `catch` e marcar `failed` se `groupFailed === true`, senão `completed`. Sem isso, retry de mensagens que falharam no LLM pode nunca acontecer (porque ficaram marcadas como `completed` por engano) ou mensagens OK ficam marcadas como `failed` (passam de novo no próximo ciclo, podendo gerar mensagens duplicadas).

- **[C2] Dispatch atômico do webhook tem janela vulnerável** — webhook `route.ts:524, :556-561`. INSERT da nova mensagem + UPDATE do `process_after` de TODAS as pendentes daquele agente+contato é uma sequência **não atômica**. Se 2 webhooks chegam simultâneos (lead manda 2 msgs em <50ms), worker B pode dar UPDATE em `process_after` antes do worker A ter inserido sua linha, fazendo a linha A não receber o reset de debounce. Resultado: a primeira msg pode ser processada antes do debounce expirar, sem agregar com a segunda. Em prática raro, mas não impossível. **Fix**: RPC Postgres que faz INSERT + UPDATE em uma transação, ou usar `pg_advisory_xact_lock(hash(contact_id))`.

- **[C3] `priorTurnCount` calculado errado para sanitizer em conversas com summary** — `processor.ts:495, :534`. `priorTurnCount: conversationTurns.length` é passado pra `processWithAI`, mas no `compressed.turns` que vai pro LLM o "summary turn" sintético + ACK adicionam +2 turns (ver `history-compressor.ts:74-88`). Para o sanitizer (`openai-client.ts:325` → `response-sanitizer.ts:139`), turn=0 significa "primeira msg da conversa, mantenha greeting". Numa conversa real com 30+ turns, `conversationTurns.length` retorna 30, então é >0 e sanitizer corta greeting — OK. Mas se a IA por qualquer motivo tiver `priorTurnCount === 0` ali (ex: histórico GHL falhou retornar mensagens), o sanitizer **não corta saudação** e o greeting injetado no system roda. Edge case raro mas mascarado. **Fix**: passar `priorTurnCount = (convState?.message_count ?? 0)` em vez de derivar de `conversationTurns.length`.

- **[C4] Schema strict da OpenAI exige todos os campos opcionais como `required`** — `prompt-builder.ts:863-878`. O schema lista `required: ["type", "field_key", "value", "tag", "calendar_id", "start_time", "appointment_id", "title", "pipeline_id", "stage_id"]`. OpenAI Structured Outputs interpreta isso literalmente: o modelo **vai retornar** todos esses campos com `null` para os não usados, gastando tokens. Pior: o pós-processamento em `openai-client.ts:391` retorna `actions` direto, então actions com `field_key: null` chegam em `executeActions` (`action-executor.ts:62`). Os switch-cases verificam `if (action.field_key && action.value)` então funcionalmente OK, mas é desperdício de output tokens (cada action vira 10 chaves, ~80 tokens em vez de 30). **Fix**: usar `oneOf` no schema com 7 variantes específicas (uma por `type`), ou usar `additionalProperties: true` e listar só `type` como required (perde validação estrita mas economiza muito). Estimativa: 20-30% economia em conversas que disparam actions.

- **[C5] `parse_failed` loop detection lê o LOG ERRADO** — `processor.ts:546-552`. Procura por `action_type === "ai_processing"`, mas o INSERT em `:589-609` só acontece DEPOIS do check. Ou seja, o "loop de 2 falhas seguidas" detecta a falha N-1 (que já teve o log gravado), nunca a N atual ainda. Funciona, mas há um bug: o check pega só `limit(1)` (linha 552) e depois faz `recentFailures?.[0]?.action_payload` em `:554`. Se o turn anterior foi bem-sucedido (parse_failed=false) **e** o turn N atual é o primeiro a falhar, NÃO pausa. Ok, esse é o comportamento desejado. Mas se a primeira mensagem da conversa for falha de parse (sem log anterior), `recentFailures` vem vazio, e `lastWasFailure = undefined && ...` retorna falsy — não pausa, manda fallback. Tudo bem. Bug real: **se a IA falhar parse 2x seguidas mas no meio houver uma `outbound_handoff_triggered` ou similar com action_type diferente, o filtro `eq("action_type", "ai_processing")` ainda pega o último ai_processing, então OK**. Reclassifico para HIGH; não é critical.

### HIGH

- **[H1] System prompt pode estourar 30k+ tokens com KB+feedback+behavior** — `prompt-builder.ts:725` cap KB em 12000 chars (~3k tokens), `:702-715` 8 feedbacks * 240 chars = 2k chars, mais behavior-blocks ~1500 chars cada × 4 = 6k chars, mais `custom_instructions` 3000 chars, mais `conversation_examples` 2000 chars, mais base ~3k chars. Total estimado 25-30k tokens em system prompt em conversas com KB cheia. Cache resolve a maior parte do custo, mas: (a) primeiro turn gasta full price; (b) Anthropic só cacheia até 1024 tokens mínimo + cobra 1.25× write; (c) latência TTFB sobe. **Fix**: KB deveria virar RAG (já tem em `_planning/nlg-research.md`?) com retrieval por query. Hoje é "tudo no prompt". Quick win: reduzir `GLOBAL_CAP` de 12000 para 6000, `PER_ITEM_CAP` 4000 → 2000.

- **[H2] Sanitizer pode quebrar mensagens válidas em casos PT-BR** — `response-sanitizer.ts:48`. Pattern P7 `^[\s]*,?\s*(da|do|de|das|dos)\s+(equipe...)?[A-Z][...]{1,20}` casa coisas como "De repente," (D maiúsculo no início). Não sei se isso aparece, mas é frágil. Pior: P3 (`:28`) com lookbehind/captura `(\s+(sim|certo|claro|também|tb|tbm|obrigad[oa]|por\s+aqui)?)*` é greedy e pode comer mais que deveria. Risco baixo em produção, mas seria bom **um teste** com umas 30 frases (vide ponto MED de testes).

- **[H3] Anti-eco compara só 90s; lead pode demorar mais** — webhook `route.ts:278`. `90_000` ms. Se a IA mandou msg, lead leva 95s pra responder pelo CRM via humano (cenário comum: vendedor faz handoff manual e responde minutos depois), o anti-eco falha em detectar como humano. Aí o webhook trata como API e ignora. Fix: aumentar pra 5min, ou (preferível) confiar no `source === "app"` quando presente e só usar anti-eco como fallback (que já faz). Mas o range de fallback parece curto.

- **[H4] `findExistingAppointment` faz 3 chamadas GHL sequenciais** — `action-executor.ts:265-300`. 3 endpoints diferentes em sequência, cada um com try/catch silencioso. Em casos comuns de "agendar primeira vez", todos 3 vão retornar vazio = 3 round-trips desperdiçados (latência 600ms+). **Fix**: paralelo com `Promise.allSettled` e pegar o primeiro com items.length > 0, ou cachear o "primeiro endpoint que funcionou" por location.

- **[H5] `executeAction` para `book_appointment` não tem timeout próprio** — `action-executor.ts:158-204`. Confia no GHLClient. Se o GHL trava, todo o request fica preso até `maxDuration: 60` da função Vercel. Nunca medi mas suspeito que o GHL pode levar 10-15s pra responder em horários de pico. **Fix**: `Promise.race` com `setTimeout(8000)` em cada chamada de booking.

- **[H6] `processWithAI` não retry em rate limit / 5xx** — `openai-client.ts:9, :16` configura `maxRetries: 1`. SDK do OpenAI faz retry interno em 429/5xx, mas só 1 vez. Pra um pipeline conversacional com debounce de 15s já consumido, falhar 1 vez = lead espera + msg perdida (porque processor marca como `completed`/`failed` no finally). **Fix**: usar `withRetry` (já existe em `lib/utils/retry.ts`) com `maxRetries: 2` envolvendo `processWithAI`; ou subir `maxRetries` do SDK.

- **[H7] Fallback "sem campos opcionais" no insert do queue pode mascarar bugs** — webhook `route.ts:533-548`. Se INSERT falha por schema desatualizado, faz retry sem `channel/audio_url/...`. Útil em deploy intermediário, mas: se a falha for por outro motivo (ex: FK constraint, RLS), o retry também vai falhar — o código loga `Insert failed definitively` mas demora 2 RTTs até falhar de vez. **Fix**: detectar `error.code === '42703'` (column doesn't exist) explicitamente; outros erros, falhar imediatamente.

- **[H8] `aiResult.response.collected_data` confiança cega no formato** — `processor.ts:653`, `action-executor.ts:340`. O processor faz spread `{ ...previousData, ...response.collected_data }` e grava no banco. Se o modelo retornar `{ "data_birth": null }`, o `null` sobrescreve um valor preenchido anteriormente (string truthy). O parser em `openai-client.ts:381-386` filtra null/undefined/"nao coletado" — bom — mas só na primeira passada. Defesa em camadas: **fix** `executeActions` na linha 320 deveria também filtrar `null`/`""` antes de fazer merge.

- **[H9] `compressHistory` re-roda o resumo em **toda** chamada** — `history-compressor.ts:32-72`. A condição "reaproveitar cache" é `cachedCoveredCount >= cutoff`. Mas `cutoff = turns.length - KEEP_RECENT (12)`. Toda nova msg, `turns.length` aumenta em 1, então `cutoff` aumenta também. Então o cache só é usado por exatamente 0 chamadas? Não — `cachedCoveredCount` foi gravado quando cobria `cutoff_anterior`, e `cutoff_atual = cutoff_anterior + 1` (uma msg nova chegou). `cachedCoveredCount >= cutoff` só funciona se o cache foi gerado há `KEEP_RECENT` turns atrás (12 turns). Resultado: regenera resumo a cada 1-2 mensagens em conversas longas. Custo: 1 chamada extra ao gpt-4.1-nano (barato, mas latente). **Fix**: alterar a lógica pra "regerar a cada N turns acumulados", não a cada cutoff diferente.

- **[H10] `executeAutomations` para `move_pipeline` usa endpoint errado** — `processor.ts:809-816` e `action-executor.ts:240-247`. `client.put("/opportunities/")` (note o `/` final) sem ID. GHL API normalmente requer `/opportunities/{opportunityId}` ou `/opportunities/upsert`. Sem o ID, isso vai 404 ou criar uma nova. Verificar com `_planning/ghl-api-reference.md` — provável bug.

### MED

- **[M1] Zero testes** — só achei `.test.ts` em `node_modules`. Para um pipeline com tantas branches (5 bandas × 4 dims × 2 tipos × 4 objetivos × idioma × audio/img/pdf toggles), a cobertura está em 0%. Riscos: regressão no sanitizer (caso típico: alguém adiciona uma regex pra novo idioma e quebra outra), drift entre sales e recruitment quando o framing muda, fallback de slots não sendo testado em casos de retorno parcial. **Recomendação**: começar pelo `response-sanitizer.test.ts` (alta criticidade, pure function, fácil de testar) com 50 casos. Depois `prompt-builder.test.ts` testando sections individuais. Custo baixo, ROI alto.

- **[M2] DRY: `channelToMessageType` duplicado** — `action-executor.ts:39-46` e `reaction-engine.ts:30-37` são idênticos. Mover pra `lib/ghl/channel.ts`.

- **[M3] DRY: `getOpenAIClient` em 3 lugares** — `openai-client.ts:8`, `audio-transcriber.ts:6`, `history-compressor.ts:91-95`. Cada um com timeout/retry diferentes. Mover pra `lib/ai/clients.ts` com factory que aceita override.

- **[M4] Imports dinâmicos sem cache** — `openai-client.ts:15` (`import("@anthropic-ai/sdk")`) toda chamada. Em serverless cold start é desprezível, em warm a JIT cacheia. Não é bug, mas: o projeto importa `mammoth` e `unpdf` dinâmicos também (`media-processor.ts:84, :122`) — em warm container isso é fine, em cold é +200-500ms. Considerar imports estáticos top-level se Vercel keep-warm está habilitado.

- **[M5] `extractAudioUrl` muito permissivo** — `audio-transcriber.ts:165-172`. Heurística por nome (`includes("voice")`, `includes("audio")`, `includes("ptt")`) gera falsos positivos com URLs como `https://example.com/audio-tutorial.mp4` que não é áudio. Risco baixo (Whisper falha graciosamente) mas custo: chamada Whisper de $0.006/min sem retorno. **Fix**: se mime não veio, tentar HEAD request pra confirmar `content-type: audio/*`.

- **[M6] `processWithAI` budget check usa `.repeat(historyChars)`** — `openai-client.ts:119`. `estimateTokens(" ".repeat(historyChars))` aloca um string gigante em memória só pra contar caracteres. Em conversas longas (200k chars de histórico) isso aloca 200k bytes desnecessariamente. **Fix**: `estimateTokens(historyChars)` direto, mudar a função pra aceitar `string | number`.

- **[M7] `temperature: 0.8` hardcoded** — `openai-client.ts:207, :274`. Em recruitment você pode querer mais determinístico (0.5) pra evitar vazar comissão; em sales agressivo pode querer mais (1.0). **Fix**: derivar de `tone_creativity` (>70 → 1.0, 50 → 0.7, <30 → 0.4).

- **[M8] Regex P3 do sanitizer pode comer "Tudo bem que eu fiz X"** — `response-sanitizer.ts:28`. Pattern `tudo\s+bem(\s+(sim|certo|claro|...))*` casa "Tudo bem" no início. Em "Tudo bem que conseguimos agendar!" vai cortar "Tudo bem" e deixar "Que conseguimos agendar!". Edge case mas plausível. **Fix**: âncora `(?=[?!.,]|$)` após "bem" pra exigir pontuação ou fim.

- **[M9] `buildResponseJsonSchema` re-cria em todo turn** — `processor.ts:499`. Mesmo schema baseado em `data_fields` que não mudou — recria 100% do objeto a cada msg. Não é hot path crítico, mas em volume vira allocation desnecessária. **Fix**: memoizar por `agent_id` numa cache LRU pequena.

- **[M10] `internal_notes` está no schema mas nunca é lido em produção** — `openai-client.ts:392`, `types/ai.ts:18`. Parser preenche `internal_notes` mas nada do downstream consome. Se ainda não for usado, é gordura no JSON output (modelo gera tokens à toa) e no schema. **Fix**: remover do schema ou começar a usar (ex: gravar em `execution_log` pra debug).

- **[M11] `feedback` slice de 8 itens pode pegar feedbacks irrelevantes** — `prompt-builder.ts:702, 710` usa `slice(0, 3)` positivos e `slice(0, 5)` negativos, mas vem ordenado por `created_at desc` (`processor.ts:472`). Está OK, pega os mais recentes. Mas: feedback de 6 meses atrás continua influenciando. **Fix**: filtrar `gte('created_at', '90 days ago')` no SELECT.

- **[M12] `sanitize()` em `prompt-builder.ts:9` agressivo demais** — remove `\n` substituindo por espaço. Em `custom_instructions` (linha 800) isso achata múltiplas linhas em uma — perde formatação que o admin escreveu intencionalmente. **Fix**: pra `custom_instructions` e `knowledge_base.usage_instructions`, preservar `\n`. Sanitize agressivo só para nomes/labels.

- **[M13] Inferência de gênero por nome é frágil** — `prompt-builder.ts:364-367`. Lista hardcoded de nomes femininos + heurística "termina em 'a'". Falha em "Andrea" (homem em italiano), "Joshua" (acaba em 'a' minúsculo? não), "Tatiane" (acaba em 'e'). Risco real: agente diz "ela" de um especialista homem. **Fix**: campo explícito `specialist_gender: 'm' | 'f' | 'neutral'` no `agent_configs`.

- **[M14] `messageType: TYPE_CUSTOM_SMS` filtro restritivo demais** — `processor.ts:352`. Filtra mensagens GHL com `messageType === "TYPE_CUSTOM_SMS" || m.body`. O segundo predicado (`m.body`) salva, mas o primeiro descarta WhatsApp/IG legitimos com tipos diferentes. Histórico fica incompleto. **Fix**: aceitar todos os tipos com body presente.

- **[M15] `priorTurnCount` zero em conversa com summary cria UX bug** — quando uma conversa de 50 turns é compactada, `compressed.turns` retorna ~14 turns (summary+ack+12 recentes). Mas `priorTurnCount: conversationTurns.length` (linha 534 do processor) vê 50. Se o summary não foi gerado por algum motivo (try/catch do `summarizeTurns`), turns podem ter 0 mas conversation já é antiga. Vide [C3].

### LOW

- **[L1] Logs com console.log em produção** — todos os arquivos AI. Vercel agrega, mas não há log levels (`debug` vs `info`). Pequeno custo de noise; em volume `[Audio] Downloaded XXX bytes` polui. **Fix**: usar pino/winston ou wrap mínimo `if (process.env.LOG_LEVEL === 'debug')`.

- **[L2] `MAX_FILE_SIZE = 25MB` hardcoded em audio** — `audio-transcriber.ts:4`. Whisper API aceita 25MB; OK. Mas WhatsApp manda voice notes de 16MB+ ocasionalmente. Considerar warning antes do download se mime indicar tamanho próximo.

- **[L3] `MAX_EXTRACTED_TEXT = 8000` chars pra docs** — `media-processor.ts:6`. Tabela de PDF longa não cabe. Aceitável pra MVP.

- **[L4] Travessão "—" virando "," — pode ficar feio** — `response-sanitizer.ts:115`. "Eu entendi — vou agendar" vira "Eu entendi, vou agendar" (OK). "Tudo bem? — Sim!" vira "Tudo bem? Sim!" (linha 113 trata). Edge: "Sim — não" vira "Sim, não" (semântico oposto). Risco baixo, modelo raramente faz isso.

- **[L5] `currentDate` formatado em pt-BR no system mas en-US dentro do runtime** — `processor.ts:452-464` usa `en-US`. `prompt-builder.ts:153` injeta como string sem traduzir. Mas todo o resto do prompt é PT-BR. Nada quebra, só inconsistência estética.

- **[L6] `appointment_id` no schema mas nunca usado** — `prompt-builder.ts:863`, `action-executor.ts:206-235`. Reschedule resolve buscando appointment existente; `appointment_id` que a IA preencheria nunca é lido. Schema gordo. Ver [C4].

- **[L7] `extractMediaAttachments` faz `seenUrls.add` mas Set não é case-insensitive** — `media-extractor.ts:58`. URLs dos signed do GHL têm tokens — duplicatas exatas funcionam, mas mesma URL com query param diferente passa. Risco mínimo.

- **[L8] `BookingError` re-classifica strings frágeis** — `action-executor.ts:194-198`. `bookingError.message.includes("available") || ...` casa qualquer 422 mesmo se for outro erro. Mensagem de erro pro lead "Desculpa, não consegui agendar nesse horário" sai sempre que GHL retorna 422 — pode ser confuso se o erro real foi outro. **Fix**: usar `isBookingConflictError` (já importado mas não usado nesse path).

- **[L9] `companyId` sempre puxado de `locations` table** — webhook `:426-431`, processor `:289-295`. Toda mensagem faz query. Considerar cachear por location_id em memória (TTL 5min).

- **[L10] `recipientPattern` não validado** — sanitize só limita 200 chars; injeta `${configuredGreeting}` direto no prompt em `prompt-builder.ts:137`. Se admin colocar `}; ignore previous; ${...}` no greeting_style, é prompt injection trivial. Validação fraca em `:9-15`. **Fix**: sanitize mais agressivo em campos editáveis pelo admin (escape de `{`, `}`, backticks).

- **[L11] Não há rate limit por agente, só por contato** — webhook `:7-21`. Mil contatos diferentes mandando ao mesmo tempo passam. Em scale isso vira problema.

- **[L12] `processWithAI` chama `console.warn` em budget exceeded** — `openai-client.ts:124, :133`. Bom pra dev. Em prod, considere métrica (Datadog/Vercel).

---

## Otimizações (Quick wins — alto impacto, baixo esforço)

1. **Reduzir token gordura no schema strict** ([C4]) — passar de `required: [10 campos]` pra `oneOf` com 7 variantes salva 20-30% em response tokens em todas as conversas. ROI altíssimo, ~2h de trabalho. Estimativa: $20-50/dia em volume.

2. **Memoizar `buildResponseJsonSchema` por agent_id** ([M9]) — LRU de 50 entries elimina N JSON.stringify. Latência -5ms por turn em volume.

3. **Reduzir `GLOBAL_CAP` da KB de 12000 → 6000 chars** ([H1]) — corta input tokens em ~50% pra agents com KB grande. Usuário não vai notar diferença em respostas (KB tem redundância). Confirmar antes com testes A/B.

4. **`temperature` derivada de `tone_creativity`** ([M7]) — 1 linha de mudança em `openai-client.ts:207`. Recruitment menos criativo evita vazar valores. Sales agressivo pode arriscar mais.

5. **Paralelizar `findExistingAppointment` endpoints** ([H4]) — `Promise.allSettled` nos 3 endpoints em vez de sequencial. -400ms p99 em booking.

6. **Aumentar anti-eco window de 90s → 5min** ([H3]) — 1 const change. Reduz falsos negativos de handoff.

7. **Filtrar feedback >90 dias** ([M11]) — adicionar `.gte('created_at', ninetyDaysAgo)` no SELECT. Feedback antigo pode estar desatualizado.

8. **Fix do bug `failed`/`completed`** ([C1]) — variável `groupOk` local, usar no finally. 5 linhas.

9. **Remover `internal_notes` do schema** ([M10]) se não usado — economiza output tokens, simplifica resposta.

10. **Rolling summary só a cada 8 turns acumulados** ([H9]) — mudar threshold de "qualquer cutoff diferente" pra "cutoff cresceu >= 8". Reduz chamadas de gpt-4.1-nano.

---

## Refactors maiores (médio prazo)

### R1. Quebrar `processGroup` (~600 linhas)

`processor.ts:173-773` mistura: fetch agent, processar mídia, fetch GHL paralelo, montar prompt, chamar LLM, executar actions, sync data, agendar follow-up, executar reactions, executar event automations.

**Proposta**: extrair pra um pequeno orchestrator com estágios:

```
src/lib/queue/stages/
  load-agent.ts            — fetch agent + config + convState + opt-out gate
  preprocess-media.ts      — audio + img + pdf
  fetch-ghl-context.ts     — messages + contact + slots em paralelo
  build-prompt.ts           — system + runtime + schema
  call-llm.ts              — processWithAI + parse failure detection
  apply-side-effects.ts    — actions + sync + reactions + automations
  schedule-followups.ts    — follow-ups + summary notes
```

Cada estágio recebe `Context` mutável, retorna `Context` ou throw. Testabilidade vai do 0 a 80% em poucos dias. Cada estágio é mockable. Reduz risco de regressão no monstro atual.

### R2. RAG para Knowledge Base

Hoje toda KB vai inline no system prompt (`prompt-builder.ts:721-784`). Com 12k chars cap, ainda é substancial. Já existe pgvector (`_planning/nlg-research.md` indica). **Mover KB pra retrieval-on-demand**: consulta vetorial pelos últimos 3 turns + new message, top 5 chunks, ~2000 chars no runtime context. Economia: 50-80% em system prompt size pra agents com KB cheia.

### R3. Validação Zod do response da AI

`openai-client.ts:350-398` faz parsing manual com fallbacks soltos. Embora robusto pra JSON inválido, **não valida tipos** (`actions[].start_time` poderia vir "amanhã" em vez de ISO 8601). Próximo passo: schema Zod + `.safeParse()`. Já tem `zod` instalado (`package.json:34`) e usado em `lib/utils/validation.ts:1`.

### R4. Centralizar provider switching

`openai-client.ts:144-147` com `if (isClaude) ... else processWithOpenAI`. Cresce desorganizadamente quando adicionarem Gemini/Grok/etc. Padrão Strategy:

```ts
interface AIProvider {
  call(input: ProcessMessageInput): Promise<AIProcessingResult>;
  supportsVision(model: string): boolean;
  supportsStructuredOutputs(model: string): boolean;
}
const providers = { openai: new OpenAIProvider(), anthropic: new AnthropicProvider() };
```

Bonus: testabilidade (mock providers facilmente).

### R5. Test infrastructure

Adicionar Vitest. Começar por:
- `response-sanitizer.test.ts` — 50 casos PT-BR (greeting, vocativo, travessão, edges)
- `prompt-builder.test.ts` — section by section, snapshot tests
- `behavior-blocks.test.ts` — band boundaries, profile composition
- `reaction-engine.test.ts` — pickTriggeredDataFieldRules com várias combinações

Custo: 1-2 semanas. ROI: catch regression antes de prod.

### R6. Métricas/Observability

Vercel logs estão soterrados de `console.log`. Adicionar tracking estruturado:
- prompt_tokens / completion_tokens / cache_hit_ratio (já loga em `:335`, mas só console)
- duration_ms por estágio
- parse_failed rate por agent_id
- sanitizer hit rate (quantas vezes cortou greeting?)

Datadog/Axiom/Logtail. Mas mesmo um Supabase table `metrics_daily` agregado seria step-up.

---

## Avaliação por arquivo

| Arquivo | LOC | Nota | Comentário 1-linha |
|---|---|---|---|
| `src/lib/ai/openai-client.ts` | 399 | **8/10** | Sólido dual-provider, logging maduro; schema strict tem gordura ([C4]) e legacyText/structured branches são confusas |
| `src/lib/ai/prompt-builder.ts` | 998 | **7/10** | Boa separação cache, framing sales/recruitment crítico; muito grande, behavior blocks intermediários quase nunca disparam (35-65 range) |
| `src/lib/ai/behavior-blocks.ts` | 330 | **9/10** | Registry limpo, comentário explicativo, expansível; melhor arquivo do conjunto |
| `src/lib/ai/action-executor.ts` | 370 | **6/10** | Lógica correta mas `findExistingAppointment` sequencial ([H4]) e error re-classification frágil ([L8]) |
| `src/lib/ai/audio-transcriber.ts` | 187 | **7/10** | Detection de URL mais permissiva que devia ([M5]); fallback de extension OK |
| `src/lib/ai/history-compressor.ts` | 129 | **6/10** | Boa ideia, lógica de cache hit quebrada na prática ([H9]); summary turn como user role é hack que pode confundir o modelo |
| `src/lib/ai/media-extractor.ts` | 116 | **8/10** | Cobertura ampla de formatos GHL, dedup por URL OK |
| `src/lib/ai/media-processor.ts` | 228 | **8/10** | unpdf+mammoth cobertura sólida, budget de 25s razoável |
| `src/lib/ai/reaction-engine.ts` | 259 | **8/10** | ReDoS guard, dedup de rules; quase sem testes pra regex |
| `src/lib/ai/response-sanitizer.ts` | 153 | **7/10** | Defesa em camadas excelente; patterns frágeis em casos PT-BR específicos ([H2][M8]); SEM TESTES é um risco aqui especificamente |
| `src/app/api/webhooks/inbound-message/route.ts` | 782 | **6/10** | Faz coisa demais em uma rota: webhook + handoff + opt-out + rate limit + targeting + dispatch; bug atomicidade ([C2]) |
| `src/app/api/cron/process-queue/route.ts` | 41 | **9/10** | Curto, correto, auth via CRON_SECRET, Promise.all bem usado |
| `src/app/api/agents/process-batch/route.ts` | 35 | **9/10** | Idem |
| `src/app/api/cron/summary-notes/route.ts` | 29 | **9/10** | Idem |
| `src/lib/queue/processor.ts` | 947 | **6/10** | Faz tudo certo mas é um monstro de 600+ linhas em `processGroup`; bug de status ([C1]); precisa quebrar ([R1]) |

**Nota geral do conjunto: 7/10**. Sistema funcional, com decisões arquiteturais boas no core (cache separation, structured turns, sanitizer mecânico, dual-provider). Precisa: (a) corrigir bugs critical [C1][C2][C4]; (b) introduzir testes; (c) quebrar processGroup; (d) RAG na KB. Nada está fundamentalmente errado — está madurando bem para um produto novo.
