# Contact Engine V2 — busca de contato do SparkBot sem fricção (H47)

> Estudo + plano de implementação · 2026-07-10 · pedido do Pedro ("a busca de contato não tá inteligente; ele faz vários rounds; a lista trunca; tem que sugerir o melhor match e herdar o contexto do proativo").
> Base: workflow de 8 agentes (2 de dados sobre 5.597 msgs/47 reps/21d + conversa completa do Pedro; 3 de código; crítico adversarial). Sucede o H45 (contact-resolver, deployado 2026-06-26).
> Markers: 🤖 Claude executa · 👤 Pedro · 🤝 Claude prepara + Pedro valida.

---

## 1. Números (21 dias, 2026-06-19 → 07-10)

| Métrica | Valor |
|---|---|
| Msgs de fricção de busca (união dedupada) | **150** = 4,9% de TODAS as msgs do agent; **129 (86%) são de contato** |
| Reps afetados | 23+ de 47 |
| Resolução em 1 turno | **89%** — a cauda de 11% é o problema |
| Episódios de fricção | 95 (76% custam 1 round extra; 7% custam 3+) |
| Desfecho ruim | **19% dos episódios terminam em ABANDONO** (rep some); ≥2 escalaram pra humano (Jussara → Pedro) |
| Efeito do H45 | -39%/dia bruto; **-17% normalizado** por search-turn (12,1%→10,0%) — melhorou, não resolveu |
| Conversa do Pedro | média 2,0 turnos/resolução; 2,6 nos episódios com fricção; reclamação verbatim 07-10: **"Oxe, ta ruim de achar contato hein"** |
| Quem sofre | usuário LEVE tem taxa 3-4× pior (Luana 41,7%, Cintia 32,4%) — a fricção pega quem menos tolera |

**Metas propostas (medir antes/depois, mesma query):** resolução em 1 turno 89% → **≥95%** · fricção ~6 msgs/dia → **<2** · abandono 19% → **<5%** · zero "me passa o telefone" como primeira reação.

## 2. Diagnóstico — as 8 causas-raiz (rankeadas por dor × frequência)

### CR1 — O prompt transforma até match CERTO em pergunta (2 confirms empilhados)
`prompt-builder.ts:426`: em `high` diz "confirme inline **e siga**", mas o exemplo canônico é interrogativo ("Quer que eu marque com a Fernanda Lira?") → o LLM para e espera "sim". Como a ação seguinte é quase sempre H8 (create_appointment/send), vem OUTRO "Confirma?" → **2 rounds onde 1 bastava**. É a causa nº1 do "fica perguntando".

### CR2 — O tap na lista joga fora o discriminador (selection_id morto)
O reply de lista carrega `selection_id` determinístico (`v1`, `c1`) persistido em `stevo-handler.ts:308`... **e nunca usado**: o LLM só recebe o título TRUNCADO em 24 chars como "texto digitado" (`stevo-handler.ts:110-117`). Quando o título truncado é ambíguo ("Guilherme Dias", "Victor Alves (gmail.com…"), o bot **re-pergunta a MESMA lista** (caso E1 Pedro; caso Guilherme Dias 07-09 2×). ⚠️ Crítico: fix determinístico exige **persistir o mapa opção→contact_id** junto do present_options (o id `v1` é opaco sozinho) — contrato de estado que hoje não existe.

### CR3 — Herança de contexto: existe, mas a branch comum é a fraca
- Quase nenhum proativo grava `contact_name` junto do `contact_id` → cai na branch defensiva do bloco (`active-contact.ts:92-96`: "NÃO assuma sem confirmar") → round extra por design. **Caso E6**: proativo "Como foi a call com a *Andrea Madrona*?" → rep: "marca com ELA terça 2PM" → bot amarrou na **Jussara** (âncora de 50min antes), com weekday errado de brinde; só não agendou errado porque o rep não confirmou.
- **Matriz de proativos** (auditoria completa): gravam id SEM nome: post_meeting, task_reminder, outbound agendado, sequence_paused (`seq.contact_name` disponível e jogado fora). NÃO gravam NADA: `schedule_reminder` da tool (gap conhecido), sequence_completed (id/nome no SELECT e descartados), **handoff F37 (usa chave `lead_contact_id` que o leitor não lê)**.
- **Sequestro de foco (gap G)**: `getActiveContactContext` pega a msg mais recente com contact_id — um audit de "msg agendada enviada pra Maria" REESCREVE o foco entre a pergunta da Vânia e a resposta do rep.
- **F10 (ring buffer) meio-quebrado**: `get_contact` NUNCA alimenta o buffer (lê `d.contact`, tool devolve flat — bug confirmado pelo crítico); `search_contacts` só grava `high`; `recentContactIds` do resolver é **parâmetro morto** (desempate por recência implementado e nunca alimentado); race read-modify-write no JSONB; turno proativo não roda F10; TTL assimétrico (proativo 3h, fallback ∞).
- **Inbound não refresca o foco**: caso Sabrina — o bot editou o cadastro da Camila e 16s depois pediu "me passa o telefone da Camila". A herança só cobre proativo→turno, não turno→turno.

### CR4 — Sinais não-nome não pontuam (imagem, vCard, email, misto)
- **Imagem virou o canal DOMINANTE do Pedro** (5 em 3 dias) e não tem fluxo: o nome na foto depende do LLM ler e buscar por conta própria; no E4 o bot resolveu o SLOT antes de saber COM QUEM (a imagem+caption foi desperdiçada; 5 turnos/3 imagens/1h33 pra 1 appointment); no E7 identificou pela foto com `tools:[]` — **zero re-validação** (violação do padrão PISTA).
- **vCard**: o parser JÁ tem `{name, phone}` estruturados (fix f83a140) e joga a estrutura fora ao serializar "📇 …". Se o LLM passar a string inteira como query, o score afunda (needs_confirm/low). Prompt tem ZERO menção a contato compartilhado.
- **Email não pontua** (query "joao@x.com" → ramo nome → low mesmo com match perfeito). **Query mista** "Fernanda 9782721" → dígitos diluem o nameScore. Não existe score composto.

### CR5 — Limites de UI comem o discriminador
Constantes em `stevo-send.ts:230-238` (espelham limites duros do WhatsApp — não dá pra aumentar, dá pra REALOCAR):
`MAX_BUTTONS=3 · BTN_LABEL_MAX=20` (← o "~20 chars" do Pedro) `· MAX_LIST_ROWS=10 · ROW_TITLE_MAX=24 · ROW_DESC_MAX=72 · BODY_MAX=1024`.
- "Maria Aparecida do Nascimento" → `"Maria Aparecida do Nasc…"` — 2 homônimas ficam **indistinguíveis**.
- Telefone só aparece se o LLM puser em `description` (opcional, sem backfill) — e o **backstop** (`interactive.ts:149-152`) nunca cria description: telefone escrito na linha numerada é decapitado no char 24.
- E1 teve as opções **impressas 2× no corpo** (lista duplicada) — bug de composição.
- 11ª+ opção é descartada com `console.warn` silencioso.

### CR6 — Fuzzy não alcança grafia criativa/apelido/ASR + cadastro-lixo
Casos da frota: "Tida"→Cintia (apelido), "Vyvyanne narcedo"→Viviane, "Eloisa"×"Heloísa Pizini" (H↔E, rep escalou pro Pedro), "Javas"→Geivas e "Thales"→Thalysson (ASR de áudio). E **duplicata idêntica vira `ambiguous`** (2 cadastros do mesmo contato, score 1.0/1.0 → bot manda o rep escolher entre iguais — caso Thais F Garrett × Thaís Gerdt, o pior episódio do período: cancelamento nunca executado + bot negou reuniões que ele mesmo listou no digest). Cadastros-lixo ("Sem contato", sem fone/email) poluem toda lista de homônimos.

### CR7 — Fluxos irmãos NÃO usam o resolver
`followup/core.ts:276-355` (schedule_followup H33) tem resolver PRÓPRIO: busca exata, 0 hits → **"Pode me passar phone ou nome completo?"** — a frase que o H45 matou, viva no follow-up. Auditar também: bulk V2, orquestrador, reminders.

### CR8 — Desambiguação ignora a agenda do dia
Caso Daniely: "faz follow-up com a Camila" — a "Camila | Aposentadoria 12:00 PM" estava na lista de reuniões que o BOT mandou 1 msg antes; ele abriu lista de 4 Camilas mesmo assim. Appointment do dia é o desempate mais barato que existe e não é usado.

## 3. Plano de execução (H47)

> Ordem OBRIGATÓRIA por risco (crítico): consertar ranking/race ANTES de adicionar escritores de foco; auto-proceed SÓ depois do fix de duplicata + re-validação de imagem — senão troca fricção por ação no contato errado (atrito nº1 da conta é falsa confirmação).

### F0 — Telemetria + metas (pré-requisito de honestidade) 🤖
Evento `contact_resolution` (audit leve em metadata ou tabela): query, método, confidence, turnos-até-resolver, desfecho. As queries do §1 viram baseline re-rodável. Sem isso, não dá pra provar o ganho.

### F1 — Quick wins mecânicos (1 PR, sem mudança de comportamento visível) 🤖
1. **F10 shape fix**: `processor.ts:586` ler shape flat do get_contact; registrar também `needs_confirm` confirmado.
2. **Ligar `recentContactIds`** no caller (`contacts.ts:60`) — desempate por recência já implementado/testado, só não alimentado.
3. **Race JSONB** do profile → RPC `jsonb_set` atômico (follow-up H45).
4. **Paralelizar a escada** (`Promise.all` nas variantes, `resolve.ts:120/134`) + early-exit em score ≥0.95 sole + **cache 5min** de `resolveLocationDefaultCountry` (padrão isSparkbotHub). Corta latência sem mudar resultado. ⚠️ rate GHL: burst 100 req/10s — manter cap de concorrência 8.
5. **Duplicata idêntica** (`contacts.ts:71`): alternativas com MESMO phone/email normalizado → high no mais recente + aviso "existem 2 cadastros duplicados (X e Y)". Mata a família E7.

### F2 — Tap determinístico + listas legíveis (o "lista bugada") 🤖
1. **Contrato de estado das opções**: present_options persiste `options:[{id, contact_id?, label, description}]` na metadata da msg do agent; no tap, o handler resolve `selection_id`→`contact_id` DETERMINISTICAMENTE e injeta no turno ("Rep escolheu: <nome completo> (contact_id X)") — o LLM nunca mais re-pergunta a mesma lista. (Resolve E1/Guilherme Dias pela raiz.)
2. **Telefone/discriminador determinístico**: backstop (`interactive.ts:115,149-152`) splitta a linha em ` — `/` · ` → label + description(≤72); truncamento INTELIGENTE de nome (preservar último sobrenome: "Maria A. Nascimento"); dedup de labels truncados (sufixo …últimos-4-dígitos).
3. **Body como portador**: instruir (prompt) a repetir nome COMPLETO + telefone no body (1024 chars) — a row vira só handle de toque.
4. **>10 opções**: top-9 por score + row "Ver mais/nenhum desses" (em vez de descarte silencioso). Corrigir a duplicação de opções no corpo (E1).

### F3 — Contexto que não se perde (o "ele já sabe de quem estou falando") 🤖
1. **Contrato padronizado**: TODO proativo 1-contato grava `contact_id` **+ `contact_name`** (habilita a branch forte). Fixes pontuais: post_meeting (1 get_contact ou title no dispatch), sequence_paused/completed (dados já no SELECT), handoff F37 (duplicar chave pra `contact_id`/`contact_name`), `schedule_reminder` ganha params de contato + herda do turno.
2. **Ranking multi-candidato no lugar de "último ganha"**: `getActiveContactContext` já lê 5 rows — rankear (resposta-adjacente > proativo-pergunta > audit-de-envio; excluir `scheduled_outbound_to_contact` do foco) e expor 2-3 candidatos no bloco em empate. Mata o sequestro G.
3. **TTL simétrico** (24h no fallback F10 via `last_ref_at` já gravado; considerar >3h pra proativo-pergunta — post_meeting à noite respondido de manhã é caso real perdido).
4. **Refresh no turno inbound**: gravar `contact_id/contact_name` na resposta do agent quando o turno resolveu contato (chave separada de `ghl_contact_id`!). Mata o caso Sabrina/Camila.
5. **F10 no dispatcher** (proativo semeia recent_contacts). ⚠️ SÓ depois de 2+3 (ordem do crítico).
6. **Prompt**: cobrir os 2 buracos do E1/E6 — reply de lista com título ambíguo + pronome pós-proativo ganham regra explícita.

### F4 — Sinais novos no score (imagem, vCard, email, misto) 🤖
1. **Score composto**: pré-parser determinístico da query (extrai phone/email/nome) → `max(nameScore, phoneScore, emailExact)`. Cobre email (hoje low), "Fernanda 9782721" e vCard cru.
2. **vCard fim-a-fim**: persistir `metadata.shared_contact{name,phone}` no parse; injetar bloco no runtime ("busque pelo TELEFONE primeiro"); 1 linha no prompt pro padrão "📇".
3. **Fluxo de IMAGEM** (canal dominante): instrução operacional no prompt (extrair nome/telefone da imagem NO MESMO turno, ANTES de slot/calendário — ordem do E4) + **re-validação obrigatória** (get_contact) de qualquer identificação vinda de foto (E7 identificou com `tools:[]`) + registrar a extração pro F10.
4. **Agenda como desempate**: em `ambiguous`, cruzar candidatos com appointments do dia/semana do rep ("a Camila da sua reunião de 12h?") — 1 chamada que o bot frequentemente JÁ fez no turno.
5. **Cadastro-lixo**: candidato sem fone E sem email entra por último e marcado ("cadastro incompleto") na lista.

### F5 — Menos perguntas (a mudança de comportamento que o Pedro pediu) 🤝
1. **Auto-proceed em `high`**: reescrever `prompt-builder.ts:426` pra afirmativa ("Achei a *Fernanda Lira* (+1 732…). Marcando pra amanhã 15h — confirma? ✅") — **identidade+ação num ÚNICO confirm H8**. Corta 1 round do caminho feliz.
2. **`needs_confirm` vira sugestão com escape**: "Encontrei *Fernanda Lira* (+1 732…) — é ela? ✅ / Outro contato" (botões), nunca "me passa o telefone" de primeira.
3. ⚠️ GATED: só liga depois de F1.5 (duplicata) + F4.3 (re-validação de imagem) em prod — senão `high` errado vira ação executada no contato errado. Validar com 1 semana de telemetria F0.
4. **Unificar followup/core.ts no resolver H45** (mesma cirurgia do search_contacts) + auditar bulk/orquestrador/reminders.

### F6 — (Opcional/ambicioso) Índice local de contatos 🤝
Snapshot por location (id, nome deburr, phone digits, email) com TTL → mata as 3 GETs e permite fuzzy REAL sobre a base inteira (hoje, typo no 1º E no último nome = não há o que ranquear; "Vyvyanne" só se resolve assim). Riscos mapeados: staleness, PII, multi-tenant, memória do histórico de timeout aos 120 sub-accounts. Decidir DEPOIS de medir o efeito de F1-F5.

### Validação 🤝
- Replay dos episódios: E1 (Victor), E4 (imagem/Luana), E5 (4 Jussaras), E6 (ela=Andrea), E7 (Thais×Thaís), E8 (state-loss), Tida, Vyvyanne, Guilherme Dias, Camila-da-reunião.
- Stress do resolver (36 casos H45) + novos casos por fase; tsc/build; re-rodar queries do §1 em 7/14 dias (metas do §1).

## 4. Riscos (do crítico adversarial)
1. **Auto-proceed × falsas confirmações** (atrito nº1 da conta): mitigação = ordem das fases + gate + telemetria.
2. **Mais escritores de foco antes do ranking** = taxa de contato-errado pode SUBIR. Ordem F3.2/F3.3 antes de F3.4/F3.5 é obrigatória.
3. **Rate limit GHL** ao paralelizar (100 req/10s/location) — manter concorrência 8 e early-exit.
4. Canal web/GHL não foi analisado (fricção pode ser canal-específica); ASR de nomes segue sem mitigação (fora de escopo — anotar).
5. E7 precisa de probe próprio (appointments no contato duplicado?) antes de creditar tudo à busca.
