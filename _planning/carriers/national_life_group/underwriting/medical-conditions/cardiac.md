---
carrier: national_life_group
category: underwriting
subcategory: medical-cardiac
slug: cardiac
title: "Cardíaca: CAD, infarto, válvulas, arritmia, CHF — UW NLG"
priority: on_demand
tags: [underwriting, medical, cardiac, coronary-artery-disease, cad, heart-attack, infarto, arrhythmia, chf, congestive-heart-failure, valve, marca-passo, defibrillator]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Condições cardíacas têm tratamento variado dependendo de tipo, severidade, treatment e tempo desde último evento.

**Coronary Artery Disease (CAD):**

- **APS auto-trigger** (sempre).
- Rating depende de: idade, treatment, número de artérias envolvidas.
- Mild + age >60 + single artery + treated >2 anos: possível Standard.
- Multi-vessel ou recent: tabular ratings table B-D ou worse.
- **CAD/heart attack NÃO qualifies pra RapidProtect** (lista non-qualifying).

**Coronary Artery Disease (mild — UW Guide Cat 62797 §35):**

- "Mild, depends on treatment, age & artery(ies) involved" — possível Standard ou better em caso favorável.

**Heart attack (myocardial infarction):**

- Auto-decline em RapidProtect.
- Em full UW: rating depende de tempo desde infarto, treatment (stent vs CABG), function recovery, current meds.
- Recent (<6 meses) — geralmente decline pra apps novas.

**Cardiac arrhythmias:**

- "Atrial fibrillation (mild, not chronic, no underlying disease, depends on frequency & cause)" — possível Standard.
- Bundle Branch Block (mild, stable, normal cardiac eval, **NO complete Left BBB**) — possível Standard.
- **NÃO qualifies pra RapidProtect** (cardiac arrhythmias na lista non-qualifying).

**Heart valve disorders:**

- **NÃO qualifies pra RapidProtect**.
- Heart valve surgery (within past 12 months) — RapidProtect non-qualifying.
- Em full UW: depende de tipo (aortic, mitral), severity, surgery history, current function.
- "Aortic insufficiency (mild, age ≥50, no underlying disease, aortic valve only & no surgery)" — possível Standard.

**Congestive Heart Failure (CHF):**

- **NÃO qualifies pra RapidProtect**.
- Mild + diastolic dysfunction only + resolved: possível Standard.
- Acute / requiring oxygen / recent hospitalization: decline likely.

**Pacemaker / Defibrillator:**

- Heart disorder requiring a defibrillator → **RapidProtect non-qualifying**.
- Em full UW: rated heavy table B–H ou decline dependendo de razão da implant.

**Cardiomyopathy:**

- "Depends on type and age, diagnosis >2 years ago, stable/resolved" — possível.

**Stroke (CVA) / TIA:**

- **NÃO qualifies pra RapidProtect**.
- Stroke (CVA) varia by type, fully recovered, single episode >6 months ago — em full UW pode chegar a Standard em best case.
- TIA single episode, fully recovered, no underlying disease — possível Standard.

**O que UW vai pedir:**

- APS (sempre — auto-trigger).
- Cardiologist report.
- ECG / Echo recente.
- Lista de medicações cardíacas.
- Tempo desde último evento.
- Stress test ou cath results se relevante.

**Comportamento Sparkbot:**

Quando rep pergunta "cliente teve infarto, qual chance?":

1. Pergunta: quando? treatment? recovery? current meds?
2. Sinaliza APS auto-trigger.
3. Pra cases recentes (<6m) avisa decline likely.
4. Pra resolved long-ago avisa rating possível mas requer cardiologist report.
5. RapidProtect: NÃO disponível pra cardiac.

**Fonte:** Underwriting Guide Cat 62797(0126) §35 (Medical Conditions) + §19-20 (RapidProtect non-qualifying).
