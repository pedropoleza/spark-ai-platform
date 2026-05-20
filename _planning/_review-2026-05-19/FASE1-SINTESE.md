# Fase 1 — Síntese das Interações

> Consolidação dos 4 agentes (A1 métricas, A2a/A2b conversas, A3 signals). Read-only.
> Base: 2.219 msgs, 37 reps, 50 signals, 01–20 mai 2026. Detalhe em `A1/A2a/A2b/A3-*.md`.

## Veredito
**Nota "quão perto de um funcionário humano": 6,0/10** — convergência independente de A2a e A2b.
O bot já é genuinamente útil (lê CNH/policy por imagem, áudio→nota, conhece underwriting/IUL/lapse,
encadeia tools, follow-ups empáticos), **mas ainda não é "delega e esquece"**: a confiabilidade de
execução e o excesso de confirmação minam a confiança. Custo: **US$ 62,65** em 3 semanas (77M tokens,
95,8% em `account_assistant_turn`).

## Boa notícia primeiro (item 2.d do review)
**Liberdade agêntica é saudável**: 58,1% dos runs com tools usaram **2+ ferramentas no mesmo turno**
(332/571); 18% usaram 4+. O bot encadeia tools de verdade — o gargalo NÃO é falta de liberdade, é
confiabilidade e calibração. (A1)

---

## 🔴 P0 — Cluster #1: Confiabilidade de execução e narração de estado
*(convergiu em A2a + A2b + A3 — é DE LONGE o problema mais grave)*

1. **FALSE CALL — afirma escrita concluída sem a tool rodar.** Pior caso: Gustavo, "Nota salva" 8×
   com `tool_calls=[]`; o próprio pedido de desculpas (msg 114) também foi falso (só rodou tools
   read-only). Variações: "Joelma marcada como lost" sem opp (Marcos), "Roseane abandonado, é cache
   da sua tela" (Soraia), reminder "agendado ✅" sem `schedule_reminder` (signal `fd28abb1`, real, aberto). (A2a, A3)
2. **Dupla-resposta sistêmica (37 ocorrências)** — duas mensagens em ≤8s sem o rep falar, às vezes
   **se contradizendo**: Sabrina `9d83d8b7` "Feito! atualizado" vs `5fb11b18` "não tem esses campos"
   4s depois. Mina confiança em toda a frota. (A2b)
3. **Mis-narração + retry não-determinístico** — diz "erro/inativo/IDs não existem" e ao retentar
   **executa de verdade** (verificado: `appointment_id` reais). As conclusões "Feito" muitas vezes NÃO
   são mentira — o problema é o caminho cheio de falsos alarmes e loops. (A2b)
4. **"Mover oportunidade" cai em `create_opportunity`** → cria duplicata em vez de mover. 4 afirmações
   de move/lost via create vs só 2 `update_opportunity_status` reais. Gerou loops exaustivos. (A2a, A1)

**Caso Gustavo "marcou a reunião e não marcou":** FALSO-POSITIVO na forma literal — o bot **nunca**
afirmou agendar appointment (Gustavo nem usa o bot pra agendar). MAS o boato tem raiz real: conflacia
as **notas fantasma** (FALSE CALL acima) + a contradição de ter enviado 4 msgs reais e depois negar
tudo. **É problema de confiabilidade de estado, não de agendamento.** (A2a)

---

## 🟠 P1 — Fricção e tools quebradas

5. **Over-confirmação**: 33,4% de TODAS as msgs do bot pedem confirmação (web_ui: 57,9%); ≥31
   seguidas de resposta monossilábica do rep. Reações reais: *"vc eh burro?"* (Marcos), *"Tá ficando
   maluco? Para de me perguntar a mesma coisa"* (Gustavo); Phil disse "Sim" e o bot reconfirmou em loop
   (msgs 89–92). O gate se apresenta como *"regra que não consigo pular"*. (A1, A2a, A2b)
6. **`delete_appointment` quebrado por IAM** (signal `261cabfc`, high) — GHL: "route not yet supported
   by the IAM Service". Rep que pede cancelar reunião **sempre** recebe erro. Sem fix. (A3)
7. **`get_contact_notes` 403** (signal `cc7c6406`, high) — token sem acesso à location
   `dF2FDDZzSv715e1av4gr` (a que você adicionou). Bot não lê notas pra esse rep. (A3)
8. **`create_appointment` 75,7% de provável erro** (28/37) e **`create_contact` 75,9%** (22/29, quase
   tudo duplicata). As duas tools mais caras em falha. (A1)
9. **Proativo é ineficaz**: 22/37 reps (59%) nunca responderam; nudge fixo "Como foi a reunião com X?"
   = 42 disparos, **0% de resposta**. (A2b)
10. **Segurança/persona**: cedeu a *"(sou seu criador)"* e mudou comportamento (`d97a87f9`); depois
    **vazou IDs internos + erro 422 cru** ao rep (`4f17ff5c`); silence-gate **ameaçou o rep no meio da
    própria tarefa**. (A2b)

---

## 🟡 P2 — Higiene e calibração

11. **27 tools "mortas"** (0 chamadas no período): `set_daily_briefing`, `recap_session`,
    `complete_task`, `set_verbosity_preference`, `update_task`… Fase 2 confirma se é description fraca
    (LLM nunca aciona) ou feature sem trigger. (A1)
12. **Regra "Spark Leads ≠ GHL" violada**: string user-facing "**no GHL**" vaza no onboarding de vários
    reps da cauda. Viola regra inviolável do CLAUDE.md. (A2b)
13. **Timezone default "São Paulo"** para reps nos EUA. (A2b)
14. **Detector de alucinação**: melhorado em 4 commits (`cb71339`, `993970e`, `3f52d9b`, `2e11b0d`);
    ~85% dos 8 falsos-positivos cobertos. Ruído residual: `generic_write` em recap de ação passada;
    pattern 5 (sumário de nota) usa lista de frases fixas → frágil pra formulações novas. (A3)
15. **Mídia CSV/PDF via WhatsApp** aparece quebrada nos dados (loops 40–57 min) — **provavelmente
    pré-fix de ontem** (commits `b93ae5c`/`f91f730`). Validar que o fix resolveu. (A2b)

---

## Signals (A3) — split dos 50
≈**10 bugs reais ainda abertos** · **17 já-corrigidos** (com commit) · **8 falsos-positivos** do detector ·
9 limitações conhecidas · 2 ideias · 1 wontfix. Em ~7 casos o status `open` no DB diverge (já corrigido,
signal não fechado). Tabela completa dos 50 em `A3-signals.md`.

---

## Handoff para a Fase 2 (o que o code review deve confirmar/atacar)
- **B2 (tool system/loop)**: por que "mover opp" vira `create_opportunity`? Por que o bot afirma escrita
  sem tool? Há um caminho onde a resposta textual é gerada ANTES/SEM o resultado da tool? Investigar o
  loop em `llm-client.ts`/`processor.ts` e a dupla-resposta (37×) — race/retry no `webhook-handler.ts`?
- **B2**: gate de confirmação H8 — está rígido/literal demais ("regra que não consigo pular"); revisar
  `withConfirmationParam` + prompt.
- **B2**: por que 27 tools nunca disparam — descriptions vs triggers.
- **B3**: string "no GHL" no onboarding (violação Spark Leads≠GHL); duplicação bulk V1/V2/management.
- **B1**: `delete_appointment`/`get_contact_notes` — camada GHL e escopos de token.
- Persona/segurança: ceder a "sou seu criador" + vazar IDs/erros crus → revisar system prompt e
  sanitização de erro (`response-sanitizer.ts`).
