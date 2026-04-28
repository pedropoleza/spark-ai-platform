---
carrier: national_life_group
category: underwriting
subcategory: medical-conditions
slug: overview
title: "Medical Conditions — potential ratings NLG (top conditions)"
priority: on_demand
tags: [underwriting, medical, diabetes, hypertension, cardiac, cancer, mental-health, sleep-apnea]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

NLG Underwriting Guide §35 lista "Medical Conditions & Potential Ratings" — guia indicativo de best offer assumindo condition optimally controlada sem complicações. **Ratings finais dependem de specifics do case** — XRAE field tool dá pre-quote real.

**Disclaimer NLG:** "Potential Best Offer guidelines are provided as a courtesy for information purposes and should not be interpreted as tentative quotes or binding in any way."

**Top conditions (com tratamento típico NLG):**

**Diabetes Type 2 (well-controlled, sem complications)**

- Possível NT classes (Standard ou better) se bem controlado.
- APS sempre solicitado.
- Insulin OR + tobacco → APS auto + likely table rating.
- Type 1 → muito mais difícil; geralmente decline ou heavy table.

**Hypertension (well-controlled)**

- Possível Preferred ou Select se bem controlado e BMI OK.
- 1 medicação hipertensiva é allowed em EZ UW Elite/Preferred (junto com 1 cholesterol).
- 2+ medicações = saí de EZ UW; full UW.

**Coronary Artery Disease (CAD)**

- APS auto-trigger.
- Rating depende de age, treatment, artery(ies) involved.
- Mild + age >60 + single artery + treated >2 anos: possível Standard.
- Multi-vessel ou recent: tabular ratings table B-D ou worse.

**Cancer history**

- APS sempre.
- Rated por tipo / stage / years since treatment.
- Basal cell carcinoma in-situ ≤2cm: possível Standard.
- Em remission e sem treatment current: Standard ou better possível dependendo do tipo.
- Recent diagnosis ou active treatment: declined ou heavy substandard.

**Mental health (depression / anxiety)**

- Disclosure obrigatório.
- Mild + stable + controlled ≥6 meses: possível NT class (Standard ou Standard+).
- Severo / hospitalization: difícil; pode ser Express NT 2 ou decline.
- Suicide attempt: NÃO qualifying RapidProtect; full UW pra outros — single attempt >5 anos atrás possível Standard.

**Sleep Apnea**

- Mild + consistent CPAP use + sem adverse factors: possível NT class.
- Não-treated ou central/mixed apnea: rating ou decline.
- CPAP compliance documentation (printout do machine) é geralmente exigida.

**Hepatitis B/C**

- Tratado e resolvido: possível Standard (RapidProtect qualifies).
- Active ou cirrhosis: heavy substandard ou decline.

**Conditions presentes em RapidProtect QUALIFYING list (resumo):**

Anemia mild iron-deficient, Anxiety mild controlled, Asthma mild, Back disorder mild, Basal cell carcinoma, Bronchiectasis mild, Cerebral palsy >8 anos, Cystitis recovered, Depression mild controlled, Diabetes Type 2 well-controlled, Epilepsy (depende), Fibromyalgia mild, Gastric bypass >6m, Glaucoma corrected, Gout mild, Hep B/C resolved, Hypertension well-controlled, Hyper/Hypothyroid controlled, Joint replacement >3m, Lupus mild, Migraine mild, Osteoarthritis mild, Pregnancy current sem complicações, Sleep Apnea CPAP, Tuberculosis recovered, Varicose veins.

**Conditions NÃO qualifying RapidProtect (= use full UW):**

ALS, Alcoholism, Alzheimer/Dementia, Autism, Cancer (exceto Basal Cell), Cardiac arrhythmias, CAD/heart attack, CKD, Cirrose, COPD, CHF, Crohn's, Diabetes Type 1, Dialysis, Down's, Heart valve disorders, HIV/AIDS, Hospital admission últimos 12 meses, Intellectual Disability, Organ Transplant, Pacemaker/Defibrillator, Parkinson's, Paralysis, PVD, Polycystic Kidney, Sarcoidose, Stroke (CVA/TIA), Suicide attempt, Ulcerative Colitis.

**Tobacco/nicotine — definição NLG:** Cigarros, vape/e-cig, charutos, cachimbo, chewing, hookah, betel nut, nicotine gum/patch, **nicotine pouches (Zyn™)**. Marijuana: tobacco rates podem aplicar dependendo de delivery + frequência [unverified — política específica não documentada].

**Comportamento do Sparkbot:**

Quando rep pergunta "cliente tem X, qual a chance?":

1. Sparkbot consulta este chunk (medical-conditions/overview).
2. Sparkbot dá indicativo qualitativo (Possible Standard / Likely Substandard / Decline likely).
3. Sparkbot SEMPRE sugere XRAE field tool pra pre-quote real OU contact Underwriting Team.
4. Sparkbot NUNCA cita rating exato como "será X".

**Fonte:** Underwriting Guide Cat 62797(0126) §35 (Medical Conditions & Potential Ratings) + §19-20 (RapidProtect qualifying/non-qualifying lists).
