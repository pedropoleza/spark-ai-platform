---
carrier: national_life_group
category: underwriting
subcategory: build-chart
slug: build-chart
title: "Build Chart NLG (height/weight) — rate class por BMI"
priority: on_demand
tags: [underwriting, build-chart, height, weight, bmi, peso, altura, body-mass-index]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

NLG tem build chart proprietário no Underwriting Guide Cat 62797(0126) §32 (Permanent ages 16+) e §33 (Term ages 18+). A tabela exata de height/weight por rate class está nesse documento (não temos extração tabulada).

**Direcional pra rep (alinhado com EZ Underwriting BMI thresholds):**

| Rate class | BMI range (heuristic) | Comportamento |
|---|---|---|
| **Elite Non-Tobacco** | 18.5 ≤ BMI ≤ 27.1 | Best class — restritivo |
| **Preferred Non-Tobacco** | 18.5 ≤ BMI ≤ 29.9 | Bom range |
| **Select Non-Tobacco** | 18.5 ≤ BMI ≤ 32.7 | Standard plus tier |
| **Standard Non-Tobacco** | até ~38 | Plataforma pra ratings |
| **Substandard (Table B–H)** | 38–45 | Tabular ratings com flat extras |
| **Possível decline** | BMI > 50 | Caso a caso, full UW + APS |

**Nota crítica:** Esses ranges são EZ Underwriting. Build chart full UW pode ser mais permissivo (especialmente em frame muscular vs gordura). Build chart tabela exata está em §32-33 do UW Guide.

**Low BMI:**

UW Guide menciona "individual consideration" pra BMI baixo (<18.5). Pode indicar condição médica subjacente — paramed + APS provável.

**Cálculo BMI rápido:**

`BMI = peso(kg) / altura(m)²`

Exemplos:
- 100 kg + 1.85 m: BMI = 100 / (1.85²) = 29.2 → **Preferred Non-Tobacco** possível em EZ UW.
- 90 kg + 1.70 m: BMI = 31.1 → **Select Non-Tobacco** possível.
- 110 kg + 1.75 m: BMI = 35.9 → **Standard Non-Tobacco** ou Express dependendo de outras condições.
- 70 kg + 1.80 m: BMI = 21.6 → **Elite NT** possível.

**EUA usa libras/inches:**

Pra cliente que dá peso/altura em libras/inches, conversão:
- Inches × 2.54 = cm; Libras × 0.4536 = kg.
- Tabela US típica: BMI = (lbs × 703) / inches²

**Pitfall #3 (do critical-pitfalls):**

"Vender Preferred sem ter elegibilidade" — Preferred classes têm restrições por face/idade ALÉM do BMI. Em FlexLife: ages 0–17 com face ≤ $250K → máximo é Standard, sem Preferred.

**Comportamento Sparkbot:**

Quando rep dá altura+peso de cliente:

1. Calcula BMI.
2. Mapeia pra range BMI→rate class (Elite/Preferred/Select/Standard) acima.
3. Sinaliza que é "estimativa baseada em EZ UW; build chart full UW pode ser mais permissivo".
4. Pra rating real → XRAE field tool pre-quote ou Sales Desk 800-906-3310.
5. Lembrar pitfall: face/idade também restringem Preferred mesmo com BMI bom.

**Fonte:** Underwriting Guide Cat 62797(0126) §28 (EZ UW BMI criteria) + §32-33 (Build Charts permanent + term — tabela exata, não extraído).
