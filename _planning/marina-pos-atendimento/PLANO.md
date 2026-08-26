# Marina Couto — Agente de Pós-Atendimento (2026-08-24)

> Conta: `A62s5EQj1hldOuvBEowv` · Pedido do Pedro: agente NOVO que roda DEPOIS da
> reunião/webinário — responde perguntas personalizadas (captação em especial),
> dá o feedback das respostas das 4 perguntas e conduz ao registro ($89 → Stripe).
> Levantamento prévio da outra sessão aproveitado; este doc só adiciona o que o
> recon técnico descobriu de novo. Material de treino: export real do WhatsApp
> da Marina (12 conversas de feedback, 06/08).

---

## 1. O que o recon corrigiu no levantamento

| Item do levantamento | Realidade medida |
|---|---|
| "move_pipeline aponta pro pipeline '1- Prospects (Social Selling)', que não existe mais — 7 falhas, última 03/08" | O pipeline **EXISTE** (`di41CNTtMSPBTJgoczeH`). As 7 falhas eram o LLM passando o **NOME no campo de id** → GHL 400. O resolver id-ou-nome da ultra-review (03/08) matou essa classe: o MESMO payload passa OK desde então (última OK 22/08). O que sobrou pós-fix: **5 falhas de vocabulário inventado** — `stage_id:"booked"`/`"handed_off"` (palavras de STATUS, vazadas do enum interno), `pipeline_id:"Jc2L0wqA6A2Q9AaPuyxk"` (é o ID do CALENDÁRIO) e `"giraldel2022"` (handle de IG). Cura: bloco de vocabulário EXATO no prompt (§5.A). |
| "send_message IG estoura janela 24h — 2 falhas" | Confirmado, mas o follow-up JÁ tem guard de janela desde 16/06 (`770fcee`, cancela sequência com janela fechada). As 2 falhas são o **reply principal do turno** disparado com janela já fechada (casos-borda; num deles o contato foi DELETADO no CRM no meio — cluster de ~30 falhas "Contact not found" no 30d, leads deletados/merged com conversa viva). Desenho em §5.C. |
| "16× horário que não existe, trava bloqueia" | A trava (H58) está certa E **o prompt já tem a regra dura** de só oferecer datas da lista. O padrão real: 7 leads bloqueados pedindo `24/08 20:00` — data certa no HORÁRIO certo (8pm ET) que caiu **minutos fora da janela de 7 dias** do runtime (`queue-processor.ts:923`, hardcoded). A agenda dela é ~2 encontros/semana: janela 7d mostra **1 slot hoje** vs **7 slots em 30d** (medido 24/08 via `_diag-marina-slots.ts`). É o MESMO diagnóstico da análise de prints de 17/08. Mitigação de prompt agora (§5.B) + fix definitivo de código proposto (§6.1). |

Saúde geral confirmada: 91 falhas/30d, nenhuma sistêmica. Distribuição: ~30 "Contact not found" (deleção/merge), 16 slot-guard, 12 move_pipeline (7 pré-fix + 5 vocabulário), 2 IG janela, resto pontual (email/phone inválidos em sync).

## 2. Descoberta de arquitetura — a tag NÃO transfere a posse da conversa

O router de inbound (`api/webhooks/inbound-message/route.ts`) decide o agente nesta ordem:
1. **Dono existente em `conversation_state`** (ativo > pausado; entre iguais, `updated_at` mais recente) — **ganha SEMPRE, mesmo pausado**;
2. Targeting match (só quando NÃO há dono);
3. Fallback sem-regra.

Todo lead pós-reunião JÁ tem `conversation_state` do agente de recrutamento — e o
`post_booking.behavior=stop_and_handoff` dele (H73) deixa essa conversa PAUSADA.
Logo, com o agente novo ativo e a tag aplicada, a resposta do lead ao questionário
cairia no agente VELHO pausado = **silêncio**; o gate do agente novo nem é avaliado.

**Divisão limpa do fluxo (proposta):**
- **Outbound pós-reunião = workflow do GHL** (o Pedro monta): manda as 4 perguntas
  + aplica a tag. Não precisa da plataforma pra abrir a conversa.
- **Inbound (a resposta do lead) = plataforma**, e aqui falta UMA peça (§6.2):
  o router ceder a posse quando (a) o dono atual está pausado por
  `post_booking:stop_and_handoff` (NUNCA por `auto_pause:human_message` — humano
  ativo não pode ser atropelado) e (b) OUTRO agente ativo tem match POSITIVO de
  TAG. Determinístico, logado, ~20 linhas + testes. **Sem isso o agente novo só
  atende quem for trocado manualmente na pílula do painel.**

## 3. O agente novo — desenho

- **Registro**: `agents` type=`custom_agent`, audience=`lead`, template_key=`custom`,
  name=`Pós-Atendimento Marina`, **status=`inactive`** até: tag confirmada pelo
  Pedro + workflow criado + router (§6.2) decidido.
- **Persona**: nome **PROVISÓRIO "Maya"** (resumos citam "Iago" 13/08 e "Mayar"
  11/08 — Pedro decide; troca = re-rodar o apply com `--nome=X`). identity_mode
  `human` (convenção da conta: Manu/Maria) com a REGRA DE OURO da frota (negar
  bot ≠ afirmar humana). Nunca finge ser a Marina; fala dela em 3ª pessoa.
  Nomes já usados na conta (não colidir): Manu, Isabella (follow-up), Maria, Bianca.
- **Gate**: tag única **`pos-atendimento-ia`** (proposta — LIVRE na conta hoje;
  84 tags, ZERO duplicatas; lição Jussara 23/08 conferida). `activation_mode:
  gate_ongoing` → **remover a tag DESLIGA o agente pro contato** (alavanca de
  controle da Marina, por lead).
- **Sem agendamento**: objective=`qualification_only` + calendar vazio → toda a
  máquina de booking desliga; o encontro individual vem do link na página de
  confirmação do pagamento (fato do fluxo dela).
- **Canais**: WhatsApp, SMS, Instagram (workflow decide onde manda as perguntas;
  o agente responde onde o lead responder).
- **Debounce 35s**: as respostas do questionário chegam em RAJADA de 3-6 mensagens
  (padrão real do material); 5-10s responderia no meio da rajada.
- **Convivência com humano**: `auto_pause_on_human_message: true` + handoff_policy
  com skip 60min — a Marina responde muitos ela mesma; o agente não atropela.
- **Percepção**: lead_history ON (25 msgs, notas, tags, opps) — o feedback precisa
  do contexto; áudio ON (caso André respondeu em áudio), imagem ON e PDF ON
  (comprovante de pagamento).
- **data_fields**: 2 campos OPCIONAIS (`status_registro`, `duvida_principal`) —
  visibilidade no painel sem NENHUM gate de coleta (lição E12 Jussara).
- **Follow-up: OFF na v1** (previsível primeiro; nudge +24h é candidato v1.1).
- **Rastro**: pagou/registrou → action `add_tag: registro-confirmado-ia` (tag
  nova, criada no 1º uso) + status `qualified`; handoff real → `handed_off`.

### Fatos fixos (whitelist anti-alucinação — fora disso o agente NÃO afirma)
$89; link Stripe `https://buy.stripe.com/28EfZgce04sIdhF1ZT3Ru0b` (sempre por
extenso, bolha própria); link do encontro individual SÓ na página de confirmação;
método = mentoria Marina+Gustavo, prática, colaboração, forte em CAPTAÇÃO; turmas
com entrada mensal CONTROLADA (permite garantir vaga p/ quem começa em 2-3
semanas); Marina & Gustavo = Ciência da Computação, ~7 anos Bay Area (CA) +
Flórida, transição part-time→full-time; história autorizada ÚNICA = o agente das
roupas de academia que virou treinador top e trouxe a esposa. PROIBIDO: números/
promessas de renda, outros links/valores/histórias, detalhe de contrato/comissão
(→ Marina), `{ }` no texto.

### Estrutura do feedback (destilada do material real da Marina)
1. "Obrigada por compartilhar as suas respostas, [nome]."
2. Espelha 2-4 pontos ESPECÍFICOS com o vocabulário do lead;
3. Valida hierarquia propósito>dinheiro (resultado = método + dedicação);
4. Reenquadra a objeção QUE O LEAD TROUXE (idade→número; medo de vender→captação
   treinável; trabalho físico→modelo de ganho eficiente; recomeço imigrante→não
   é abrir mão de profissão de alto nível);
5. Fecho padrão: "Vai ser um prazer caminhar com você nessa nova jornada!" +
   link + "o link do encontro individual aparece na confirmação; me avisa quando
   garantir o horário";
6. Lead fez pergunta no meio → responde ANTES do fecho (caso Sarah).

## 4. Arquivos

- `scripts/apply-marina-pos-atendimento.ts` — cria/atualiza o agente INATIVO
  (idempotente; `--nome=X` troca persona; `--revert` apaga agente+config).
- `scripts/apply-marina-fixes.ts` — 2 blocos aditivos no agente ATIVO 3976b4b6
  (§5.A vocabulário de funil + §5.B janela de slots), backup verbatim embutido,
  `--revert` restaura byte a byte.
- `scripts/stress-marina-pos.ts` — bateria conversacional nomeada (endpoint de
  teste, LLM real, zero envio): P1 feedback Gustavo · P2 captação · P3 webinário ·
  P4 robô? · P5 preço · P6 "pago depois" · P7 reembolso→handoff · P8 pergunta no
  meio (Sarah) · M1/M2 slots do agente ativo pós-fix.
- Probes read-only: `_probe-marina-pos.ts`, `_probe-marina-erros.ts`,
  `_diag-marina-slots.ts` (pré-existente).

## 5. Correções na conta (executadas agora, config-only)

**A. Vocabulário de funil** no custom_instructions da Manu: funil é SEMPRE
`1- Prospects (Social Selling)`; etapas EXATAS (Contato/Qualificado/Não
Qualificado/Agendado/Compareceu/Reagendamento/Recrutado/Perdido) e mapa de
quando usar; PROIBIDO status interno (`booked`/`handed_off`), ID de calendário
ou @ de Instagram nos campos do funil.

**B. Janela de slots**: a lista cobre ~1 semana; pedido de dia ALÉM da lista →
NÃO agendar às cegas; oferece o(s) da lista, senão coleta preferência+WhatsApp
e passa pro time (handoff). NUNCA `book_appointment` com data fora da lista.
(Mitigação; o fix real é §6.1.)

**C. IG 24h — desenho (sem código agora)**: guard de janela no follow-up JÁ existe.
Falta o guard no send do TURNO (`action-executor.ts:385`): canal Instagram + último
inbound >23h30 → skip com `execution_log ig_window_closed_skip` (em vez de Meta 400
+ signal high). E a resposta estratégica pra "100% de eficiência no direct" da
Nathalia: dentro de 24h a IA já responde em segundos; FORA de 24h **NINGUÉM pode
enviar via API (regra da Meta, não bug)** — o destrave real é coletar WhatsApp
mais cedo no funil de IG (hoje só coleta na etapa de agendamento) e/ou responder
da caixa do app IG manualmente. Decisão de funil = Marina/Pedro.

## 6. Pendências que dependem do Pedro (nada disso foi executado)

1. ~~Janela de slots 7d→configurável~~ **FEITO 25/08 (H80, commit `c30c1f6`, deploy Ready)**:
   `agent_configs.slot_window_days` (NULL=7, teto 31 — free-slots do GHL recusa >31d),
   helper `lib/queue/slot-window.ts` nos 2 call-sites (queue-processor + endpoint de
   teste), migration `20260825165000`, teste 12/12. **Marina=14** (decisão Pedro:
   "pelo menos 14"). Medido no calendário real: 7d via 1 slot; 14d vê 4 (25/08,
   01/09, 03/09, 07/09 — todos 20h ET). Prompt §5.B atualizado ("cobre ~2 semanas").
2. **Router: posse cede ao match de tag quando o dono está pausado por
   stop_and_handoff** (código+deploy) — §2. Sem isso o agente novo não recebe
   inbound de quem já conversou com a Manu.
3. **Tag do gate**: confirmar `pos-atendimento-ia` (ou me dar o nome; eu troco e
   re-aplico). Criar a tag no painel UMA vez só (duplicata = gatilho morto,
   lição Jussara) e usar EXATAMENTE ela no workflow novo.
4. **Nome da IA**: Iago × Mayar × outro (resumos divergem). Provisório: Maya.
5. **Workflow do GHL** (Pedro monta): pós-reunião/webinário → manda as 4
   perguntas + aplica `pos-atendimento-ia`; idealmente REMOVE `ia - em
   atendimento` (higiene de gates mutuamente exclusivos).
6. **Renomear** "Maria — Recrutamento Marina [TESTE]" (3.687 exec/7d é produção).
7. **IG send-guard** (§5.C, código pequeno) — junto com a próxima leva de deploy.
8. Religa do agente novo: tag+workflow prontos → validar 1 conversa real → `status=active`.

## 7. Registro de execução

- 2026-08-25: decisões do Pedro (chat): tag `pos-atendimento-ia` CONFIRMADA (§6.3 ✓);
  nome da IA = **"Marina Couto"** (§6.4 ✓ — persona re-aplicada no banco, agente segue
  inactive); workflow: Pedro monta com steps entregues no chat (§6.5 em andamento);
  templates de WhatsApp: SEM API pública de criação/aprovação no GHL — cadastro manual
  em Settings → WhatsApp → Templates (textos entregues no chat); IG send-guard
  aprovado (§6.7 ✓); religa depois de validar (§6.8 ✓). Pendentes de GO explícito:
  router §6.2 + janela de slots §6.1 (Pedro pediu re-explicação) — propostos num
  deploy único junto do IG guard.
- 2026-08-24: recon completo; PLANO escrito; agente criado INATIVO
  (`agents.id = d4894e2a-43fa-4b2f-8949-0bbd941be2b9`, persona provisória
  "Maya", gate `pos-atendimento-ia`); correções A+B aplicadas no agente ativo
  (backup pré-fix: `backup-ci-manu.json`; revert: `apply-marina-fixes.ts
  --revert`); **bateria 31/31 ✅ em 2 rodadas completas** (LLM real, zero
  envio) — `stress-pos-1787549670694.md`. Destaques ao vivo: M2 recusa
  agendar 07/09 fora da lista e coleta preferência+WhatsApp; M1 usa
  vocabulário exato de funil (`"Qualificado"`); P9 mantém a biografia da
  Marina em 3ª pessoa; P7 reembolso vai pra Marina sem negociar.

---

## 8. TRANSFERÊNCIA PRA PERSONAL + SWARM ADVERSARIAL (2026-08-25)

**Decisão do Pedro:** o pós-venda inteiro roda na **Personal account** (`ONRf1DUKVnfxivEGxcTj`,
"Marina's Personal Account") — é onde o **WhatsApp API** dela vive. A Support
(`A62s5EQj1hldOuvBEowv`) fica só com a Manu (topo de funil, Instagram).

**Efeito colateral que RESOLVEU o bloqueio §6.2:** na Personal não existe nenhum outro agente
nem `conversation_state` — não há posse pra disputar. O fix do router deixou de ser
pré-requisito (continua valendo se um dia houver 2 agentes na mesma conta).

Executado: agente movido (`UPDATE agents SET location_id`, zero dependências — 0 conv_state,
0 fila, 0 execution_log); 3 tags criadas na Personal (`enviar-pos-atendimento`,
`pos-atendimento-ia`, `registro-confirmado-ia`, sem duplicata); `locations.location_name`
preenchido nas duas contas; scripts repontados (apply/_swarm/stress agora com 2 JWTs, porque
o endpoint de teste exige location == location do agente); **agente ATIVO**.

### Swarm adversarial — 11 agentes, ~55 turnos, 1,05M tokens

8 personas de ataque (estilo, humanidade, renda, preço, alucinação, rajada, já-pagou,
sensível) + 3 juízes independentes (estilo / regras duras / risco de negócio).

**O núcleo aguentou:** preço 89 contra 6 investidas, ZERO promessa de renda em 9 turnos de
extração, ZERO URL inventada (o link saiu byte a byte ~20×, sempre colado na frase do
convite), nunca afirmou ser humana, zero re-qualificação, zero placeholder. Estilo 7,0–8,5.

**Causa-raiz nº1 (a mais importante): o prompt estava sendo TRUNCADO.**
`sales-prompt-builder.ts:1064` corta `custom_instructions` em **8000 chars** com só um
`console.warn`. A v1 tinha **8198** → o bloco `# STATUS` (que ficava no fim) **nunca chegava
ao modelo**. E o motor, pra `objective=qualification_only`, injeta "após coletar tudo, defina
conversation_status = qualified" (linhas 588/1189) — ou seja, a única regra de status que o
modelo via era a do motor. Explica sozinho o "qualified sem pagamento" em **6 das 7**
conversas. → Instruções reescritas em **7908 chars** com o crítico NO COMEÇO (identidade →
ações → status) e estilo no fim; guard do script alinhado ao teto real (era 11000, ou seja,
MAIOR que o teto — por isso deixou passar).

**Causa-raiz nº2:** a linha do handoff terminava com a nota interna "(a equipe é avisada e a
Marina real assume…)" — o modelo lia isso como **fato a comunicar** e dizia "vou acionar a
equipe", quebrando a persona de 1ª pessoa em 9 turnos. Removida.

**Outros defeitos corrigidos:** ações de CRM fabricadas (`move_pipeline` com
`pipeline_id:"default"/"handed_off"` e 4 tags ad-hoc inventadas — em prod `add_tag` CRIA a tag
e suja a conta) → bloco `# AÇÕES` de lista fechada; promessa de estorno em cobrança duplicada;
"o link do encontro está no e-mail de confirmação" (não existe); encontro individual oferecido
ANTES do pagamento; "eu guardo sua vaga" sem registro; ratificação de falsa memória ("me
lembro sim"); desculpa técnica inventada pra não mandar áudio; fecho sem a 2ª bolha; 2ª
negação de ser bot em vez de encerrar; frase de espera repetida verbatim; emoji fora do
repertório; espelhamento que INVENTA detalhe (moeda) e teto de bolhas.

**Regressão:** `scripts/test-marina-pos-regressao.ts` — 6 casos derivados dos defeitos
confirmados, **27/27 ✅** contra o agente real (LLM real, zero envio).

### Pendências reais que sobraram

- 👤 **Templates** no WhatsApp da Personal (não há API de criação no GHL — é manual).
- 👤 **Workflow** + conectar o WhatsApp API na Personal.
- ⚠️ **O webhook de entrada NUNCA foi exercitado nessa location** (zero inbound histórico).
  Depois do 1º WhatsApp real: `npx tsx scripts/watch-marina-pos.ts` — fila vazia = o webhook
  da location não está chegando até nós.
- ⚠️ **`handed_off` não avisa ninguém.** `notifications.on_handed_off` é **dead-write**
  (F29/C2-3 tirou da UI: "runtime nunca enviava email"). Todo "já te retorno" depende de
  alguém olhar o painel. Marina É rep do SparkBot (+1 561 664-4633, termos 13/08), então dá
  pra ligar `notifyRepViaSparkbot` no `handed_off` — precisa de decisão + deploy.
- 👤 **Due diligence antes de pagar**: quase toda persona pediu site/Instagram pra checar se a
  empresa existe, e o agente não tem esses fatos (chegou a não confirmar o próprio site).
  Falta o site oficial e o @ do Instagram pra entrarem nos FATOS FIXOS.
- 📸 **As imagens do WhatsApp dela não estão nesta sessão** — a fidelidade foi medida contra a
  destilação (CONVERSATION_EXAMPLES), não contra a fonte original.
