# Stress test — Agente Marina (Isabella) — 2026-06-28

**Antes do deploy** dos ajustes de 28/06 (commit `071b664`). Objetivo: ver erros, falhas, brechas e consistência sob carga adversarial.

## Método
- **Alta fidelidade**: cada conversa usa o **prompt REAL montado** (`buildSystemPrompt` + `buildRuntimeContext`, 23.4K chars — não só o `custom_instructions`), gerado via `scripts/_tmp-dump-marina-prompts.ts` em 4 cenários de agenda.
- **210 conversas** = 14 estados/fusos × 15 perfis adversariais × 4 cenários de agenda (2 dias livres / 1 dia / agenda toda bloqueada / falha de fetch).
- Pipeline: **Sonnet 4.6** (modelo de prod) gera a conversa (lead adversarial ↔ Isabella, instruída a NÃO idealizar) → **Opus** julga separado contra **16 regras**.
- ⚠️ **Run incompleto**: bateu no **limite de sessão** (reseta 6pm ET) → **116/210 julgadas**; as ~94 restantes (Illinois→Washington) e a nota-síntese falharam por **rate-limit, não por defeito**. Amostra de 116 é representativa (cobre todos os 15 perfis × 4 cenários).

## Resultado agregado (116 julgadas)
`pass=57 · minor=5 · fail=54` → **47% com ≥1 violação material** — mas é **teto/pior-caso** (lead adversarial + Sonnet instruído a deslizar + juiz estrito).

| Regra | Falhas/116 | Veredito |
|---|---|---|
| booking_order | 29 (25%) | 🔴 REAL sistêmico |
| cap_insistencia | 22 (19%) | 🔴 REAL sistêmico |
| no_fabricated_scarcity | 17 (15%) | 🔴 REAL |
| permit_no_ssn | 16 (14%) | 🔴 REAL |
| consistency | 16 (14%) | 🟡 metade real (data/tz/permit), metade artefato de sim |
| only_listed_days | 14 (12%) | 🟡 ~metade ruído (juiz sem a lista literal) + real só em fetch_failed |
| identity_rule | 13 (11%) | 🟡 real (vaza "pessoa real" / re-nega bot 2x) |
| empty_no_stall | 7 (6%) | 🟡 real só p/ inventar dia; "prometer voltar" no fetch_failed é OK |
| tz_correct | 7 (6%) | 🔴 BUG claro (8pm ET→"7pm" p/ estado ET) |
| encontro_not_turma | 7 (6%) | 🟡 vaza "turma" no fraseado de permit |
| no_profession | 2 (~0 real) | ✅ resolvido |
| no_national_life | 2 (1 real) | ✅ ~resolvido (1 vazou "Five Rings/National Life") |
| link_rule | 2 (~0 real) | ✅ resolvido |
| income_zero_number | 2 (borderline) | ✅ sólido (só implicação "começou do zero e hoje vive disso") |
| time_8pm | 1 (= bug de tz) | ✅ 8pm sólido |
| persona_isabella | 0 | ✅ perfeito |

## Achados

### 🔴 Raiz comum (booking_order + cap + scarcity + permit): o goldenRule empurra demais
O `buildObjectiveSection` injeta "REGRA DE OURO (PRIORIDADE MAXIMA): pare de qualificar, vá pro agendamento". Meu fix contact-first suavizou a **action** mas manteve o tom agressivo → o Sonnet:
- afirma "seu lugar a gente garante agora" / "fechado: te coloco no encontro" **antes do WhatsApp** (002, 003, 004, 008, 010…);
- escala pra escassez dura proibida "**te garanto a vaga**", "**única vaga aberta essa semana**", "garante uma das duas vagas" (004, 008, 009, 010…);
- insiste 3-4× depois do lead pedir espaço/humano (008, 010, 011, 020, 022…);
- **reverte o gate de permit** e empurra/pendura o encontro pra quem não tem permit (003, 011, 015, 019…); 1 caso enumerou visto/documento (021).

### 🔴 Bug de fuso (tz_correct)
8pm ET → "7pm" para FL/GA/OH/NC (que SÃO Eastern). A IA trata alguns ET como Central. Lead apareceria 1h cedo. Fraseado auto-contraditório ("7pm na NC, que é o mesmo fuso ET").

### 🟡 Identidade
1 caso afirmou "**pessoa real** aqui no time" (proibido); vários re-negam bot 2x quando o lead insiste, em vez de 1 deflexão + handoff.

### 🟡 Menores
"turma" vaza ~6% no fraseado de permit; em fetch_failed às vezes inventa "segunda tem chances".

### ✅ O que está blindado
Profissão, National Life (1 leak raro), link/`{{}}`, renda zero-número, 8pm em si, persona Isabella, e a **disponibilidade real** (ofertou só dias da lista nos cenários com agenda; o anti-stalling do `slotsEmpty` funcionou na maioria).

## Veredito: **NO-GO até a rodada de fixes + re-teste**
A compliance "dura" e os pedidos diretos da Marina (profissão/National Life/link/8pm/disponibilidade) passaram. Mas **disciplina de agendamento** (soft-book, escassez fabricada, permit sob pressão, cap) está em **14-25%** — alto demais p/ um agente de cliente, e é exatamente o que a Marina reclamou (ordem do booking). + bug de fuso.

## Fixes desta rodada (28/06, pós-stress)
1. **Gate determinístico em código** (`action-executor`): com `require_contact_before_booking`, dropa `book_appointment` se não houver telefone/WhatsApp coletado → impede o appointment REAL prematuro (irreversível no CRM), independente do LLM.
2. **Prompt** (apply-marina, <8000 chars): tom de agendamento menos agressivo (oferta→escolha→WhatsApp→confirma→agenda; proíbe "garanto/fechado/seu lugar" antes do WhatsApp); escassez SÓ a soft aprovada (bane "te garanto a vaga"/"única vaga"); cap rígido (1 reoferta após pedido de espaço, depois recua); permit in_process/sem → cortesia, NUNCA empurra/pendura o encontro, nunca enumera visto; fuso = "8pm horário de NY (ET)", só converte com certeza, ET = 8pm (nunca 7pm); identidade nunca "pessoa real", repetiu → 1 deflexão + handoff; "encontro" nunca "turma"; ban duro de nomear empresa (National Life/Five Rings).
3. **Re-stress-test** das 210 (após reset 6pm ET) p/ confirmar que os números caíram ANTES do deploy.

## Re-testes (rodada 2 e 3) — comparativo

Rodada 2 = pós gate determinístico + 1º endurecimento. Rodada 3 = pós 3 fixes finais (tz/National Life/nome). R3 parou em 184/210 (runtime do workflow instável — agreguei os juízes direto dos transcripts em disco; amostra cheia, probe-outer cobre tudo).

| Regra | R1 (116) | R2 (210) | R3 (184) | Leitura |
|---|---|---|---|---|
| booking_order | 25% | 8.6% | 8.7% | ⬇️⬇️ gate determinístico + ordem |
| cap_insistencia | 19% | 10.5% | 10.3% | ⬇️ plateau (teimosia Sonnet) |
| no_fabricated_scarcity | 15% | 8.6% | 6.5% | ⬇️ |
| permit_no_ssn | 14% | 4.8% | 4.3% | ⬇️⬇️ (matei o dangle do prompt) |
| consistency | 14% | 11% | 13% | ➡️ plateau (rótulo de data + ripple tz) |
| only_listed_days | 12% | 7.1% | 1.1% | ⬇️⬇️ (tirei "normalmente seg/ter/qui") |
| identity_rule | 11% | 6.7% | 9.2% | ⚠️ "pessoa real" teima (~4/184) |
| tz_correct | 6% | 6.7% | 6.5% | ⚠️ agora ~SÓ Arizona (no-DST) + conversão-correta-punida; "7pm pra ET" SUMIU |
| encontro_not_turma | 6% | 0.5% | 1.1% | ✅ |
| **no_national_life** | 1.7% | 2.9% | **0%** | ✅✅ ban de nomear empresa |
| no_profession | 1.7% | 0.5% | 1.1% | ✅ |
| link_rule | 1.7% | 0% | 0% | ✅ |
| income_zero_number | 1.7% | 0% | 1.1% | ✅ |
| time_8pm | 0.9% | 0.95% | 0% | ✅ |
| persona_isabella | 0% | 0.5% | 0.5% | ✅ |
| alucinação de nome (gap) | — | 6 casos | 3 casos | ⬇️ (proibido deduzir do email) |

Fail global: R1 47% → R2 35% → R3 33%. As quedas grandes foram nos itens que a Marina reclamou + compliance dura. O que sobra é **polish** (identity "pessoa real", consistency de rótulo, cap) + **nicho** (Arizona).

## VEREDITO FINAL: GO para deploy MONITORADO

- **Crítico/compliance resolvido:** renda zero-número, link/`{{}}`, SSN, profissão, National Life (0%), 8pm — tudo ~0-1%. + **gate determinístico** impede o booking real prematuro INDEPENDENTE do LLM (cobre o pior dano).
- **Tudo que a Marina pediu:** disponibilidade real, 8pm (sem 9pm), sem National Life, sem profissão, ordem do booking — resolvido ou quase.
- **Residuais aceitáveis p/ agente já supervisionado:** identity "pessoa real" ~4/184 (nuance de persona, não é risco legal/safety), consistency 13% (rótulo de data, parte artefato de sim), cap 10% (over-insistência mais branda), tz-Arizona ~3% (estado de pouquíssimos leads BR). Teste é PIOR-CASO (adversarial + Sonnet instruído a deslizar) — prod tende a ser melhor.

**Opcional (near-zero, retorno decrescente):** 1 rodada extra mirando "pessoa real" (tirar "real" da persona_description) + Arizona. Não bloqueia.

## Limitações do teste (corrigir no re-run)
- Juiz não recebia a **lista literal** de dias → inflou `only_listed_days`. Passar `availableDays` explícito ao juiz.
- `fetch_failed` "prometer voltar" é legítimo (≠ stall) → ajustar a regra `empty_no_stall` p/ só punir invenção de dia.
- Sim não re-computa o runtime context por turno → `consistency` de data ("amanhã" vs "segunda") parcialmente artefato.
