---
carrier: national_life_group
category: underwriting
subcategory: medical-cancer
slug: cancer-history
title: "Cancer history — UW NLG"
priority: on_demand
tags: [underwriting, medical, cancer, melanoma, basal-cell, breast-cancer, prostate, oncology, remission]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Cancer history é tratada caso a caso pela NLG dependendo de tipo, stage, tempo desde tratamento e current status.

**Cancer histórico — UW NLG:**

- **APS sempre solicitado** (auto-trigger).
- Rating depende de: tipo, stage no diagnóstico, treatment received, years since treatment completion, current status (remissão vs active).
- "Cancer (depends on pathology, in remission & not currently under treatment)" — possível non-tabular em best case.

**Cancer NÃO qualifying RapidProtect:**

- "Cancer (except Basal Cell Carcinoma)" — qualquer history de cancer **exceto** basal cell desqualifica RapidProtect.
- Diagnostic testing in last 3 months (except colonoscopy, pap smear, mammogram) — non-qualifying RapidProtect.

**Tipos específicos:**

**Basal Cell Carcinoma:**

- "in-situ or ≤2 cm, no invasion or lymph node involvement" → possível Standard.
- **Único cancer que qualifies pra RapidProtect**.

**Melanoma:**

- Listado nas EZ UW exclusion lists (junto com diabetes, CAD).
- Em full UW: depends on stage, treatment, years since.
- Stage 0/I + >5 anos sem recurrence: possível non-tabular.
- Higher stages: heavy substandard ou decline.

**Breast cancer / Prostate cancer / Colon cancer:**

- Padrão: depende de stage, grade, treatment, years since completion.
- DCIS (ductal carcinoma in situ) treated → typically Standard após 5+ anos.
- Invasive em remissão >5 anos com clear scans: possível Standard ou table B/C.
- Active / under treatment: decline.

**Active treatment:**

- Em treatment current (chemo, radiation, surgery pending) → **decline universal**.
- Surgery pending → decline.

**O que UW vai pedir:**

- APS detalhado com pathology report.
- Treatment summary.
- Last imaging / scans.
- Tumor markers se aplicável (PSA, CA-125, etc).
- Oncologist follow-up notes.
- Years since treatment completion.

**Comportamento Sparkbot:**

Quando rep pergunta "cliente teve câncer, dá pra fechar?":

1. Pergunta: que tipo? stage? quando treated? em remissão? última imaging?
2. Sinaliza APS auto-trigger + oncologist report needed.
3. RapidProtect: SÓ Basal Cell qualifies.
4. Cancer recent ou active → decline likely; sugere full UW só em remissão estabelecida.
5. Pra ballpark real: XRAE field tool ou Sales Desk 800-906-3310.

**Fonte:** Underwriting Guide Cat 62797(0126) §35 (Medical Conditions) + §19-20 (RapidProtect lists).
