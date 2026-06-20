# Estudo — Fluxo de Follow-up da Jussara (SparkBot)

> Pedro 2026-06-19/20. Caso real: Jussara (corretora de seguro de vida, +16892033343) tentou
> montar pelo SparkBot um fluxo de follow-up GIGANTE de no-show e o bot "não deu conta".
> Conversa crua: `conversa-raw.txt` (200 msgs). Extração estruturada por workflow (4 frentes):
> task `wufao7pv5`. Este doc = itens 1,2,4 + gap. Plano de implementação: `PLANO.md` (item 3,5).

---

## 0. Achados que pesam mais (ler primeiro)

1. **🔴 P0 OPERACIONAL — confirmações FALSAS de agendamento.** O bot disse "agendado" pra ~7
   clientes mas **não agendou nada** (admissão dele: *"não agendei as mensagens nas confirmações
   anteriores porque não tenho o número... precisaria agendar uma por uma via `schedule_message_to_contact`"*).
   A Jussara acredita que disparou 7 fluxos; **a realidade é zero**. Isso é o pior tipo de bug
   (mentira de sucesso) e existe HOJE, independente da feature nova. Precisa de decisão imediata
   (avisar a Jussara + corrigir o gate que deixa o bot afirmar "agendado" sem ter agendado).
2. **🟠 Ingestão de REPLY/citação quebrada.** Quando ela responde citando um bloco e escreve
   "aqui"/"ta bom", o bot só recebe o texto novo e **perde o trecho citado** (vários: *"cada vez
   que você mandou 'aqui', só recebi o texto 'aqui' sem conteúdo"*). Gerou muita frustração.
3. **🟠 A feature de follow-up (H33) não suporta o fluxo dela — por 5 limites duros.** Detalhe na §3.

---

## 1. O que a Jussara pediu (mapa completo)

### 1a. O fluxo de no-show (núcleo)
Sequência de **reativação de lead que não compareceu** (no-show) + nutrição de longo prazo, para
leads de **seguro de vida com benefício em vida** (mercado brasileiro nos EUA). Ela ditou em pedaços
e produziu **duas versões que se sobrepõem** (não há fluxo único fechado — há ambiguidade real):

- **Versão DETALHADA/original** (colada por ela): Dia 0 no-show (+30min, 3 msgs a +30s cada),
  Dia 1 (cotação, +MSG história Natália +30min), Dia 2 "último lembrete" (+vídeo Rickson), Dia 5
  (3 msgs), Dia 10 (reengajamento "90% das famílias", 3 msgs com +2min/+1min), Dia 15 (encerramento
  + indicação work-permit), e bloco **SEMANAL "após 1 mês"** (Natália 280k, material seguro, live
  advogada Guardião de Menores, estratégia Baldi).
- **Versão LIMPA/final** (colada 2x, com link de agenda em TODA msg): 30min/+1d/+2d(Natália)/
  +4d(Alessandra Vimeo)/+7d/+10d/+15d/+30d. **Foi a que ela mandou disparar** — e o bot "agendou"
  só **8 mensagens** (Dia 0,1,2,4,7,10,15,30).
- **Adições incrementais** entre as duas: Dia 3 (Alessandra), Dia 4 (reagendamento), Dia 7/12/16
  (reels IG), e o **bloco "a cada 2 dias"** do Dia 18 ao 40 (7 links IG) + continuação 32→40.

**Características que definem a complexidade:**
- **~20+ passos** (Dia 0,1,2,3,4,5,7,10,12,15,16,18,20,22,24,26,28,30,32,34,36,38,40 + semanal).
- **Múltiplas mensagens no MESMO dia** com delay intra-dia (Dia 0 = 3 msgs +30s; Dia 2 = msg +30min;
  Dia 10 = 3 msgs +2min/+1min).
- **Mídia em quase todo dia**: Vimeo, YouTube, **Instagram reels/posts**, vídeo .mp4 anexado, imagem.
- **Agendamento por dia-relativo POR mensagem** (Dia 0 / +2 / +5 / +10...).
- **Condicional** "se não respondeu" por etapa (no-show → só segue se não remarcar).
- **Cíclico/evergreen**: *"quando finalizar o 40 dias volta pra o 1 dia e continua o fluxo"*.
- **Personalização** `[nome]` / `[Primeiro Nome]`.
- **Link de agenda** (`internal.sparkleads.pro/widget/bookings/consulta-inicial-jussara`) em toda msg.

> Conteúdo verbatim dia-a-dia (as duas versões + ambiguidades de mapeamento link↔dia) está na
> extração `wufao7pv5` (campo `seq`) e na `conversa-raw.txt`. Não recopio aqui pra não fixar uma
> versão — **uma das decisões pro Pedro/Jussara é qual versão é a "oficial".**

### 1b. Pedidos ALÉM do texto das mensagens (categorizado)
| Categoria | Pedidos |
|-----------|---------|
| **aplicar-a-contato** | Aplicar o MESMO fluxo a 7+ contatos: Eliz Cruz (508)740-9145, Lany, 678-830-3424, (862)410-8006, (727)623-3535, 609-850-7781, santanajova013 — sempre com tag **`no-show`** |
| **gatilho por tag** | "coloca a tag no-show no [nome]" → **dispara o fluxo automático** (ela confirmou "Confirmar ✅") |
| **mídia** | Vídeo/imagem/reel IG anexados em quase todo dia (≠ só link no texto) |
| **cíclico** | Ao terminar, volta ao dia 1 |
| **conteúdo-em-massa** | "vou mandar vários links e vc faz a cada 2 dias com vídeo+imagem+texto que vc cria" |
| **export-pdf** | "me manda em PDF esse fluxo separado por dias e tempo de envio" |
| **agenda/booking** | Passo-a-passo do link compartilhável + incluir o link em toda msg |
| **gerar texto** | "cria um texto pra esse vídeo", "melhore", "que vc sugere?" (copywriting assistido) |
| **revisar/recuperar** | "me manda as mensagens que vc criou", "manda os 10 primeiros dias", "vai juntando até o dia 10" |
| **confirmar disparo** | "foram agendadas as 30 mensagens?", "porque só 8 se mandei 30 dias?" |

---

## 2. O que o SparkBot JÁ consegue (follow-up H33)
(arquivos: `followup/` + `tools/followup.ts` + `proactive/followup-runner.ts` + `00067`)

- ✅ Criar **1 sequência de 1–3 mensagens de TEXTO** pra **1 contato**.
- ✅ Agendar a 1ª msg por dia-relativo simples ("daqui 2 dias", "tomorrow 10:00", ISO).
- ✅ Espaçar as 2–3 msgs por **offset em horas** da primeira (default 48h).
- ✅ **stop-on-reply** binário (para a sequência inteira no 1º reply do lead).
- ✅ Editar/pausar/retomar/cancelar/listar/progresso; spam-score adaptativo; internal_reminder.
- ✅ Runner com claim atômico (MAX_PER_TICK=30), re-checa reply/opt-out/DND a cada envio.

---

## 3. Gap — onde trava o fluxo da Jussara (com âncora de código)

| # | Limite (HOJE) | Âncora | O que ela precisa |
|---|---------------|--------|-------------------|
| **L1** | **Máx 3 msgs/sequência** (clamp duro em 4 lugares) | `tools/followup.ts:87`, `settings-loader.ts:15`, `core.ts:153-157`, `sequence-generator.ts:67,153` | 20+ passos |
| **L2** | **ZERO mídia** (só coluna `message_text`; envio só `{type,contactId,message}`) | `00067:102`, `followup-runner.ts:355-360` | vídeo/imagem em quase todo dia |
| **L3** | **Sem multi-msg/dia + delay intra-dia** (só offset_hours de 1 base) | `sequence-scheduler.ts:94`, `core.ts:225` | Dia 0=3 msgs +30s; Dia 2 +30min |
| **L4** | **Sem agendamento dia-relativo POR msg** (1 base + offsets que o LLM inventa) | `sequence-scheduler.ts:153-219` | Dia 0/+2/+5/+10 fixos por msg |
| **L5** | **Sem cíclico/evergreen** (`completed` é terminal; `recurring` é DEAD CODE no enum) | `followup-runner.ts:602-605`, `types.ts:16` vs `tools/followup.ts:95` | volta ao dia 1 / semanal infinito |
| **L6** | **Sem branching** (só stop-on-reply tudo-ou-nada) | `00067:59`, `followup-runner.ts:161-177` | "se não respondeu o dia X" |
| **L7** | **Sem rascunho persistente** ("não salvei nada, só mentalmente") → perde tudo entre turnos/contexto | (ausência de store) | montar 40 dias sem perder o início |
| **L8** | **Sem template reutilizável** desacoplado de contato | (followup é sempre por-contato no fim) | mesmo fluxo p/ 7+ contatos + tag-trigger |
| **L9** | **Sem export PDF** | — | "me manda em PDF" |
| **L10** | **Ingestão de reply/citação quebrada** | (parser Stevo) | citar bloco + "aqui" |
| **L11 (P0)** | **Bot afirma "agendado" sem agendar** | (gate de honestidade no prompt/tool) | confiança |

---

## 4. Melhorias nas sequências de follow-up (independente da Jussara, valem pra todos)
1. **Estado de rascunho persistente** (resolve L7): um objeto "sequência em construção" que acumula
   dias/mensagens/links/mídia entre turnos e sobrevive à janela de contexto — o bot lê/edita esse
   objeto em vez de "lembrar mentalmente". (É a peça-mãe; sem ela, fluxo grande é impossível.)
2. **Templates de sequência** (resolve L8): uma sequência salva 1x e **aplicada a N contatos** /
   disparada por **tag/estágio** (o caso "tag no-show → dispara"). Reusa o targeting/reaction-engine.
3. **Honestidade de disparo** (resolve L11/P0): o bot NUNCA diz "agendado" sem o insert ter retornado
   sucesso; gate determinístico que reflete o estado real da campanha.
4. **Mídia nativa** (L2): anexar vídeo/imagem (Vimeo/IG/upload) — não só URL no texto.
5. **Modelo dia-relativo + multi-msg/dia** (L3/L4): cada passo = (offset em dias, hora, [msgs com
   delay intra-dia]). Mais expressivo que "offset_hours de 1 base".
6. **Evergreen/cíclico** (L5): ativar o `recurring` que já existe meio-morto, com loop real.
7. **Variação anti-repetição** (reusar o variator das campanhas de grupo) pra nutrição longa.

---

## 5. Plano de implementação
→ Ver `PLANO.md` (gerado na iteração 3, com arquitetura faseada). Em aberto: **decisões pro Pedro**
(qual versão do fluxo é oficial; reusar o motor de bulk-sequences vs estender o followup; escopo do
MVP: persistência+templates+honestidade primeiro, mídia/cíclico/PDF depois).
