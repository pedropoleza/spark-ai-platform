# Alves Cury — investigação do quase-churn (26–28/08) + plano v4 — 2026-08-31

> Pedido do Pedro (31/08, overnight): "ir fundo, entender por que ela age assim, plano completo
> de correção, stress test". Contexto: Marcos Alves (+1 786 461-5477) desativou os DOIS agentes
> em 28/08 18:19 ET pelo painel — "bagulho so ta me fazendo perder os leads tudo... desativei
> aqui pq nao da nao... me avisa que se nao ligo o meu [n8n] de volta".

## Linha do tempo da janela fatal (tudo verificado em banco/API)

- **10/08 00:03** — agentes OFF após caso Lucy ("pediu nome 5×"). Estudo+config v3.3 feitos
  em 17-18/08 (`ESTUDO-PLANO.md`), bateria 22✅/3❌, agentes seguiram OFF.
- **26/08 ~08:21 ET** — Marcos religa **SÓ A BRUNA** (Bruno ficou inactive — provado: todo o
  tráfego da janela é da Bruna; o reactive-trigger filtra `status='active'` e só disparou pro
  Bruno às 18:16 de 28/08). Ele ativa 3 leads antigos na mão setando o campo AI (dropdown
  `C7LzKTXG3QHJuzfqOi9T`) = "Venda".
- **26–28/08** — 29 inbounds → 16 envios, **10 targeting_skip** (silêncio), 7 ai_paused_skip
  (humano na conversa — correto). Dos 10 skips: 2 clientes existentes (skip CORRETO), 1 IG
  orgânico (política a decidir), e o resto **leads de anúncio que ficaram MUDOS** até alguém
  setar campo na mão (Jose/p57: campo AI=Venda só foi setado depois do skip; Renan/ush0:
  recrutamento, a IA nunca pegou, humano atendeu).
- **28/08 18:13:46** — Andréia Michele entra por **anúncio de RECRUTAMENTO** (CTWA IG,
  "*Headline:* Oportunidade para brasileiros nos EUA ... como me tornar agente financeiro").
  Bruna avalia (única ativa), não casa (regra dela é o template de VENDA) → MC-3 defer 120s →
  **18:15:48 targeting_skip**. Lead no vácuo.
- **~18:15-18:16** — Marcos religa o Bruno na pressa + seta AI=Recruit (18:16:07) → trigger
  H82 dispara o Bruno; conversation_state do Bruno nasce 18:16:07.8.
- **18:16:08.6** — Marcos mexe na pílula (GU-7, `manual_ui:switch:user_TrBV...` = ele mesmo,
  m.alves1@icloud.com): seleciona a **BRUNA** (lista provavelmente stale, Bruno tinha sido
  religado segundos antes) → **Bruno é PAUSADO, Bruna nasce ativa**.
- **18:16:16** — o turno de outreach do Bruno, JÁ EM VOO (passou o gate de pausa às 18:16:07),
  **envia mesmo pausado**: "Vi que você se interessou pela oportunidade de se tornar agente
  financeiro aqui nos EUA." / "Que estado você está morando?" — por canal **SMS**.
- **18:16:47** — Andréia: "Flórida" → roteador escolhe o dono ATIVO = **BRUNA** → 18:17:20 ela
  responde obedecendo a regra "CAMPANHA DESTA CONVERSA" da config v3:
  **"Não é recrutamento nem oportunidade de emprego..."** — negando na cara do lead o anúncio
  que ele clicou e a mensagem que o Bruno mandou 60s antes.
- **18:19** — Marcos manda "Desculpa, mandei errado" pra lead, assume NA MÃO (faz a
  qualificação perfeita: casual, morna, bolhas curtas, 1 emoji — **a conversa manual dele é a
  spec do tom**), desativa os 2 agentes e manda o ultimato pro Pedro.

## A "duplicação" do print — NÃO é bug nosso

Provado via API (conversa CsmW0wWKBoOBtTVAPycW): todo envio canal-SMS nessa conta vira
`TYPE_CUSTOM_SMS src=api` (nosso registro) + um gêmeo `TYPE_WHATSAPP src=app` ~6s depois —
**o provider de SMS custom do Marcos entrega pelo número do WhatsApp e o eco da Meta volta pro
GHL como segunda mensagem**. Até a confirmação de workflow DELE duplica igual (01:45:57 +
01:46:04). O lead recebe 1×; a timeline mostra 2×. Mitigação nossa: mandar o proativo pelo
canal do lead (WhatsApp) em vez do default SMS (R5) — aí nem o registro duplo existe.

## Causas-raiz (R1–R6)

### R1 — Cobertura de ativação com buraco (O motivo do churn)
1. Religa parcial: só Bruna ativa → funil de recrutamento 100% invisível (roteador nem tinha
   o Bruno como candidato).
2. Regras frágeis: targeting por template exato do anúncio — lead que apaga o texto
   pré-preenchido do CTWA, ou anúncio que manda só headline (caso Jose), não casa nada.
3. MC-3 re-checa UM agente, uma vez: o defer de 120s enfileira pro "1º com regra" e o recheck
   avalia SÓ as regras DELE — campo/tag que chega depois pro OUTRO agente não re-roteia.
4. O modelo operacional virou "Marcos seta campo na mão por lead" — o bot n8n dele respondia
   tudo na hora; aqui ele vira operador. É ISSO que "perder os leads tudo" significa.

### R2 — Agentes brigando pelo mesmo lead
1. Corrida switch × turno em voo: contact-activate pausou o Bruno às 18:16:08 e o envio dele
   saiu às 18:16:16 — o gate de pausa só roda no INÍCIO do turno.
2. Instrução "esclareça o assunto DESTA conversa" (v3, anti-mistura de campanhas) vira
   **negação da outra frente da empresa** quando o lead é da campanha errada — a Alves Cury
   FAZ recrutamento; a Bruna afirmou que não.

### R3 — Follow-up robótico (o "pediu nome 5×" voltou, agora com "estado")
Nos 3 leads ativados em 26/08, os follow-ups repetiram a MESMA pergunta ("em qual estado?")
3× cada, 2 deles com justificativa vendedora ("con eso puedo avanzar con tu seguro", "assim
consigo te passar as informações certas" — variantes do "separar opções" da Lucy):
1. O prompt GLOBAL de follow-up ensina "#1: lembrete leve ('ficou pendente o X, pode me
   mandar?')" — empurra a re-pergunta; o custom_prompt anti-repetição (v3) perde a briga.
2. Zero enforcement determinístico — regra só em prompt (classe H73/H85).
3. Follow-up das 18:52 repetiu oferta de slot com "hoje às 7 da noite" faltando 8 min pro
   horário (slot stale + rótulo relativo).

### R4 — Guards determinísticos prometidos no estudo 17/08, nunca construídos
- (a) "hoje/amanhã": banido por prompt na v3.3 e **vazou de novo em prod** (Cleidmar 27/08
  16:51 "Tem hoje às 7 da noite ou amanhã, sexta 28/08...").
- (b) recap de confirmação livre (rodada 2 do estudo: lead escolheu 6PM, bot recapitulou
  10AM, booking caiu 6PM).
- (d) title do appointment quando o modelo manda null (default hoje é "Reunião agendada").
- (c) slots no fuso do lead — mitigado pela regra "sempre ET explícito"; fica pra fase 2.

### R5 — Canal do proativo
reactive-trigger enfileira sem canal → default SMS → CUSTOM_SMS + eco (confusão visual) num
lead que é 100% WhatsApp. Reply do turno normal já usa o canal do inbound.

### R6 — Tom fora do gosto real do cliente (dados dos 👎/👍 dele + conversa manual dele)
- 👎 28/08: ofereceu horário **sem dizer que a reunião é um Zoom nem pra que serve**; pulou a
  ponte ("foi muito direto! precisava explicar primeiro que eh bom fazer um zoom...").
- 👎 26/08: meta-narração ("Você mencionou que fala espanhol, então vou seguir assim" →
  "nao precisava falar isso! apenas seguir em espanhol").
- 👎 04/08: "Follow up chato". 👎 03/08: "você mora em qual estado da Flórida?" (Flórida É um
  estado).
- Os 👍 dele e a conversa manual dele têm bolhas CURTAS, warmth, e emoji leve ocasional — a
  v3 baniu emoji e formalizou além do ponto. Gíria pesada (vc/blz/kkk) segue banida
  ("favelado" era sobre isso), mas o registro certo é natural-caloroso, não formal.
- Abertura com fragmento ("Da Alves Cury Financial." como bolha 1 — caso David) e resposta
  em PT pra gringo ("Wrong number sorry" → "Qualquer coisa é só me chamar por aqui. Um
  abraço!").
- Bruna ofereceu "posso te ligar rapidinho?" (bot não liga; promessa falsa em 1ª pessoa).
- Regra "máx 2 balões" da config vazou (negação da Andréia = 3 bolhas; abertura David = 3).

### Extra verificado
- Feedback 👎/👍 do widget JÁ entra no prompt principal ("APRENDIZADOS DO FEEDBACK", últimos
  20) — mas NÃO no gerador de follow-up.
- Double-fire do reactive-trigger (David, 2 rows no mesmo segundo — corrida
  check-then-insert do `alreadyFired`); o agrupamento do processor absorveu (1 envio só).
  Guard barato incluído no plano.
- Transcrição de áudio ligada nos 2 agentes ✓ (queixa de julho era da era pré-v3).

## Plano v4

### Código (global, additive, cada item com teste)
| # | O quê | Onde |
|---|-------|------|
| C1 | `relative-day-guard.ts`: rótulo relativo colado a horário — mismatch com data adjacente → strip; sem data adjacente → absolutiza ("hoje às 7 da noite" → "quinta-feira, 27/08, às 7 da noite"). Intl/DST-safe. Wire: executor (turno) + follow-up runner + test route | `src/lib/queue/` |
| C2 | `followup-repeat-guard.ts`: extrai perguntas dos outbounds anteriores (histórico), Dice token-set vs candidata; repetida → 1 regeneração com proibição explícita; repetiu de novo → cancela o toque (`followup_skipped: repeated_question`) | `src/lib/queue/` + runner |
| C3 | Escada global do follow-up por ÂNGULO (retomar assunto ≠ repetir pergunta → valor/por-quê → oferta direta/porta aberta) no `buildFollowUpPrompt`; injeta 👎 recentes | `sales-prompt-builder.ts` |
| C4 | Pre-send pause re-check no executor: conversation_state re-lido antes do envio; pausado durante o turno → suprime envio + audita (`send_cancelled_paused_mid_turn`). Mata a corrida GU-7 | `action-executor.ts` |
| C5 | MC-3v2: no targeting_skip do processor, re-roda o roteador nos OUTROS agentes ativos (failMode closed); casou → re-atribui as rows e reprocessa (`targeting_reroute`) | `queue-processor.ts` |
| C6 | Canal do trigger reativo = canal do último inbound do contato (fallback SMS) | `reactive-trigger.ts` |
| C7 | Recap determinístico de booking: agendou com sucesso → bolhas com horário divergente do slot real são substituídas pelo rótulo determinístico (família H50 booked_label) | `action-executor.ts` |
| C8 | Title default do appointment: "Zoom - <agente> - <lead>" quando o modelo mandar null | `action-executor.ts` |
| C9 | Dedup do reactive-trigger: claim atômico (INSERT em `sparkbot_dedup_locks` c/ chave `reactive:` antes do enqueue) | `reactive-trigger.ts` |

### Config (apply-alves-cury-v4.ts, idempotente, agentes seguem INACTIVE)
| # | O quê |
|---|-------|
| K1 | Targeting por INTENÇÃO+headline+campos: Bruno = msg contains "agente financeiro" OU "Oportunidade para brasileiros" OU cf AI=Recruit OU cf tUpk=Recrutamento; Bruna = msg contains "seguro" OU "proteção financeira" OU "Uma história real de proteção" OU cf AI=Venda. Clientes existentes seguem fora (skip correto preservado) |
| K2 | "CAMPANHA DESTA CONVERSA" reescrita nos 2: PROIBIDO negar a outra frente (a empresa FAZ as duas); lead da campanha errada → reconhecer + redirecionar em 1 frase sem negar |
| K3 | Banir justificativa instrumental de QUALQUER pergunta ("com isso consigo te passar/avançar/preparar...") — pergunta simples, sem moeda de troca. Nos 2 + custom_prompt do follow-up |
| K4 | Ponte-pro-Zoom obrigatória ANTES de horários, com o PRA QUÊ explícito (Zoom de ~30min com especialista, sem compromisso, número/detalhe exato) — feedback 28/08 |
| K5 | Meta-narração proibida (idioma, "vou fazer X") — apenas faça |
| K6 | Tom recalibrado: bolhas curtas, warmth, emoji leve permitido (máx 1, momentos positivos, nunca em objeção); gíria pesada segue banida; abertura sem fragmento; wrong-number/inglês → responde no idioma do lead |
| K7 | Proibir oferta de ligação em 1ª pessoa ("posso te ligar") |
| K8 | Follow-up custom_prompt: ângulos por toque + nunca repetir horário específico de oferta anterior (convida a escolher de novo) |

### Validação
1. Testes unitários novos (C1/C2/C7 replay das strings REAIS de prod — regra H85).
2. `stress-alves-cury-v3.ts` (regressão S1-S5 + bateria v3) + cenários v4: lead recrutamento
   caindo na Bruna (não pode negar), ponte antes de slots, follow-up sem repetição, wrong
   number EN, "renda extra é possível?" (pergunta real da Andréia), tricky de valor.
3. Workflow qualitativo multi-persona + juízes (checklist dos feedbacks do Marcos).

## EXECUÇÃO (31/08, overnight) — TUDO APLICADO

- **Código (H88)**: C1-C9 implementados, commit `8cb422f` + `bd511a9`, deploy Ready.
  - ⚠️ Descoberta no caminho: **`CUSTOM_INSTRUCTIONS_CAP=8000` truncava EM
    SILÊNCIO o final das instruções** — a v3.3 tinha 10,6K chars, então as
    REGRAS ANTI-INCIDENTE (campanha/2-tempos/anti-hoje-amanhã/máx-2-balões)
    NUNCA chegaram ao modelo em produção. Os "vazamentos de regra" da janela
    eram regra invisível. Cap → 16000.
  - ⚠️ Bug de regex achado no replay: `\b` do JS é ASCII-only — `amanhã\b`
    NUNCA casa. Lookarounds unicode no lead-day-guard.
- **Config v4.1** aplicada nos 2 agentes (apply-alves-cury-v4.ts, idempotente,
  3ª rodada = 0 edits). Agentes seguem `inactive`.
- **Validação**:
  - test-lead-day-guard **19/19** · test-followup-repeat-guard **14/14** (replay
    de strings reais) · test-alves-targeting-v4 **11/11** (corpos reais da
    janela: Andréia→Bruno, headline-só→Bruna, clientes existentes fora).
  - Bateria v4 em prod (test endpoint): **14/14** — sem negação de frente +
    handed_off na 1ª resposta, ponte Zoom antes de horário, espanhol sem
    meta-narração, wrong-number em inglês, sem custo de licença, transversais
    limpos (a 1ª rodada pegou 2 vazamentos → v4.1 → limpo).
  - Regressão v3 em prod: **25/25** (asserção de emoji atualizada pra política
    v4 — máx 1 leve/bolha, calibrada pelos 👍 do Marcos).
  - E2E do guard de follow-up com LLM real: 1/4 gerações repetiu a pergunta →
    guard pegou → regeneração salvou o toque com ângulo novo.
  - Workflow qualitativo rodada 1 (8 personas + 8 juízes + síntese): **5/8
    aprovados** — Bruno 3/3; mecânica dura (datas 8/8 verificadas contra o
    calendário real, fuso, preço, negação de frente, ponte) confirmada
    resolvida. 3 reprovações da Bruna → rodada 2:
    - venda-apressada: fechava "ligação" gravando title "Zoom -" → bloco CANAL
      NEGOCIADO (config) → **re-aprovado** (title "Ligação - Seguro de vida" ✓).
    - venda-curiosa-recrut: curiosidade derrubava o funil (handed_off +
      move_pipeline) → distinção na regra de campanha (config) → **re-aprovado**
      (responde curto + volta pros horários, zero handoff).
    - venda-evasiva: 3ª pergunta idêntica → guard de CÓDIGO `turnRepeatVerdict`
      no processor + test route (3ª ocorrência regenera 1x; persistiu →
      re-pergunta é REMOVIDA). 1º re-teste ainda reprovou e o juiz achou o furo:
      a ELIPSE do PT ("Você mora em qual?") virava só o token "mora", fora da
      família estado → r2.1 adiciona mora/vive/reside à família (+ neutraliza o
      idiom "faz sentido" que colidiria com a família trabalho) → **re-aprovado**
      (teto de 2 pedidos respeitado, funil seguiu, booking ok).
    - Padrões menores dos juízes tratados em config: teatro de agenda ("deixa
      eu ver a agenda") banido, CTA obrigatório em turno de reação, despedida
      sem re-emitir action, Taciana apresentada na 1ª menção.
  - **Placar final: 8/8 críticas graves fechadas** (5 na rodada 1 + 3 nas
    rodadas 2/2.1). Bateria determinística v4 re-rodada após cada rodada:
    14/14 sempre.

## Checklist de religa (👤 Pedro/Marcos)

1. `UPDATE agents SET status='active' WHERE id IN ('a0339877-...', 'e698f2b4-...')`
   — **OS DOIS JUNTOS, nunca um só** (Bruno desligado = funil de recrutamento
   invisível; foi metade do churn).
2. Avisar o Marcos: ele NÃO precisa mais setar o campo AI por lead — lead de
   anúncio ativa sozinho (palavra-chave/headline). O campo AI vira só o
   kill-switch por contato (Off) e ativação manual de lead antigo.
3. Combinar com o Marcos o texto do aviso de handoff (quando um lead da
   campanha errada cair com o agente errado, o time é notificado via SparkBot).
4. Validar 1 lead real de cada funil no dia da religa (hypercare: conferir
   execution_log targeting_reroute/targeting_skip nas primeiras 24h).
5. Decidir IG orgânico (caso Cássia): se a Bruna deve atender DM orgânica,
   é 1 regra de config a adicionar.

### Fica pro Pedro (👤)
- **Religar**: os DOIS agentes juntos (`status='active'`), nunca um só. Checklist no fim.
- Pílula GU-7: lista de agentes pode ficar stale (Bruno religado não aparecia); refresh ao
  abrir popup — item de frontend, fora do escopo desta noite.
- Duplicação visual no GHL: explicar pro Marcos que é o provider SMS custom dele ecoando
  (com C6 os proativos saem por WhatsApp e o dup some dos NOSSOS envios).
- IG orgânico (caso Cássia "vocês estão abertos?"): decidir se a Bruna atende DM orgânica
  (1 regra de config liga).
- Slots no fuso do lead (R4c): fase 2 se a bateria mostrar necessidade.
