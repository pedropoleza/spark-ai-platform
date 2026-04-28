---
carrier: national_life_group
category: underwriting
subcategory: family-history
slug: family-history
title: "Family History — câncer, cardíaco, AVC em parentes (UW NLG)"
priority: on_demand
tags: [underwriting, family-history, parentes, mae, pai, irmao, cancer-familiar, cardiac-history, ez-uw]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Family history (parents + siblings) é critério importante pra qualificação em rate classes preferenciais NLG. EZ Underwriting tem thresholds específicos.

**Critérios EZ UW (do Cat 62797 §28):**

**Elite Non-Tobacco:**

- "No family history (parents or siblings) of death from coronary heart disease or cancer prior to age 65."
- Limite mais permissivo da família NLG (age 65 vs 60 nas outras classes).

**Preferred Non-Tobacco:**

- "No family history (parents or siblings) of death from coronary heart disease or cancer **prior to age 60**."
- Mais restritivo que Elite.

**Select Non-Tobacco:**

- "No family history (parents or siblings) of death from coronary heart disease or cancer prior to age 60."
- Mesmo critério que Preferred.

**Pra fora de EZ UW (full underwriting):**

Family history é factor mas não exclusionary — pode levar a rating se múltiplos casos aparecerem. NLG considera:

- Pais OR irmãos com death de CAD/cancer pré-60 → flag pra rating consideration.
- Múltiplos parentes 1º grau → pode mover de Standard pra rated.
- History materno e paterno em mesma condição → mais peso.

**Idade do "death" é o key:**

- Mãe com câncer aos 70 anos = OK em EZ UW (ela falaceu? ainda viva? disclosure exige só "death from").
- Mãe com câncer aos 55 = problema em EZ UW Preferred/Select.
- Mãe ainda viva mas teve câncer aos 50 = caso individual; UW pode considerar como factor sem ser auto-decline.

**O que UW vai pedir:**

- Age at death (se aplicável) de pais e irmãos.
- Causa específica (não basta "câncer" — quer saber tipo: ovário, próstata, mama, etc).
- Idade do diagnóstico (separada de age at death).

**EZ UW exclusion list relacionada (NÃO se aplica a family hx, mas relacionado):**

- "Standard risks with no personal health history of coronary artery disease, hepatitis B or C, diabetes, melanoma, or cancer (except skin cancer in situ)" → essa é sobre CLIENTE, não parentes.
- Family history específico cobre pais e irmãos (não tios, primos, avós) — mas NLG pode pedir info adicional em large faces.

**Comportamento Sparkbot:**

Quando rep diz "mãe teve câncer aos X anos":

1. Pergunta: idade de diagnóstico OU idade de death? Tipo específico?
2. **>65 (Elite EZ UW threshold) → OK pra Elite**.
3. **<65 mas >60 → fora de Elite, possível Preferred dependendo de detalhes**.
4. **<60 → fora de EZ UW Preferred/Select; full UW**.
5. Mãe ainda viva (sobreviveu cancer) é factor mais leve que death from cancer pré-60.

**Pra cliente com forte family hx:**

- XRAE field tool pode rodar pre-quote considerando family hx.
- Pra rating real → Sales Desk 800-906-3310 com detalhes (parentes 1º grau, idades, causas).

**Fonte:** Underwriting Guide Cat 62797(0126) §28 (Accelerated Elite/Preferred/Select Criteria — Family History).
