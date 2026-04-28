---
carrier: national_life_group
category: underwriting
subcategory: medical-respiratory
slug: respiratory
title: "Respiratórias: asthma, COPD, bronchitis, tuberculosis — UW NLG"
priority: on_demand
tags: [underwriting, medical, asthma, copd, bronchitis, bronchiectasis, tuberculosis, asma, lung]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Condições respiratórias variam de mild (asma controlada) a severe (COPD com oxigênio).

**Asthma mild:**

- "Asthma (mild, depends on age, treatment, number & frequency of attacks, no limitations)" — possível Standard.
- **Qualifies pra RapidProtect** (lista qualifying: "Asthma, mild (depends on age, attacks, medications)").
- Use diário inhaler de rescue + steroid → quase certeza Standard.
- Hospitalization por asthma recent → flag.

**Asthma severo / requiring oxygen:**

- "Lung disease, severe or requiring oxygen" → **NÃO qualifies RapidProtect**.
- Em full UW: rated heavy ou decline dependendo de severity.

**COPD (Chronic Obstructive Pulmonary Disease):**

- "COPD (mild, minimal dyspnea, no home oxygen treatment or hospitalization)" — possível Standard.
- **NÃO qualifies pra RapidProtect** ("Chronic Obstructive Pulmonary Disease (COPD)" na lista non-qualifying).
- COPD severo ou com oxygen dependency → decline likely.
- **APS auto-trigger** pra COPD/emphysema/chronic bronchitis.

**Chronic Bronchitis:**

- Tratado similar a COPD. APS auto-trigger.
- "Bronchitis, chronic (mild, minimal dyspnea, no home oxygen treatment or hospitalization)" — possível Standard.

**Bronchiectasis:**

- "Bronchiectasis (mild to moderate without daily symptoms, no surgery or hospitalization)" — possível Standard.
- **Qualifies pra RapidProtect** (lista qualifying: "Bronchiectasis, mild (no surgery or complications)").

**Tuberculosis (TB):**

- "Tuberculosis (treatment completed >3 months ago, normal lung function, negative HIV)" — possível Standard.
- **Qualifies pra RapidProtect** (lista qualifying: "Tuberculose totalmente recuperada, complete recovery with no complications nor residuals").
- Active TB → decline.
- TB latente sem treatment completed → rated.

**Sarcoidosis:**

- "Sarcoidosis (depends on organs involved, mild/stage 1, >6 months since diagnosis)" — possível.
- **NÃO qualifies pra RapidProtect** ("Sarcoidose" na lista non-qualifying).

**Emphysema:**

- APS auto-trigger.
- Mild + no oxygen + no hospitalization: possível Standard.
- Severe / oxygen-dependent: decline.

**O que UW vai pedir:**

- APS pra COPD / emphysema / chronic bronchitis (auto-trigger).
- Pulmonary function tests (PFT) results.
- Inhaler / medication list.
- Smoking history (huge factor — tobacco class aplica).
- Hospitalization datas e causas.
- Oxygen dependency: home use, hours/day.

**Tobacco interaction:**

- Smoker com asthma/COPD → tobacco class + provavelmente rated.
- 12 meses non-tobacco mínimo pra Standard NT pricing.

**Comportamento Sparkbot:**

Quando rep pergunta "cliente tem asma / COPD / bronquite":

1. Pergunta: severity? oxygen use? hospitalization? smoking history?
2. Mild asthma → RapidProtect ok + Standard NT.
3. COPD ou emphysema → APS auto-trigger; RapidProtect NÃO disponível.
4. Severe lung disease com oxygen → decline likely.
5. Pra rating real → XRAE ou Sales Desk 800-906-3310.

**Fonte:** Underwriting Guide Cat 62797(0126) §35 (Medical Conditions) + §19-20 (RapidProtect lists).
