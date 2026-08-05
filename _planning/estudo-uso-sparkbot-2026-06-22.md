# Estudo de uso do SparkBot — quem usa, como usa, o que melhorar

> Data: 2026-06-22 · Fonte: produção (`AI Agent Hub`, Supabase `vyfkpdnwevtuxauacouj`) ·
> Método: análise quantitativa (sparkbot_messages, execution_log, usage_records, admin_signals,
> assistant_scheduled_tasks) + leitura qualitativa de **conversas reais** dos 21 reps mais ativos
> (7 agentes leitores + 1 síntese, ~970k tokens). Janela de dados: mai–jun/2026.

---

## TL;DR (o que importa)

1. **SparkBot virou uma secretária pessoal por WhatsApp.** 99% do uso é WhatsApp, PT-BR informal, com áudio como canal de entrada primário pra vários reps. A **web UI está morta** (6 mensagens no total, de sempre).
2. **O job mais valioso não é "gerar" — é ATERRISSAR no CRM.** Os reps fazem o trabalho cognitivo no Fathom/Gemini/ChatGPT/Zoom e usam o SparkBot como o **"último quilômetro"** que transforma aquilo em nota/task/stage no Spark Leads. O produto é mais um *conector confiável* do que uma IA criativa.
3. **Atrito #1 = falsas confirmações ("disse que fez e não fez").** Presente em **6 de 6 clusters**. E o contraintuitivo: quando o bot é **honesto** sobre o que não conseguiu, os reps *perdoam e agradecem*. O que enfurece é a mentira. **Anti-alucinação honesta é feature de produto, não detalhe de engenharia.**
4. **Adoção 3× num mês, mas funil de ativação brutal:** 168 provisionados → 34 mandaram inbound → valor real concentrado em **~6–8 reps**. O gargalo não é aquisição, é a primeira experiência.
5. **A munição pra resolver os 4 maiores atritos já está construída e atrás de flag OFF:** Task Orchestrator (H41), Group Campaigns (H40), trigger por stage (F27.D).

---

## 1. Panorama quantitativo

| Métrica | Maio | Junho | Δ |
|---|---|---|---|
| Mensagens de rep (inbound) | 340 | 1.590 | **4,7×** |
| Reps ativos no mês | 10 | 29 | **2,9×** |

- **Canal:** 2.327 msgs do bot + 1.927 do rep via WhatsApp; **só 6 mensagens na web UI** (3+3). System/proativos: 66.
- **Funil de ativação:** 168 reps provisionados · **34 mandaram inbound** · 76 aceitaram termos (alguns via backfill) · **92 nunca responderam aos termos** · 8 com proativo pausado. Ativação real ≈ **20%**.
- **Retenção (returning reps/semana):** 3 → 4 → 6 → 10 → **15**. Núcleo fiel e crescente. Soraia usa há **28 dias seguidos**, Gustavo 24, Marcos 19.
- **Intensidade:** média **11,8 msgs de rep por dia ativo** (mediana 6, pico 123). É ferramenta de trabalho, não brinquedo.
- **Dia/hora (pico):** seg/ter/sex; tarde-noite (16–17h e 20–21h UTC ≈ horário comercial BR/US).
- **Engajamento (distribuição dos que mandaram msg):** 8 power users (50+ msgs) · 10 recorrentes (11–50) · 7 exploraram (3–10) · 4 provaram (1–2) · 3 só proativo.

**Custo / confiabilidade:**
- ~**$370** em tokens (cobrado ~$407). Dominado por **system prompt gigante** (~140k tokens/turno; pico 222k). O **cache** carrega a conta (136k tokens cacheados/turno).
- **"Problema técnico" praticamente zerou** (1 ocorrência) — o fix de structured-output pegou. 👍
- **Fallback OpenAI (GPT-4.1) disparou em ~7% dos turnos** (139/2085) — os dois tiers Claude caíram. Compliance ~85% pior no fallback (per stress test) → vale investigar a janela.
- Multimodal: **90 notas de voz** transcritas (~26 min), 28 imagens.
- Modelos: Sonnet 4.6 = 1.751 turnos (84%), Haiku 4.5 = 195 (9%), GPT-4.1 = 139 (7%).

---

## 2. O que mais usam (features por frequência de tool)

59% dos turnos do bot chamam ≥1 tool (média **3 tools/turno**, pico 36).

| # | Tool | Chamadas | Reps | Feature |
|---|---|---|---|---|
| 1 | `search_contacts` | **1.471** | 23 | Resolver QUEM (passo antes de quase tudo) |
| 2 | `present_options` | 355 | 23 | Botões de confirmação/escolha |
| 3 | `create_note` | 248 | 12 | Anotar no CRM |
| 4 | `list_calendars` | 174 | 15 | **Agendamento** (cluster) |
| 5 | `create_task` | 145 | 9 | Criar tarefa |
| 6 | `schedule_message_to_contact` | 144 | 6 | Mandar msg pro lead depois |
| 7 | `get_free_slots` | 107 | 14 | Agendamento |
| 8 | `create_appointment` | 97 | 12 | Agendamento |
| 9 | `schedule_reminder` | 78 | 11 | Lembrete pro próprio rep |
| 10 | `get_contact_notes` | 76 | 5 | Ler histórico |
| 11 | `create_contact` | 58 | 10 | Cadastrar |
| 12 | `list_pipelines` / `list_opportunities` | 50 / 49 | 9 / 8 | Pipeline |

**Agrupado por feature (chamadas somadas):**
- **Resolução de contato:** ~1.540 (search + get + filtered) — de longe o workhorse.
- **Agendamento (Agendamento V2):** ~560 (calendars + slots + create/update/list appt + block).
- **Notas:** ~330.
- **Tarefas (CRM to-dos):** ~190.
- **Mensagens agendadas/avulsas ao lead:** ~260.
- **Lembretes ao rep:** ~80.
- **Pipeline/oportunidades:** ~140.
- **Conhecimento de seguro** (`query_carrier_knowledge`): 33.
- **Bulk V2:** ~70 chamadas — mas **só 1 rep** (Gustavo). Feature cara, quase ninguém achou.
- **Task Orchestrator (H41):** start_task_draft 6 / add_step 13 / commit_draft 3 — **2 reps**. Recém-ligado.
- **`report_missed_capability`:** 13 (6 reps) — o bot registrando o que não sabe fazer.

**Workhorse silencioso (cron, não-LLM):** o motor proativo entregou **2.030 lembretes de tarefa do CRM** (`ghl_task_reminder`, marcados completed), **212 "Pós-reunião"**, **65 "Resumo matinal"**, ~190 lembretes diversos, 16 "bulk concluído". O proativo carrega tanto valor quanto o chat — e tanto atrito (ver §4).

---

## 3. Como as pessoas interagem (personas + padrões)

### Personas
1. **Líder/mentor power-user (massa)** — Gustavo (e parte de Sieder/Jussara). Rajadas de 30–60+ turnos, turma por turma. Bulk, notas em massa, follow-up multi-etapa, transcrição contínua de áudios de terceiros, coaching de processo. *Surpresa: o usuário de maior volume nem vende a cliente final — gerencia turmas de agentes em formação.*
2. **Organizador de CRM pós-reunião** — o padrão mais universal e saudável (Sieder, Soraia, Bruno, Daniely, Marcos, Victor, Sabrina, Bianca). Cola resumo do Fathom/Gemini ou responde "como foi a call?" por áudio → bot vira secretário (nota + task + tag + stage + valor). **É onde o bot mais brilha.**
3. **Agendador fuso-aware** — (Bruno, Daniely, Sieder, Victor, Luciano, Ana Paula, Cintia). FL/EDT vs Califórnia/PDT vs Brasília o tempo todo; já manda os dois horários. Quer disponibilidade REAL antes de oferecer slots; encadeia agendamento + mensagens programadas.
4. **Multitarefa por áudio** — (Sieder, Jussara, Bruno, Daniely, Ana Paula, a "Alana" da Soraia). Trata o bot como humano, fala dirigindo/no break, pedidos compostos e divagantes num áudio só, dados fragmentados em vários balões.
5. **Curioso que provou e (quase) parou** — a maioria silenciosa. Testou, travou no onboarding ou esbarrou num bloqueio e não voltou. Gilberto: provisionado, **zero mensagens**.

### Padrões de interação transversais
- Bot tratado como **secretária/copiloto pessoal**, não como ferramenta.
- **Áudio é primeira classe** (~90 transcrições); pedidos por áudio são os mais compostos — e os que mais quebram quando o bot perde parte do multi-pedido.
- **Multi-pedido numa mensagem só é a norma** ("cria contato + agenda + 3 mensagens"; "14 reuniões num bloco"). O bot frequentemente fecha só parte.
- **Dois modos no mesmo rep:** comandos telegráficos ("Quente", "Tudo hoje", "Confirmar ✅") E blocos enormes colados (Fathom, emails NLG, listas nome+telefone).
- **Assumem que o bot LEMBRA do estado** entre turnos ("meu cliente de agora", "manda os que vc fez"). Quando não persiste, é a maior quebra de expectativa.
- Colam contexto de **IAs externas** (Fathom/Gemini/ChatGPT/Zoom) e esperam o bot estruturar → o bot é o "último quilômetro".
- **Dados fragmentados** em vários balões geram re-perguntas.
- **Verificação de vida** quando demora: "Oi?", "tá ativo?", "eae?", "já executou ou tá pensando?".
- Tom cordial ("obrigado", "tmj", "👍") que vira seco/ríspido **no instante exato** em que o bot erra horário, perde estado, entra em loop ou re-pergunta o já respondido.

---

## 4. Atritos rankeados (com evidência cruzada)

| # | Atrito | Impacto | Clusters | Recomendação |
|---|---|---|---|---|
| 1 | **Falsas confirmações / estado fantasma** ("disse que fez e não fez") | 🔴 alto | **6/6** | Generalizar o "count real" do H41 pra TODA tool de escrita (schedule_message, create_task, create_opportunity, move_stage) — nunca afirmar "feito" antes do retorno da tool. |
| 2 | **Loop de confirmação** ("Confirma?" repetido até 1h) | 🔴 alto | 5/6 | Auditar a máquina de estados do gate H8: aceitar "Confirmar ✅"/"sim" na 1ª vez + **circuit-breaker** anti-repetição (parar e escalar com erro honesto após N repetições idênticas). |
| 3 | **Desambiguação de homônimos/duplicatas** | 🔴 alto | **6/6** | (a) lembrar a escolha dentro do contato/sessão; (b) **merge de duplicados** (pedido explícito); (c) ranquear matches por sinais (telefone+tag > registro vazio). |
| 4 | **Perda de estado em fluxos longos / bulk de lista explícita** | 🔴 alto | Jussara (L7), Gustavo | **Ligar e validar o Task Orchestrator H41** (objeto persistente no DB resolve por design). Suportar "lista de N contatos" como target de 1ª classe. |
| 5 | **Timeout/silêncio em lote pesado + latência** | 🔴 alto | 4+ | Lote = **job assíncrono com ACK imediato** ("tô processando, te aviso") + `get_task_progress`. Nunca deixar o rep no escuro. |
| 6 | **Proativos duplicados / mal-temporizados** | 🟡 médio | 4 | Dedup do disparo proativo **pro cliente** (não só inbound do rep); não disparar warning de silêncio durante sessão ativa de trabalho. |
| 7 | **Leitura de imagem/PDF intermitente** | 🟡 médio | Sieder, Jussara | Investigar taxa de falha de ingestão via Stevo; ao falhar, pedir reenvio **1×** + fallback de texto, sem loopar 5×. |
| 8 | **Bloqueios de infra** (token GHL, DND, permissão calendário, sem slot) | 🟡 médio | vários | Alerta proativo ao admin **antes** do token expirar (já documentado; falta o canal setado); erros que separem "o que é seu" vs "o que depende do admin". |
| 9 | **Loop de onboarding/termos atropelando o pedido real** | 🟡 médio | Matheus (4×), Cintia | Gate de termos idempotente; não reenviar saudação se o rep já está mandando comando de trabalho. |

> **Quantitativo de apoio:** mensagens em que o bot disse "não consegui/não consigo" = ~79 / 2.396 (~3,3%); "problema técnico" = 1; turnos com ≥3 `search_contacts` (churn de desambiguação/lote) = 62, sendo 29 com 6+.

---

## 5. Oportunidades priorizadas

**Quick wins (já construído / baixo custo):**
1. ⚡ **Ligar o Task Orchestrator (H41) com Jussara + Gustavo.** Resolve L7+L11 e o bulk de lista explícita por design. Já testado (50/50 + 18/18 smoke), anexo nativo validado em prod, flag OFF. **Maior alavancagem, menor custo.**
2. ⚡ **Modo "execute sem perguntar" + lista corrida** (texto plano em vez de `present_options` numerado), configurável por rep. Reduz turnos pros power users; preserva o gate H8 pra quem precisa. *(Casa com o pedido de "opções de lista cortando no WhatsApp" — 2× nos signals, e present_options é a 2ª tool mais usada.)*

**Alto valor, médio esforço:**
3. **Generalizar "count real" anti-alucinação** pra todas as tools de escrita (ataca o atrito #1).
4. **Memória de desambiguação + merge de duplicados** (ataca o atrito #3, o mais ubíquo).
5. **Modo lote assíncrono com ACK + progresso** (ataca o atrito #5).
6. **Inbox/visão central de tasks** com filtro por vencimento e destaque de atrasadas (pedido explícito repetido — Soraia; e "filtrar tasks por vencimento" 2× nos signals).

**Demanda validada, alto esforço (já tem base atrás de flag):**
7. **Trigger automático por tag/stage** (tag "no-show" → dispara sequência). Pedido 2× pela Jussara + Luciano/Manuela. É o F27.D já mapeado.
8. **Mensagem em GRUPO de WhatsApp agendada.** Pedido por Jussara, Daniely, Marcos. É o H40 (precisa instância Stevo dedicada).

---

## 6. Backlog de pedidos reais (26 "missed_capabilities" abertos)

Agrupados (os repetidos primeiro):
- **Agendamento:** e-mail OPCIONAL no formulário do calendário (**3×** — Ana Paula); agendamento recorrente semanal (Manuela); auto-agendar quando cliente confirma horário; reunião com user fora do time (✅ *já corrigido — repIsAdmin*); sync bloqueio no Google Calendar.
- **Tarefas:** filtrar tasks por vencimento (**2×**); inbox central de tasks; alerta vermelho de atrasadas; criar task pra OUTRO usuário com notificação.
- **Contatos:** merge de duplicados; associar cônjuge (**2×**); **busca por nome com variação ortográfica** (Afonso/Affonso) — casa direto com a dominância do `search_contacts`; dados de apólice auto-preenchidos.
- **Outreach:** follow-up cíclico (Jussara); trigger por tag; áudio pro contato; listar tag sem limite de 20; filtrar opp por stage pra bulk (2×); cap bulk 100→150; escolher número de saída.
- **UX:** opções de lista cortando no WhatsApp (**2×**); memória de preferências/atalhos entre sessões.
- **Externo:** submeter aplicação NLG via eApp/iGo; postar/anunciar no Instagram.

---

## 7. Insights não-óbvios

1. **O bot é o "último quilômetro" entre IA externa e o CRM, não a IA principal.** O trabalho cognitivo acontece fora (Fathom/Gemini/ChatGPT). O valor é estruturar + persistir com fidelidade. *Isso reposiciona o produto.*
2. **Honestidade > sucesso silencioso.** O rep perdoa a limitação se o bot for honesto ("não consegui, não quero dizer que fiz"). O que mata a confiança é o estado fantasma.
3. **O power user dominante é gestor de equipe, não vendedor.** O caso de maior volume/atrito (bulk + notas em massa + coaching) é *operações/mentoria* — segmento que o roadmap não nomeia.
4. **Áudio é load-bearing, não conveniência.** É o canal de entrada primário pra vários reps; pedidos por áudio são os mais compostos e os que mais quebram.
5. **Proatividade tem ROI negativo quando mal calibrada.** O nudge pós-reunião é amado; os warnings de silêncio durante trabalho ativo são odiados ("carai mais tu eh chato", "tô dirigindo"). Mesma feature, timing oposto.
6. **Funil de ativação é o problema silencioso #1.** 168 → 34 → ~8. O gargalo é a primeira experiência (loop de termos, bloqueio de token/DND/slot, função prometida e inexistente), não a aquisição.

---

## 8. Nota de segurança (surfaced pelo Supabase advisor)

5 tabelas com **RLS desabilitado** (expostas ao anon/authenticated key): `handoff_notifications`, `media_library`, `task_drafts`, `draft_steps`, `task_events`. São as tabelas novas do orquestrador + mídia. Avaliar habilitar RLS com policies (NÃO habilitar sem policy — bloqueia todo acesso). Decisão do Pedro.

---

## Apêndice — método

- Quant: ~20 queries SQL agregadas sobre produção.
- Qual: 7 agentes leitores (1 por cluster de reps, ≥6 msgs cada), cada um leu até 700 mensagens reais via SQL e extraiu intents/estilo/atrito/encantamento/pedidos/citações; 1 agente de síntese cruzou tudo. As citações verbatim nos clusters são reais (vêm das conversas).
- Reps cobertos: Gustavo, Sieder, Jussara, Soraia, Bruno, Daniely, Marcos, Cintia, Sabrina, Victor Alves, Ana Paula, Bianca Zimmer, Luciano, Manuela, Matheus, Victor Costa, Gilberto (+ John Doe = conta interna de teste, não ponderada).
