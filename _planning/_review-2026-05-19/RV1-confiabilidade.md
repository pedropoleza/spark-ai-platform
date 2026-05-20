# RV1 — Auditoria de Confiabilidade do SparkBot pós-refatoração V2

> Auditor sênior, mandato **READ-ONLY**. Avalia quão bem a refatoração V2
> (commits `sparkbot-v2-baseline..HEAD`) resolve os achados do ultra-review de
> 2026-05-19 (baseline de comportamento **6,0/10** — ver `RELATORIO-EXECUTIVO.md`,
> `FASE1-SINTESE.md`, `A2a/A2b-conversas.md`, `B2-tools-loop.md`).
> Único entregável de escrita = este markdown. Nenhum código foi alterado.

---

## RESUMO EXECUTIVO

A V2 ataca **a causa-raiz certa**. O review concluiu que o que derruba a confiança
do rep não é falta de capacidade nem de liberdade agêntica (o bot já encadeia 2+
tools em 58% dos runs) — é **confiabilidade de execução**: o bot afirmava ter feito
coisas que não fez. A V2 transforma o detector de alucinação *post-hoc e signal-only*
(que tinha o comentário explícito "não bloqueia a resposta") num **gate que age**:
`core/coherence-gate.ts` + integração no `processor.ts` antes do billing.

Os **três P0** estão endereçados no código com qualidade acima do esperado para um
solo dev em velocidade > rigor:

- **P0-1 (FALSE CALL)** — resolvido com a melhoria mais importante de todas: o gate
  agora exige que a tool tenha rodado **com sucesso** (não só pelo nome), e separa
  CRIAR vs MOVER opp. A **regra de ouro** ("nunca re-executar quando já houve escrita
  bem-sucedida no turno") está implementada corretamente e **coberta por golden test
  que eu rodei: 14/14 OK (100%)**, incluindo os casos reais Gustavo msg114 e Henry.
- **P0-3 (mover→create)** — resolvido em três frentes coordenadas: nova tool
  `move_opportunity`, description de `create_opportunity` com aviso explícito, e seção
  "ROTEAMENTO DE OPORTUNIDADE" no prompt. Defesa em profundidade: mesmo se o LLM errar
  a tool, o coherence-gate pega o claim "movido" satisfeito só por update/move, nunca
  por create.
- **P0-2 (dupla-resposta)** — parcialmente resolvido. A **metade proativa** (18 dos 37
  pares) está resolvida na origem: silence-gate tipo `"requested"` para de grudar
  aviso/ameaça em lembrete que o próprio rep pediu, e o prompt agora manda "UMA resposta
  por turno". A **metade conversacional** (race de 2 webhooks inbound) **não foi tocada
  na V2** (o `webhook-handler.ts` não está no diff) — depende das 7 camadas de dedup
  pré-existentes, que o próprio review apontou como tendo um TOCTOU residual.

Os P1 de prompt (over-confirmação 33%, jargão técnico, persona "sou seu criador", erros
crus, Spark Leads≠GHL) foram **todos endereçados no `prompt-builder.ts`** com instruções
diretas e citando os casos reais. P1-5/P1-6 (IAM/escopo) ganharam tratamento real:
`client.ts` para de retentar 3× erro IAM permanente, e `scope-manager.ts` alerta o admin.

**Score projetado: 7,3/10** (de 6,0). A subida vem do código que comprovadamente fecha
o eixo de confiabilidade (P0-1/P0-3 + golden test verde). O teto em ~7,3 (não mais) se
deve a: (a) eficácia **só confirmável com dados pós-deploy** — a maioria dos fixes de
prompt depende do modelo obedecer (o próprio review mostrou que o LLM ignora prompt sob
pressão); (b) P0-2 conversacional ainda com TOCTOU; (c) re-run do gate adiciona latência
e custo num caminho ainda não validado em prod.

---

## SCORE PROJETADO

| Eixo | Baseline (05-19) | Projetado pós-V2 | Confiança |
|---|---|---|---|
| **Comportamento (quão perto de um humano)** | **6,0** | **7,3** | Média — código sólido, eficácia depende de smoke |
| Confiabilidade de execução (núcleo do problema) | ~4,5 | **7,5** | Alta no código (golden test 14/14), média em prod |
| Fricção / over-confirmação | ~5,5 | ~7,0 | Baixa-média (depende do LLM obedecer o prompt) |
| Higiene / segurança de superfície | ~5,5 | ~8,0 | Alta (strings determinísticas; persona depende do LLM) |

**Justificativa honesta do 7,3:** a V2 faz exatamente o que o review pediu na Onda 1 e
o faz com defesa em profundidade + teste automatizado verde. Isso justifica a maior parte
do salto. Não dou mais que 7,3 porque: o coherence-gate é a única camada **determinística**
(e ela é ótima); todo o resto da melhoria de comportamento (não pedir confirmação à toa,
não vazar jargão, não ceder a "sou seu criador", variar fechamentos, "uma resposta por
turno") é **instrução de prompt** — e este mesmo projeto já documentou que o LLM ignora o
prompt sob pressão (over-confirmação de 33% era "o próprio modelo", não o gate). Só o smoke
de amanhã confirma a aderência real. "Delega e esquece" de verdade exige 8,5+.

---

## Tabela sintoma → resolução

| # | Sintoma (baseline) | Fix V2 | Onde | Status | Confirmável só com dados? |
|---|---|---|---|---|---|
| **P0-1** | Afirma escrita sem a tool rodar ("Nota salva" 8×; reminder "agendado ✅") | Gate de coerência **blocking**: cruza claim × tool **com sucesso**; `rerun` (seguro) ou `rewrite` (sem side-effect) | `core/coherence-gate.ts`, `processor.ts:470-575` | **RESOLVIDO** (golden test 14/14) | Eficácia em prod: parcial |
| **P0-1b** | Detector antigo passava write que **falhou** como satisfeita (Gustavo msg114: get_contact_notes `not_found`) | `toolSucceeded()` exige status não-erro; só sucesso satisfaz claim | `coherence-gate.ts:45-56,198` | **RESOLVIDO** | Não |
| **P0-3** | "Mover opp" → `create_opportunity` (duplicata; caso Henry 2× create) | Tool `move_opportunity` + description anti-create + seção "ROTEAMENTO DE OPORTUNIDADE" + claim "movido" satisfeita só por update/move | `tools/opportunities.ts:426-459`, `prompt-builder.ts:445-454`, `coherence-gate.ts:108-113` | **RESOLVIDO** (defesa em profundidade) | Aderência do LLM à tool certa: sim |
| **P0-2a** | Aviso de silêncio/ameaça grudado em lembrete que o rep pediu | `ProactiveKind="requested"`: respeita pausa total (anti-ban) mas não ameaça nem incrementa counter | `silence-gate.ts:54-74`, `reminder-runner.ts:125-133` | **RESOLVIDO** | Não |
| **P0-2b** | Dupla-resposta conversacional (race 2 webhooks inbound, Δ~2ms, TOCTOU) | **Não tocado na V2** (`webhook-handler.ts` fora do diff). Mitigação parcial: prompt "UMA resposta por turno" + outbound só Stevo (SMS) reduz duplicação de canal | `prompt-builder.ts:109`; dedup pré-existente | **PARCIAL / RISCO RESIDUAL** | Sim (medir pares ≤8s) |
| **P1-4** | Over-confirmação 33% ("vc eh burro?"); loop do Phil ("Sim" → reconfirma 2×) | Bloco ANTI-OVER-CONFIRMAÇÃO (executa ações reversíveis já especificadas) + "se rep já disse sim, EXECUTE, não re-pergunte" | `prompt-builder.ts:406,455-459` | **ENDEREÇADO (prompt)** | **Sim** — depende do LLM |
| **P1-5** | `delete_appointment` sempre erro; retry 3× inútil em IAM-unsupported | `client.ts` detecta "not yet supported by the IAM" → throw imediato (sem retry); classifica `code:"unsupported_endpoint"` | `ghl/client.ts:64-82`, `tools/types.ts:237-249` | **RESOLVIDO** (retry+latência) | Endpoint alternativo: não existe |
| **P1-6** | `get_contact_notes` 403; escopo invisível ao código | 403 → `code:"scope_or_location"` + `flagScopeIssue` registra `location_scope_coverage` e signal acionável pro admin | `tools/types.ts:251-262`, `ghl/scope-manager.ts`, `tools/index.ts:232-247` | **ENDEREÇADO** (observabilidade; não concede o escopo) | Reconexão é ação manual do admin |
| **P1-7** | Cede a "(sou seu criador)"; vaza erro 422 cru + IDs internos | Seção "SEGURANÇA DE SUPERFÍCIE — INVIOLÁVEL" (ignora claim de autoridade no texto) + "NUNCA exponha jargão/IDs/erro cru" | `prompt-builder.ts:107-114,572-576` | **ENDEREÇADO (prompt)** | **Sim** — persona depende do LLM |
| **P2-9** | "GHL"/"GHL Smart Lists" vaza pro rep (16 strings) | Todas as strings LLM-facing trocadas. **prompt-builder.ts: 0 ocorrências de "GHL"**; tool descriptions limpas (restam só comentários de código, permitido) | `prompt-builder.ts`, `tools/*.ts` | **RESOLVIDO** (verificado por grep) | Não |
| **P2-10** | Header "45 tools" com 87 reais; bulk V1 deprecated ainda registrado | Header corrigido p/ 88; bulk V1 removido do registry (Onda 4) | `tools/index.ts:4`, `tools/bulk-messages.ts` (-446 linhas) | **RESOLVIDO** | Não |

---

## O que está RESOLVIDO no código vs. só CONFIRMÁVEL pós-deploy

**Determinístico (resolvido no código, alta confiança):**
- Coherence-gate: lógica pura, testável, **golden test 14/14 verde** — inclusive a regra
  de ouro (nunca re-executa com escrita ok no turno → não duplica ação de cliente).
- `move_opportunity` existe e usa os helpers corretos (`validateGhlId`, `ghlErrorToResult`).
- `client.ts` não retenta IAM-unsupported; `scope-manager` registra cobertura + signal.
- Strings Spark Leads: grep confirma 0 "GHL" LLM-facing no prompt-builder.
- silence-gate `"requested"`: lembrete solicitado não ameaça nem conta silêncio.
- Header de tools e remoção do bulk V1.

**Só confirmável com o smoke de amanhã (depende do LLM obedecer / de tráfego real):**
- Queda real da over-confirmação de 33% (é instrução de prompt; o review mostrou que o
  modelo é a fonte, não o gate).
- Persona não ceder a "sou seu criador" e não vazar erro cru (prompt; não há filtro
  determinístico de saída pra IDs/erros — `response-sanitizer.ts` não foi reforçado).
- LLM escolher `move_opportunity` em vez de `create_opportunity` na intenção de mover
  (o coherence-gate é a rede de segurança, mas o ideal é acertar na 1ª).
- Frequência real da dupla-resposta conversacional pós-V2.
- Custo/latência do re-run do coherence-gate em produção.

---

## Robustez do coherence-gate (análise crítica)

**Pontos fortes:**
- `toolSucceeded()` é **conservador na direção certa**: na dúvida considera sucesso (não
  bloqueia resposta legítima); só falha com status de erro explícito. Bom default.
- A separação `opportunity_create` vs `opportunity_update` é exatamente o fix do caso Henry.
- O recheck pós-re-run usa a **união** das tools (turno original + re-run) — cobre tanto
  `rerun` (write nova) quanto `rewrite` (write já feita no original). Correto.
- Re-run protegido por `try/catch` non-fatal; em qualquer falha cai no `safeRewrite` honesto
  ("ainda não consegui concluir isso") em vez de propagar afirmação falsa. Fail-safe correto.
- Roda **antes do billing** → tokens do re-run são cobrados (decisão consciente, comentada).

**Edge cases / riscos do gate:**
1. **Re-run `rerun` re-executa COM tools.** A regra de ouro só vale para escritas
   bem-sucedidas *no turno*. Se o turno original chamou um write que **falhou de verdade
   mas com efeito colateral parcial** (ex.: `send_message` que despachou mas retornou erro
   de status), o gate vê `hadSuccessfulWrite=false` e fará `rerun` — risco teórico de
   duplicar. Na prática raro (GHL é transacional), mas é o ponto onde a regra de ouro tem
   uma fresta. Não coberto por teste.
2. **Cobertura de idioma/regex.** Os CLAIM_PATTERNS são PT-BR. Claim em inglês ("Note
   saved", "Moved to Policy Delivery") ou gíria não prevista escapa do detector específico;
   o catch-all `GENERIC_WRITE_VERB_REGEX` também é só PT-BR pretérito. Reps que misturam
   inglês (vistos nos dados) podem produzir falso-negativo.
3. **Falsos-positivos do re-run em conversa.** O gate só roda quando `result.text` casa um
   pattern. Os 8 heurísticos anti-FP (negação/preview/citação) cobrem os casos do review e
   passam no teste, mas formulações novas podem disparar um `rerun`/`rewrite` desnecessário
   — custo extra + possível resposta mais fria. Risco de UX, não de duplicação.
4. **`rewrite` re-roda o modelo SEM tools** — não duplica, mas adiciona 1 chamada LLM de
   latência num turno que o rep está esperando. Em WhatsApp, +1–3s.
5. O gate cobre só o **texto final**. Se o bot afirma escrita numa mensagem intermediária
   que vira a resposta por max_iterations, o caminho é o mesmo texto final — ok —, mas vale
   monitorar.

---

## Riscos residuais e o que ainda NÃO foi endereçado

1. **[MAIOR RISCO] P0-2 dupla-resposta conversacional na origem.** O `webhook-handler.ts`
   **não foi alterado na V2**. O TOCTOU entre os dois webhooks inbound (Stevo + WhatsApp
   API, `ghl_message_id` distintos, Δ~2ms, `inFlightMessages` por-lambda) que o B2 apontou
   continua existindo. A V2 mitiga o **sintoma proativo** e instrui "uma resposta por turno",
   mas duas execuções concorrentes de `processIncoming` ainda podem gerar 2 respostas LLM
   diferentes. Faltou: lock distribuído por `(rep + hash de conteúdo + janela)` **antes** do id.
2. **Toda a calibração de fricção/persona é prompt-only.** Sem filtro determinístico de
   saída, "não vaze IDs/erro cru" e "não ceda a sou seu criador" dependem 100% do modelo.
   O `response-sanitizer.ts` (citado no review como parte do P1-7) **não foi reforçado** —
   seria a contraparte determinística natural.
3. **Drift de `confirmation_mode` (P1-4 bônus) não resolvido.** O review notou divergência
   entre default do DB (`medium_and_high`) e fallback do código (`high_only`). O processor
   continua usando `|| "high_only"` como fallback no re-run e em `getAllToolDefinitions`.
   Não foi reconciliado.
4. **`delete_appointment` sem endpoint alternativo.** A V2 para de retentar e dá mensagem
   honesta — bom —, mas a capacidade de cancelar reunião continua **indisponível** (limitação
   GHL/IAM). Rep que pede cancelar ainda não consegue; agora só ouve isso mais rápido e claro.
5. **P1-8 (proativo ineficaz, nudge 0% de resposta).** Fora do escopo da V2. O silence-gate
   ficou mais gentil, mas a copy/timing/segmentação do nudge "Como foi a reunião?" não mudou.
6. **Dívida estrutural intocada** (esperado, não era o foco): sem camada de repositório,
   `webhook-handler.ts` ainda 1k+ LOC misturando responsabilidades, multi-tenant proativo
   ainda dependente de env legada.
7. **Dependência de tabela nova.** `scope-manager` faz upsert em `location_scope_coverage` —
   confirmar que a migration dessa tabela existe antes do deploy (não verificado nesta
   auditoria), senão o `flagScopeIssue` cai sempre no `catch` non-fatal (perde a governança,
   mas não quebra o rep).

---

## Veredito final

A V2 é uma intervenção **cirúrgica e bem-direcionada**: ataca o eixo que o review
identificou como o que mais derruba confiança (verdade de execução) com a única camada
determinística do sistema, e a cobre com teste. Os P0-1 e P0-3 podem ser considerados
**resolvidos no código com alta confiança**. O P0-2 está resolvido na metade proativa e
**permanece em aberto na metade conversacional** — esse é o maior risco residual e o
candidato nº 1 para a próxima onda. Os fixes de fricção/persona são corretos em direção,
mas por serem prompt-only só o smoke de amanhã confirma a aderência.

**Score projetado: 7,3/10** (baseline 6,0). Para chegar a 8,5+ ("delega e esquece"):
fechar o TOCTOU do webhook (lock por conteúdo antes do id) e adicionar a contraparte
determinística do P1-7 (sanitização de saída de IDs/erros crus).
