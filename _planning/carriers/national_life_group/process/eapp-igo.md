---
carrier: national_life_group
category: process
subcategory: application
slug: eapp-igo
title: "eApp via iGo + ForeSight + Resonant — stack digital NLG"
priority: on_demand
tags: [process, eapp, igo, foresight, resonant, ipipeline, lexisnexis]
applies_to_companies: [LSW, NLIC]
source: official
last_verified: 2026-04-28
---

NLG é uma das primeiras carriers com **same-day digital issuance** end-to-end. Stack: ForeSight (illustration) → iGo (eApp) → Resonant (UW engine) — todos do iPipeline / Hexure.

**Componentes:**

- **NLG ForeSight** (Hexure) — software de illustration. Web e desktop. Help docs em https://www.nationallife.com/NWI/Help/en-US/Peach/Introduction.htm. Quick Quote disponível também no NLG Agents mobile app.

- **iGo** (iPipeline) — eApp + e-signature + integração com illustration PDF. Yellow fields = required.

- **Resonant** (iPipeline) — automated UW engine + LexisNexis Risk Classifier. Cross-references MIB, Milliman Intelliscript Rx + Medical Claims + Criminal History, Motor Vehicle Report, LabPiQture.

**Fluxo eApp completo:**

1. Roda illustration no ForeSight — selecionar produto, design, riders.
2. Envia diretamente pra iGo — illustration PDF entra no application package.
3. Preenche application — Yellow fields obrigatórios.
4. Assinatura: e-Signature via email **OU** wet signature (print/sign/fax/mail).
5. Submissão automática.
6. Resonant + LexisNexis avaliam → **decisão**:
   - Instant approval (~18-25% dos cases EZ UW)
   - Paramed kicked → ExamOne ou APPS agendam
   - APS triggered (cancer, diabetes insulin/+tobacco, CAD, COPD, etc) → solicitação ao médico

**APS — Attending Physician Statement (auto-trigger):**

NLG auto-trigger APS pra impairments:

- Cancer (qualquer history)
- Diabetes (insulin OR + tobacco — combo)
- CAD / Cardiovascular Disease
- Emphysema, COPD, Chronic Bronchitis
- Heart murmur
- Hepatitis
- Kidney/Renal Disease

**Idade 60+ — physical recente exigido:**

Applicants 60+ devem ter **routine care + physical nos últimos 24 meses**, ou case = auto-decline. Pergunta antes de submeter.

**Application validity windows:**

- Application válida por **6 meses** desde signing date.
- Statement of Health (form 5230, varia por estado) exigido após 90 dias do last evidence.
- Parameds + Labs válidos:
  - Ages até 70: 12 meses.
  - Ages 70+: 6 meses.
- Rewrites: policy pode ser rewritten até **120 dias** desde signing.

**Documentos típicos do ticket:**

- ID válido (driver's license, passport)
- Voided check (pra EFT premium)
- Illustration assinada (NAIC compliance)
- Replacement forms quando aplicável (Reg 60 NY, etc state-specific)
- Cover letter do agente (recomendado pra non-standard cases — explica purpose/use of funds)
- Annuities: suitability questionnaire NLG + state-specific disclosures

**Timeline típico:**

- **EZ UW / RapidProtect:** minutos a 1 dia.
- **Standard com paramed:** 2–4 semanas.
- **Com APS:** 4–8 semanas (variável por médico).

**e-Delivery:**

- E-signature na delivery também via plataforma iPipeline.
- Reduz time-to-issue significativamente vs paper delivery.

**XRAE (Express Risk Assessment Exchange):**

- Field UW tool no portal. Permite pre-quote tool pra agente saber rating provável antes de submeter app.
- **NÃO disponível pra RapidProtect** (RapidProtect tem seu próprio simplified UW).

**Comportamento do Sparkbot:**

Quando rep pedir cotação ou perguntar sobre processo:

- Lembra de rodar ForeSight pra illustration oficial.
- Lembra que app via iGo é caminho default (paper só pra SIUL).
- Se cliente tem condição médica: APS auto-trigger é provável; comunique timeline esperado.
- 60+ sem physical recente = pré-qualifique antes de submeter.

**Fonte:** Underwriting Guide Cat 62797(0126) §17 (Underwriting Programs) + iPipeline case study + NLG ForeSight help docs.
