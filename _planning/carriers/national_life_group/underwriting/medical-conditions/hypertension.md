---
carrier: national_life_group
category: underwriting
subcategory: medical-hypertension
slug: hypertension
title: "Hipertensão (high blood pressure) — UW NLG"
priority: on_demand
tags: [underwriting, medical, hypertension, high-blood-pressure, pressao-alta, htn]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Hipertensão (HTN, high blood pressure, pressão alta) é uma das condições mais comuns em apps NLG. Tratamento depende de controle e número de medicações.

**Hypertension well-controlled, sem complicações:**

- Possível **Preferred ou Select** se bem controlada e BMI ok.
- **1 medicação hipertensiva é allowed em EZ Underwriting Elite/Preferred** (junto com 1 medicação pra colesterol).
- 2+ medicações HTN → sai do EZ Underwriting; full UW.

**Hypertension RapidProtect:**

- "Hypertension (well controlled)" qualifies pra RapidProtect (lista qualifying conditions).
- Cliente em RapidProtect com HTN well-controlled = elegível.

**O que UW vai pedir:**

- Leituras BP recentes (idealmente <140/90 sustentado, ideal <130/80)
- Lista de medicações atuais
- Tempo desde diagnóstico
- Complicações associadas (heart disease, kidney issues, stroke history)

**Quando rating ou decline:**

- HTN não-controlada (BP >150/95 sem treatment)
- Multiple medicações + complicações
- HTN + diabetes + cardiac history (combinação flag UW)
- Stroke history (CVA/TIA) — separadamente listado pra rating

**EZ UW thresholds:**

- Elite Non-Tobacco: 1 hipertensiva + 1 colesterol allowed; sem outras meds restritas.
- Preferred Non-Tobacco: 1 hipertensiva + 1 colesterol allowed.
- Select Non-Tobacco: mesmas allowances.

**Comportamento Sparkbot:**

Quando rep pergunta "cliente com pressão alta, dá pra Preferred?":

1. Pergunta: BP atual? Quantas medicações? Outras condições?
2. Sinaliza: 1 medicação HTN é OK pra Preferred via EZ. 2+ → sai de Preferred.
3. Sugere XRAE field tool pra pre-quote real.

**Fonte:** Underwriting Guide Cat 62797(0126) §28-29 (EZ UW Criteria) + §35 + §19-20 (RapidProtect).
