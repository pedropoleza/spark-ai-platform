---
carrier: national_life_group
category: process
subcategory: timeline
slug: timeline-by-uw-path
title: "Timeline de aprovação por UW path (RapidProtect / EZ / Full / SIUL)"
priority: on_demand
tags: [process, timeline, sla, aprovacao, approval, rapidprotect, ez-underwriting, paramed, aps, prazo]
applies_to_companies: [LSW, NLIC]
source: official
source_doc_cat: "62797(0126)"
last_verified: 2026-04-28
---

Timeline de aprovação varia significativamente por UW path. Comunique expectativa correta ao cliente — gestão de expectativas evita follow-ups frustrados.

**RapidProtect (simplified-issue, instant-decision IUL):**

- Ages 0–60, $50K–$500K.
- Sem medical exam, sem labs.
- **Decisão em minutos a 1 dia** na maioria dos cases.
- ~18-25% dos cases recebem instant approval automatizado.
- Cases que precisam Additional Review (XRAE → manual UW): **1 business day**.
- Best path pra cliente que quer fechar rápido.

**EZ Underwriting (accelerated, no medical exam):**

- Ages 18–50: até $3M permanent / $2M term.
- Ages 51–60: até $1M.
- Ages 61–65: até $250K.
- Sem paramed/labs/EKG quando aprovado.
- **Decisão em minutos a 1 dia** quando dado é "limpo" (LexisNexis Risk Classifier passa).
- **2-7 dias** quando precisa adicional review.
- Cases "kicked out" pra full UW → switch pro path full UW timeline.

**Full UW (Standard com paramed):**

- Application válida por **6 meses** desde signing.
- Paramed agendado tipicamente em 3-7 dias.
- Lab results: 5-10 dias após paramed (Clinical Reference Lab é o approved vendor).
- Underwriter review: 7-14 dias após receipt of lab.
- **Total típico: 2–4 semanas** pra cases sem APS.

**Full UW + APS (com Attending Physician Statement):**

- Auto-trigger pra: cancer, diabetes (insulin OR + tobacco), CAD/cardiovascular, COPD/emphysema/chronic bronchitis, heart murmur, hepatitis, kidney/renal disease.
- APS solicitado ao médico do cliente — depende de responsiveness do consultório.
- Tempo de resposta APS varia: **2-6 semanas** típicas, mas pode chegar a 8+ semanas pra médicos lentos.
- **Total típico: 4–8 semanas**.

**SurvivorLife / SIUL:**

- **Application paper apenas** (NÃO disponível via eApp iGo).
- Full UW exigido em ambas as vidas.
- Mailing + processing time adiciona vs eApp.
- **Total típico: 4–8 semanas** mesmo sem APS; 6-12 semanas com APS.

**Application validity windows:**

- Application: **6 meses** desde signing.
- **Statement of Health (form 5230, varia por estado)** exigido após 90 dias do last evidence (paramed ou health section da app).
- Parameds + Labs:
  - Ages até 70: **12 meses** de validade.
  - Ages 70+: **6 meses** de validade.
- Rewrites: até **120 dias** desde signing.

**Variáveis que aceleram timeline:**

- eApp via iGo (vs paper) economiza dias de mailing.
- e-signature vs wet signature.
- Cliente responsivo a requirements (paramed agendamento, APS forms).
- Médico cooperativo no APS request.
- LexisNexis data limpa (Rx, MIB, MVR consistente).

**Variáveis que atrasam:**

- APS pendente (médico lento).
- Paramed reagendamento por cliente.
- Discrepancies entre paramed labs e self-disclosed health (re-exam).
- Required form não completado (Foreign National Questionnaire pra FN, etc).
- 60+ sem physical recente nos últimos 24 meses → auto-decline pendente.

**Comportamento Sparkbot:**

Quando rep pergunta "quanto tempo pra aprovar?":

1. Pergunta: que produto? que UW path (EZ/RapidProtect/Full)? cliente tem condição médica que vai trigger APS?
2. Dá range adequado:
   - RapidProtect: minutos-1 dia.
   - EZ UW limpo: 1-7 dias.
   - Full UW sem APS: 2-4 semanas.
   - Full UW com APS: 4-8 semanas.
   - SIUL: 4-12 semanas.
3. Identifica variáveis que vão acelerar/atrasar pra cliente específico.
4. Sugere comunicação de timeline realista ao cliente pra evitar frustração.

**Fonte:** Underwriting Guide Cat 62797(0126) §17 (Underwriting Programs) + §18-19 (EZ UW + RapidProtect) + §25 (SurvivorLife paper-only).
