---
carrier: national_life_group
category: underwriting
subcategory: medical-sleep-apnea
slug: sleep-apnea
title: "Sleep apnea — UW NLG"
priority: on_demand
tags: [underwriting, medical, sleep-apnea, cpap, apneia, osa]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Sleep apnea (OSA — Obstructive Sleep Apnea) é comum em apps NLG. Tratamento depende de severidade + uso consistente do CPAP.

**Sleep apnea mild + consistent CPAP use, sem complicações:**

- Possível **NT class** (Standard ou Standard Plus).
- "Sleep Apnea (mild, not central or mixed apnea, consistent CPAP use, no adverse factors)" — UW Guide Cat 62797.
- **Qualifies pra RapidProtect** (lista qualifying: "Sleep Apnea (consistent CPAP use, no complications)").

**Não-treated sleep apnea ou central/mixed apnea:**

- Rating substandard ou decline.
- Central apnea (vs obstructive) é mais sério — separate UW track.

**O que UW vai pedir:**

- **CPAP compliance documentation** (printout do CPAP machine mostrando uso ≥4h/noite, ≥70% das noites).
- Sleep study results (AHI score: severity).
- Tempo desde diagnóstico.
- Medicações associadas.

**Severity tiers (general guidance, non-NLG specific):**

- Mild OSA: AHI 5-15 com consistent CPAP → possível Standard.
- Moderate OSA: AHI 15-30 com CPAP compliance → possível Standard ou table B.
- Severe OSA: AHI >30 → typically table rating B-D dependendo de comorbidities.

**Pitfalls:**

- Cliente tem CPAP mas NÃO usa → flag pra UW. NLG vai descobrir via Rx data + CPAP machine compliance reports.
- Newly diagnosed sleep apnea sem CPAP started → typically rated.
- Sleep apnea + obesidade (BMI alto) + hypertension → combination flag.

**Comportamento Sparkbot:**

Quando rep pergunta "cliente tem sleep apnea, dá pra fechar?":

1. Pergunta: severity (AHI score)? CPAP em uso? Adesão (compliance %)?
2. Mild + CPAP compliance → qualifies RapidProtect E Standard NT em full UW.
3. Sem CPAP ou non-compliance → rated likely.
4. Pra rating real → XRAE pre-quote ou Sales Desk 800-906-3310.

**Fonte:** Underwriting Guide Cat 62797(0126) §35 (Medical Conditions) + §19-20 (RapidProtect qualifying).
