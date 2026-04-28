---
carrier: national_life_group
category: underwriting
subcategory: medical-diabetes
slug: diabetes
title: "Diabetes — underwriting NLG (Type 1 e Type 2)"
priority: on_demand
tags: [underwriting, medical, diabetes, type-1, type-2, gestational, a1c, insulin]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Diabetes é uma das condições médicas mais comuns em apps NLG. O tratamento depende de tipo, controle, complicações e medicação.

**Diabetes Type 2 (well-controlled, sem complications):**

- Possível **NT classes** (Standard ou better) se bem controlado.
- **APS sempre solicitado** automaticamente — APS auto-trigger pra qualquer history de diabetes.
- Critérios pra non-tabular ratings: A1c estável, sem complicações (neuropatia, retinopatia, nefropatia), tempo desde diagnóstico, idade do diagnóstico.
- **Diabetes Type 2 well-controlled, sem complicações qualifies pra RapidProtect** (best possible offer assume condition optimally controlled).

**Diabetes Type 2 com insulin OR + tobacco user:**

- **APS auto + likely table rating**.
- Combinação insulin + tobacco é flag pra UW conservador.

**Diabetes Type 1:**

- **Muito mais difícil** — geralmente decline ou heavy table.
- **Type 1 NÃO qualifies pra RapidProtect** (lista non-qualifying).
- Possível só com full UW + APS detalhado + cardiologista report em alguns cases.

**Gestational diabetes (não currently pregnant, sem complicações):**

- **Qualifies pra RapidProtect**.
- Tratado como condição resolvida; geralmente não impacta rating de longo prazo se sem recorrência.

**O que UW vai pedir:**

- A1C últimos 12 meses (idealmente <7.0 pra non-rated)
- Lista de medicações atuais
- Tempo desde diagnóstico
- Histórico de complicações
- Frequência de monitoramento

**Pra cliente em pre-qualification (XRAE field tool):**

XRAE no portal aceita diabetes como input e retorna rating provável. Use ANTES de submeter app pra evitar surprise.

**Quando NÃO qualifica nem pra rated:**

- Diabetes com hospitalização recente
- Multiple complications (neuropatia + retinopatia + nefropatia)
- A1c persistente >10
- Type 1 + outras condições adicionais

**Comportamento Sparkbot:**

Quando rep pergunta "cliente diabético, dá pra fechar?":

1. Pergunta tipo (T1 vs T2), controle (A1c), medicação, tempo desde diagnóstico.
2. Sinaliza que APS é auto-trigger.
3. Sinaliza RapidProtect só pra T2 well-controlled (não T1).
4. Sugere XRAE pra pre-quote real ou Sales Desk 800-906-3310 pra ballpark.

**Fonte:** Underwriting Guide Cat 62797(0126) §35 (Medical Conditions & Potential Ratings) + §19-20 (RapidProtect qualifying/non-qualifying).
