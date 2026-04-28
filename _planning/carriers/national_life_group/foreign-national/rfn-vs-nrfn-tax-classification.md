---
carrier: national_life_group
category: compliance
subcategory: foreign-national-tax
slug: rfn-vs-nrfn-tax-classification
title: "RFN vs NRFN — Resident vs Nonresident Alien (IRS classification)"
priority: on_demand
tags: [foreign-national, fn, rfn, nrfn, resident-alien, nonresident-alien, substantial-presence-test, spt, green-card, irs, tax-classification]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "103418(1225)"
last_verified: 2026-04-28
---

**IMPORTANTE: distinção entre 2 conceitos diferentes que reps confundem:**

1. **NLG Foreign National (UW)** — definição da carrier pra UW: indivíduo que passa >4 meses fora dos EUA em 12 meses consecutivos. Aplica regras de FN (country tier A/B, max face $15M, exam US, etc).

2. **IRS RFN/NRFN (tax)** — classificação fiscal IRS pra income tax E gift/estate tax. **CONCEITUALMENTE DIFERENTE** da definição NLG.

Este chunk cobre a classificação **IRS** (do Cat 103418).

**Resident Alien (Resident Foreign National — RFN):**

**Pra income tax:**

Indivíduo é RFN se atender QUALQUER um dos critérios:

- **Lawful Permanent Resident** (Green Card holder) — automatically RFN pra income tax, regardless de tempo nos EUA.
- **Substantial Presence Test (SPT)**: physically present nos EUA pelo menos:
  - 31 dias durante o current year, **E**
  - 183 dias durante o período de 3 anos incluindo current year + 2 prior years (cálculo ponderado: current = 1 dia conta como 1, prior year = 1/3, second prior year = 1/6).

**Pra gift/estate tax:**

- RFN é definido como indivíduo **domiciled nos EUA** na data do gift ou date of death.
- "Domicile" tem requisitos diferentes de residency. Inclui intent to remain indefinitely + physical presence.

**Resultado RFN:**

- Tributado em **all worldwide income**.
- Tributado em **all worldwide assets pra estate tax** (mesmo tratamento que US citizen).
- **MAS sem unlimited marital deduction se spouse é non-citizen** — pode usar QDOT (Qualified Domestic Trust) workaround.
- Annual gift tax exclusion: **$19.000 (2026)** ($18K em 2024-2025, atualizado anualmente por inflation).
- Lifetime gift/estate exclusion: **$13.99M+ (2025; ajustado anualmente)**.

**Nonresident Alien (Nonresident Foreign National — NRFN):**

**Pra income tax:**

- Indivíduo que **NÃO é citizen** **NEM** **resident** dos EUA.
- Não atende green card test nem SPT.

**Pra gift/estate tax:**

- NRFN é definido como **domiciled fora dos EUA** na data do gift ou date of death.

**Resultado NRFN:**

- Tributado APENAS em US-source income / income connected com US trade ou business.
- **Estate tax aplica APENAS em US-situs assets** (real property in US, US stock, US business interest, certain US-based personal property).
- **Estate tax exemption pra NRFN: APENAS $60.000** (vs $13.99M+ pro citizen/RFN). Diferença massiva!
- Gift tax aplica em transferências de US-situs assets.
- Sem unlimited marital deduction pra spouse non-citizen (mesmo problema que RFN).

**Tax treaties podem modificar:**

- US tem treaties bilaterais com vários países que podem alterar regras de gift/estate tax pra NRFN.
- Treaty US-UK, US-France, US-Germany, US-Japan, US-Canada têm provisions específicas.
- **US-Brasil NÃO tem treaty de gift/estate tax** — regras default aplicam.
- US-Mexico NÃO tem treaty income tax mas tem totalization agreement (separate).
- Cliente de país com treaty deve consultar US international tax attorney.

**Por que life insurance importa pra FN:**

NRFN com US business ou US assets enfrenta:
- Estate tax 40% sobre US-situs assets > $60K exemption.
- Pequeno exemption = enorme exposição.

Life insurance ajuda:
- Death benefit é generally **excluído do estate** se policy structurada via ILIT US-domiciled.
- Liquidez pra estate tax sem ter que vender US assets.
- Wealth transfer geracional preservando valor.

**Cliente argentino com green card cumprindo SPT:**

- Green Card → RFN pra income tax (regardless of SPT — green card alone qualifies).
- Domiciled nos EUA → RFN pra gift/estate tax.
- Tributado em worldwide income + worldwide assets.
- Annual exclusion $19K, lifetime $13.99M+.

**Cliente brasileiro que vive 5 meses/ano nos EUA:**

- 5 meses/ano = 150 dias/ano.
- SPT: current year 150 + 1/3 × 150 (prior year) + 1/6 × 150 (2 prior) = ~225 dias = >183 → cumpre SPT.
- → **RFN pra income tax**.
- Pra gift/estate tax: depende de domicile (intent + ties). Pode ser RFN ou NRFN dependendo de prova de intent.

**Comportamento Sparkbot:**

Quando rep pergunta sobre status tax FN:

1. Pergunta: green card? quanto tempo no US? domicile? país de origem?
2. Distingue **NLG FN definition** (>4 meses fora) **vs IRS RFN/NRFN**.
3. Income tax classification é separada de gift/estate tax classification.
4. Annual gift exclusion 2026: $19.000.
5. Tax treaty status com país de origem matters.
6. **NÃO dá tax advice** — sempre encaminha pra US CPA + international tax attorney.
7. Pra cliente specific advisory: NLG Advanced Markets 800-906-3310 + cliente consulta CPA.

**Disclaimer obrigatório:**

"NLG e Spark Leads não fornecem tax ou legal advice. Esta info é educacional. Cliente deve consultar US CPA + international tax/legal advisor pra situação específica."

**Fonte:** Cat 103418(1225) "Planning for Foreign Nationals — U.S. Federal Gift and Estate Tax Considerations" + IRS Publication 519 (U.S. Tax Guide for Aliens).
