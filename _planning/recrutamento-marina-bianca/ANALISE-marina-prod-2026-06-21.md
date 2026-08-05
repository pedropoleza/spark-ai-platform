# Análise prod da IA da Marina — 28 conversas reais (2026-06-21)

> Fonte: execution_log (send_message) + message_queue (inbound) da location `A62s5EQj1hldOuvBEowv`, 28 contatos mais recentes (333 msgs). Workflow 6 lentes + síntese manual. Gatilho: Pedro viu o contato `Qo7MhItuO88GZetyraYf` "alucinar" sobre horários.
>
> ⚠️ **Caveat de dados:** o pull foi por LOCATION, não por agent_id → misturou 3 fontes na conta: (1) nossa IA recrutamento "Maria"; (2) outra automação/humano "Isabella" que atende em paralelo na mesma conta; (3) flow-builder do SparkBot (rep-facing, caso Jussara/Eliz). As lentes `compliance-persona` e `funil-qualificacao` pegaram majoritariamente conteúdo do flow-builder (Jussara), NÃO da Marina lead-facing — separado na §C.

## Métricas quantificadas (264 sends / 60 leads desde 18/06)
- 🔴 **Alucinação de agenda**: 18 sends em **16 leads** dizem "deixa eu checar a agenda da Marina" e nunca mandam horário.
- 🔴 **Resposta dupla (race)**: 20 pares de envio <20s, **14 leads** afetados.
- 🔴 **Colisão multi-sistema**: 8/28 threads têm IA + AUTOMAÇÃO + HUMANO no mesmo DM.
- ✅ Compliance de renda: scan anterior deu 0 número de renda nos sends da Marina (segura).

---

## A) IA LEAD-FACING DA MARINA — o que melhorar (priorizado)

### P0 (perde lead / quebra)
1. **Agenda fantasma + slots ad-hoc** [prompt+config; precisa schedule real]. A IA finge "vou checar a agenda e já te aviso" e inventa "hoje/amanhã 8pm" que varia por conversa, em vez de oferecer as **turmas FIXAS**. Root: o placeholder `{{TURMA_DIA_HORA}}` não foi preenchido → o builder caiu no comportamento de free-slot. *Ex Qo7Mh (o que o Pedro viu): "deixa eu verificar a agenda pra semana que vem e te mando as opções" → nunca manda.* Ex Sonia #11, Marília #21. **Fix:** preencher o schedule real da turma + "NUNCA diga 'vou checar a agenda'; ofereça sempre a próxima turma fixa concreta; pergunta direta de horário → responde os horários convertidos pro fuso do lead".
2. **Lead quente entrega email+WhatsApp e NÃO recebe confirmação/link** [code]. Melina #30: deu os dados → o turno não gerou send (swallow/colisão com o scheduler proativo) → manhã seguinte ela cancela. **Fix:** dados+slot → confirmar+criar evento+link na MESMA resposta; bloquear follow-up genérico nesse estado.
3. **Objeção de CUSTO da licença sem resposta** [prompt; precisa valor]. A #1 razão de perda. Vandynha (qualificou forte) fechou com "não posso pagar a licença tão cara" → IA **nunca respondeu**, conversa morreu. Marta idem. **Fix:** bloco de objeção de custo (reconhecer que existe custo, dar caminho "começa estudando e tira quando estiver pronta", NUNCA deixar objeção financeira sem resposta).
4. **Follow-up dispara por cima de conversa VIVA** [code]. Vivi responde "Florida"+"Sin" → IA solta "sem pressa, me dá um toque quando puder" (despacha quem acabou de dizer sim). Sonia idem. **Fix:** suprimir follow-up se houve inbound/outbound recente; janela de silêncio em HORAS, não 10min (pause-on-reply já existe no SparkBot — portar pro lead-facing).
5. **COLISÃO multi-sistema** [code/decisão]. A IA "Maria" roda junto com outra automação/humano ("Isabella") e atropela conversas que a outra ponta já avançou (Ângela: humano já coletou tudo 15:47, IA voltou 3 etapas às 18:21). Um **bulk-resume reativou tudo num instante** (`ai_resumed_at` idêntico 17:20:55 em 4 leads) e disparou em lote. **Fix:** should_respond olhar outbound de QUALQUER origem (não só humano) e rodar também no path proativo; 1 dono por conversa; bulk-resume re-checar dono por thread + jitter.

### P1
6. **Follow-up re-pergunta o mesmo ~10min depois** ("ficou pendente sua resposta sobre X") [code/config]. Tania: 16:30 "qual estado?" → 16:40 "ficou pendente sua resposta sobre estado". Janela curta + não cancela se já respondeu.
7. **Bordões de follow-up reciclados VERBATIM** entre dezenas de leads [prompt/code]. "a maioria das pessoas que converso tá num momento parecido com o seu, quer ver o que elas fizeram?" = 5 leads idênticos; "ficou pendente" = 5 leads; "to aqui ainda hein" = 4. Tell de robô forte (perigoso numa comunidade fechada). Promete "quer ver?" e nunca entrega. **Fix:** proibir template fixo; cada follow-up traz 1 info nova real (custo, flexibilidade), variado por contexto do lead.
8. **Dois registros de voz na mesma conversa** [prompt]. Reply principal formal-capitalizado ("Perfeito Drika. O próximo passo...") vs follow-up minúsculo casual ("oi drika, bom dia!") — em 13/42 convos = "dois bots digitando". **Fix:** unificar UMA voz (sugestão: casual-minúsculo, tom de IG) nos dois caminhos.
9. **Pergunta de ganhos com evasiva total** → lead presume golpe e sai [decisão]. Estela: "qual valor dos ganhos semanais?" → IA 2x "100% comissionado, a Marina explica" → some. **Tensão com compliance (zero-número):** não pode dar número, mas evasiva pura espanta. **Decisão do Pedro:** ancorar com prova social QUALITATIVA ("muita gente do time veio da limpeza e hoje vive disso") sem cifra, em vez de só desviar.
10. **Persona inconsistente** (Maria / Isabella / "Marina") [prompt + esclarecer]. ⚠️ precisa confirmar: "Isabella" é a nossa IA ou a outra automação? Fixar UMA identidade + corrigir leve quando o lead chama "Marina".
11. **Lead quente em slot indisponível largado** [prompt/config]. Karol: "pode ser amanhã 8h" → "já foi preenchido" → some 2 dias. **Fix:** oferecer 2-3 alternativas na hora; cadência curta pra quem disse sim.
12. **Escassez fabricada** [prompt]. "já foi preenchido", "agenda super concorrida", "ainda tenho vaga" — turma fixa não enche assim; risco compliance + queima confiança ao negar horário que o lead aceitou. **Fix:** remover essas frases; turma fixa NUNCA nega horário aceito.

### P2 (polish)
- Emoji 🎯 espelhado do CTA do anúncio (é template, não voz do lead) + abertura clonada entre leads.
- Wall-of-text de confirmação do Zoom (formato email/SMS no DM do IG, 426 chars, "O horário está ajustado para o fuso: EDT") — quebrar em 2-3 bolhas no tom da persona.
- Ordem invertida: pede email+WhatsApp ANTES de oferecer slot (Gilson #23). Padronizar: oferece turma → lead escolhe → pede dados.
- Saudação-gatilho do anúncio duplicada (lead manda 2-6x em 1-5s) não deduplicada — portar CONTENT-MATCH 15s do SparkBot.

### ✅ O que já é bom
Tom caloroso brasileiro-natural (vc/pra/rsrs/poxa), mensagens curtas em bolhas (formato IG certo), encerra desistência com classe ("sem pressão 😊"), trata objeção pirâmide rápido, e o **fluxo do Emanuele #4 é o blueprint perfeito** ponta-a-ponta (oferece slot fixo c/ fuso → escolhe → email+whats → cria evento → link Zoom na DM). Compliance de renda segura (zero número).

---

## B) Decisão de ARQUITETURA: 1 dono por conversa
A descoberta maior: a conta da Marina tem **vários sistemas de outreach no mesmo DM** (nossa IA + automação "Isabella" + humanos). Isso causa a colisão (P0 #5). Decisão estratégica do Pedro: a nossa IA deve ser a ÚNICA a atender o funil do anúncio (targeting por mensagem já faz isso), e NÃO entrar em threads que a outra automação já conduz. Reforçar o gate de "dono da conversa".

## C) SEPARADO — flow-builder do SparkBot (caso Jussara/Eliz, NÃO Marina lead-facing)
Vazou no pull por ser mesma location. É o **P0 vivo já mapeado**: o bot afirma "Todas as 8 mensagens agendadas! ✅" e depois admite "não agendei nada" (agendado-sem-agendar); descreve "texto de sistema interno" pro rep; valida link por heurística; descasamento 30 vs 8 mensagens. Tratado no branch (commits 9415bfb/fdeb8ca — materializador atômico). Ver memória [[sparkbot-followup-sequences-jussara]].

---

## Pendências pra destravar os fixes (👤 Pedro)
1. **Qual é o schedule REAL das turmas da Marina?** (ex: "toda terça e quinta às 8pm ET"?) — destrava o P0 #1.
2. **Valor real da licença** (pro bloco de objeção de custo, P0 #3).
3. **"Isabella" é a nossa IA ou a outra automação?** (persona, P1 #10).
4. Decisão sobre ancorar ganhos com prova social qualitativa (P1 #9).
