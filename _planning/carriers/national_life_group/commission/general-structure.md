---
carrier: national_life_group
category: commission
subcategory: structure
slug: general-structure
title: "Comissão NLG — estrutura geral (first-year, target premium, renewal)"
priority: on_demand
tags: [commission, comissao, target-premium, ctp, first-year, renewal, excess-premium, levelized, heaped]
applies_to_companies: [LSW, NLIC]
source: official
last_verified: 2026-04-28
---

Comissão NLG segue estrutura tradicional vida + annuities. Crítico pra rep entender o que recebe e quando.

**Vocabulário-chave:**

- **Target Premium / Contract Target Premium (CTP)** — valor de prêmio "alvo" definido pelo produto (calculado conforme idade/face/produto). É o limite até onde commission **integral** é paga.
- **Excess Premium** — premium acima do CTP. Tipicamente comissão **drasticamente menor** (~3-5% gross em IUL, varia).
- **First-Year Commission** — % do premium recebido durante primeiros 12 meses do contract.
- **Renewal Commission** — % de premium recebido em anos 2+ (varia por anniversary).
- **Service Fee** — pagamento de manutenção; tipicamente non-vested.
- **Override** — diferença entre comissão gross do agent e comissão do sub-agent contractado abaixo.

**Estrutura típica IUL (FlexLife/PeakLife/SummitLife):**

Pra rep contracted at level normal:

- **First-Year Commission** sobre CTP: ~80-95% do premium até CTP (varia por nível contractual). Nível **DL9 BenaVest reference Fev/2026: 95% New Business** [unverified — confirma contrato específico do Pedro].
- **Excess Premium**: ~3-5% gross.
- **Renewal anos 2-10**: ~2-3% (level renewal).
- **Service fees** anos 11+: ~0.5-1% (non-vested geralmente).

**Estrutura typical Term:**

- **First-Year Commission**: ~50-90% do annual premium até CTP (depende de termo: 10-yr menor que 30-yr).
- **Renewal**: ~3-5% por anos 2-10.
- **Conversion credit** quando converted pra perm: pode ser non-commissionable (varia).

**Estrutura typical Whole Life (TotalSecure):**

- **First-Year Commission**: ~50-65% do premium até CTP (WL tipicamente menos heaped que IUL).
- **Renewal**: ~3-5% por anos 2-10.
- **Single premium / paid-up additions**: tipicamente non-commissionable ou MUITO reduzido.

**Estrutura typical Annuities:**

Detalhes em `commission/annuity-general-terms` (chunk separado, do Cat 53732).

**Bônus/persistency:**

NLG tem programs adicionais ao base:

- **Persistency bonus** — agent retém % adicional se policies em força permanecem (pagam premium) por anos 2+.
- **Volume bonuses** — top producers ganham conferences (Edge Annual Summit) + co-op marketing funds.
- **Recruiting overrides** — agency builders ganham % sobre comissão de recruits.

**Comissão no internal exchange / 1035:**

Detalhe em `replacement/internal-exchange-rules` (Cat 104736 — chunk separado).

Resumo:
- **Term ≥7 anos in-force**: full commission no replacement.
- **Term 4-7 anos**: half commission no overlap.
- **Term <4 anos**: zero commission no overlap.
- **Permanent ≥8 anos**: full commission.
- **Term-to-Perm conversion**: full commission **regardless** do tempo (always).

**Charge-back rules (Cat 53732 pra annuities, similar pra life):**

- **Not Taken policies** ou premium reversals → comissão recovered pelo NLG.
- **Death of insured/owner** dentro de timeframes específicos:
  - Annuities: 0-12 meses 100% chargeback (ou 0-6m 100% / 7-12m 50% pra produtos LSW listed).
- **Surrender charges** durante contestable period (2 anos) → tipicamente chargeback.

**Vested vs Non-vested:**

- **First-year + Renewal commissions** = **vested** (continua post-termination sem cause).
- **Service fees** = **non-vested** (cessa post-termination).

**Pitfalls:**

- **Vender PeakLife/SummitLife pra cliente <$1M target** — premium fica abaixo do CTP, menos comissão; pior, policy fica underfunded e implode.
- **Confundir CTP com max premium** — comissão integral SÓ em target. Excess = ~3-5%.
- **Esquecer chargeback risk** — 1º ano ainda em risco se cliente morrer ou cancelar.
- **Selling Term curto pra cliente perm** — comissão Term é menor; foco perm + conversion estratégia maximiza retorno longo prazo.

**Confidencialidade dos números exatos:**

- Schedule oficial NLG (GAF_8175 ou atual) é gated em portal — confirme nível contratual exato com IMO.
- Public references (BenaVest etc) podem ser desatualizadas.
- Pedro: **confirmar com seu IMO contract level + commission schedule current**. Sales Desk Compensation: NLGCompensation@NationalLife.com.

**Comportamento Sparkbot:**

Quando rep pergunta "como funciona o pagamento de comissão?":

1. Explica conceitos: target premium / CTP, first-year, renewal, excess.
2. Dá ranges típicos por produto (IUL/Term/WL) — sem números exatos.
3. Sinaliza que valores exatos dependem de **nível contratual** + **commission schedule** atual.
4. Direciona pra **NLGCompensation@NationalLife.com** ou IMO pra schedule específico.
5. Em internal exchange/1035 → linka chunk dedicado (104736).

**Fonte:** Annuity Commission General Terms Cat 53732(0225) + Internal Exchange Cat 104736(0725) + research independente (BenaVest, Empower Brokerage GAF_8175 reference). Levels e percentages exatos requerem confirmação contratual.
