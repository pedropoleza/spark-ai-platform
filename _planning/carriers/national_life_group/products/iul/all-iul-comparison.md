---
carrier: national_life_group
category: product
subcategory: iul-comparison
slug: all-iul-comparison
title: "IUL Comparison — quando usar cada produto NLG (FlexLife/Peak/Summit/Survivor/Rapid)"
priority: on_demand
product_refs: [flexlife, peaklife, summitlife, survivorlife, rapidprotect]
tags: [iul, comparison, comparativo, when-to-use, quando-usar, decision-tree, recomendacao]
applies_to_companies: [LSW, NLIC]
source: official
last_verified: 2026-04-28
---

Decision tree pra rep escolher rapidamente qual IUL NLG recomendar baseado no perfil do cliente.

**Decision Tree (resumo):**

```
Cliente quer cobertura $50K-$500K + age 0-60 + saúde "padrão" + quer fechar rápido
  → RapidProtect (instant decision, no exam)

Cliente $50K-$1M target premium + middle America + qualquer idade até 85
  → FlexLife II (flagship middle market)

Cliente $1M+ target premium + ages 18-85 + accumulation + supplemental retirement
  → PeakLife (premium funding, HNW)

Cliente $1M+ target premium + ages 18-85 + wealth transfer / lifetime income
  → SummitLife (affluent, advanced markets)

Cliente é casal HNW + estate planning + 2 vidas seguradas + uma pode ser uninsurable
  → SurvivorLife (Survivorship IUL, second-to-die)
```

**Tabela comparativa rápida:**

| Característica | RapidProtect | FlexLife II | PeakLife | SummitLife | SurvivorLife |
|---|---|---|---|---|---|
| Issue ages | 0–60 | 0–85 | 18–85 | 18–85 | 0–85 |
| Min face | $50K | sem mínimo declarado | $1M | $1M | $250K |
| Max face | $500K | até $10M+ | até $10M+ | até $10M+ | até $10M+ |
| UW path | Simplified instant | EZ UW ou Full | Full UW | Full UW | Full UW (paper only) |
| Best class | Standard NT/Tobacco | Elite | Elite | Elite | Elite |
| ABRs | NO Express | Sim (full set) | Sim | Sim | Sim |
| LIBR | n/a | Sim (60+) | Sim | Sim | Sim |
| Application | eApp via iGo | eApp | eApp | eApp | **PAPER ONLY** |
| Decisão típica | Minutos-1 dia | 1-7 dias | 2-4 semanas | 2-4 semanas | 4-12 semanas |
| Posicionamento | Middle market rápido | Middle America flagship | HNW accumulation | Wealth transfer | Estate joint |
| Estate Preservation Rider | Não | Não | Não | **Sim (mas SummitLife tem)** | **Sim** |
| Policy Split Option | n/a | n/a | n/a | n/a | **Sim** |

**Casos de uso típicos:**

**Cliente A: 35 anos, healthy, $500K coverage, quer fechar rápido**
→ **RapidProtect**. Sem paramed, instant decision. Standard NT class likely.

**Cliente B: 42 anos, $750K coverage, accumulation focus, cooperate via paramed**
→ **FlexLife II**. Best class possível com EZ UW ou full UW. Range $50K-$1M.

**Cliente C: 48 anos, business owner $5M coverage, wants supplemental retirement income via loans**
→ **PeakLife** (ou SummitLife). Premium funding focus.

**Cliente D: 58 anos, $10M+ estate, wants wealth transfer + lifetime income**
→ **SummitLife**. Estate Preservation + advanced markets sweet spot.

**Cliente E: Casal 65/63, $5M SIUL pra estate tax liquidity**
→ **SurvivorLife**. Second-to-die mechanic; ambas vidas covered, claim só na 2ª morte.

**Cliente F: Cliente diabético T2 controlled, age 50, $750K coverage**
→ **FlexLife II** com Standard NT (ou rated B-D). RapidProtect: T2 controlled qualifies, mas Express NT 1 perde ABRs no RapidProtect — full UW prefere se ABRs critical.

**Cliente G: Cliente em NY, $1M coverage, accumulation**
→ **FlexLife NL** (subsidiary NLIC, não LSW). Reg 187 training required.

**Cliente H: Foreign national brasileiro com US business, $5M coverage**
→ **FlexLife NL** ou **PeakLife NL** (depending target). Brasil tier B + nexus required + min face FN $500K.

**Switching strategies:**

**Term-to-Perm conversion:**

- Cliente teve Term LSW e quer converter pra perm.
- Conversion permitida até age 70 sem novo exam.
- **Comissão integral** no novo perm (regardless do tempo do Term in-force).

**Internal Exchange WL→IUL ou UL→IUL:**

- Cliente tem WL/UL antiga e quer IUL pra accumulation focus.
- Comissão depende de years in-force (ver `replacement/internal-exchange-rules`).
- Surrender charge waiver disponível em UL→UL ou UL→WL (ver chunk).

**Quando NÃO recomendar IUL:**

- Cliente quer dividendo histórico → **TotalSecure** (WL).
- Cliente quer income guarantee em annuity vs life → **FIT Select Income FIA**.
- Cliente budget-only, sem accumulation focus → **Term LSW**.
- Cliente avesso a market participation (mesmo com floor 0%) → **TotalSecure** ou **BasicSecure** (UL).

**Comportamento Sparkbot:**

Quando rep pergunta "qual produto pra cliente X":

1. Pergunta contexto: idade, face desejado, target premium, accumulation vs DB focus, estado, condições médicas significativas, urgência.
2. Aplica decision tree acima.
3. Sinaliza pitfall relevante (ex: PeakLife pra <$1M = underfunded; NY = NL suffix).
4. Pra design real → ForeSight illustration; Advanced Markets pra cases HNW.

**Pitfalls #11 (do critical-pitfalls):**

"PeakLife/SummitLife pra cliente <$1M target" = overkill, fica underfunded, COI implode. Use FlexLife pra middle market.

**Fonte:** Underwriting Guide Cat 62797(0126) §21-25 (cada produto IUL) + product-specific chunks já autorados.
