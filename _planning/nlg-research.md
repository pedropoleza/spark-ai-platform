# National Life Group (NLG) — Research Bruto

> **Data da pesquisa:** 2026-04-27
> **Fontes:** públicas (oficiais NLG, IMOs/wholesalers, mídia de seguros, comunidade)
> **Uso:** semente bruta pra knowledge base do Sparkbot. Cap rates, illustrated rates e rider availability mudam **anualmente** — sempre confirmar no Agent Portal antes de cotar.
> **Confiabilidade:** itens marcados `[unverified]` precisam de validação com Pedro/IMO/sales desk antes de irem ao bot.

---

## 1. A empresa

### 1.1 Estrutura corporativa

- **Holding**: NLV Financial Corporation (NLVF). Mutual holding — policyholders são members; sem outside shareholders / private equity.
- **Trade name**: "National Life Group" (NLG) cobre as subsidiárias.
- **Subsidiárias principais**:
  - **National Life Insurance Company (NLIC)** — flagship, sede Montpelier, VT. Fundada **13/Nov/1848** (chartered pelo Vermont Legislature). Licenciada nos **50 estados + DC**, incluindo NY.
  - **Life Insurance Company of the Southwest (LSW)** — sede Addison, TX. Chartered 1955. Licenciada em **49 estados + DC — NÃO licenciada em NY**. 100% owned por NLIC.
  - **Equity Services, Inc. (ESI)** — broker/dealer FINRA/SIPC + RIA (ESI Financial Advisors / EFA). Em CO, MO, NH e WI opera como **Vermont Equity Services**. Plataforma fee-based: **ESI Illuminations**.
  - **NLG Capital, Inc.** (formerly Sentinel Asset Management).
  - **Catamount Reinsurance Company** e **Longhorn Reinsurance Company**.
  - **National Life Distribution, LLC (NLD)** — master agency for field force, subsidiária de LSW.

- **Diferença prática NLIC vs LSW**:
  - NY → contrato sai pela **NLIC**.
  - Demais 49 estados → contrato sai geralmente pela **LSW** (especialmente annuities e IUL recentes).
  - Ambas carregam o mesmo rating A+ AM Best e a mesma força financeira.

### 1.2 Ratings (validados Abr/2026)

| Agência | Rating | Categoria |
|---|---|---|
| AM Best | **A+ (Superior)** — reafirmado Jul/2025 | 2º mais alto de 16 níveis |
| Standard & Poor's | **A+ (Strong)** | 5º de 22 |
| Moody's | **A1 (Good)** | 5º de 21 |
| Comdex | **90** | composite score |
| BBB | A+ (não acreditado) | — |

Tamanho AM Best: **$2 bilhões+** (categoria de assets). Listada no **2025 Ward's 50** (top life/health performers).

### 1.3 Posição de mercado

- **Assets consolidados (12/31/2025)**: **$55,7B** (NLG). NLIC sozinha: $13,1B.
- **Life insurance in force** (mid-2025): **$421,5B**.
- **Customers**: ~1,4M.
- **2024 sales**: $635M life premium + **$3,4B annuities** (recorde).
- **Q1 2025 annuities**: $667M (maior single-quarter da história NLG).
- **Posição IUL**: **#2 maior provider de IUL nos EUA**.
- **#7 de 22** no J.D. Power 2025 individual life insurance study (above-average).
- Forbes Best Insurance Companies 2024 e 2025; WSJ #2 Best Whole Life 2025.
- **Crescimento 2008-2019**: +252% em life sales (vs +6% média nacional).
- **CEO/Chairman/President**: **Mehran Assadi**.

---

## 2. Produtos principais

### 2.1 Indexed Universal Life (IUL) — núcleo da linha

| Produto | Issue Ages | Min Face | Min Inicial / Target | Posicionamento |
|---|---|---|---|---|
| **FlexLife** (IUL flagship — atualmente FlexLife II) | 0–85 (ANB) | $50,000 (alguns sources citam $25K para casos antigos `[unverified]`) | Acessível | Middle America, accumulation + protection; mais "vendido" |
| **PeakLife** | 18–85 | **$1,000,000** | Premium funding | Higher-net-worth, supplemental retirement |
| **SummitLife** | 18–85 | **$1,000,000** | Premium funding | Affluent / wealth transfer + lifetime income |
| **SurvivorLife** (Survivorship IUL — 2 insureds) | 0–85 (ANB) | **$250,000** (initial); $25K p/ APB increases | Estate/biz partners | Estate planning, second-to-die |
| **RapidProtect** (lançado **Set/2025**) | 0–60 | $50,000–$500,000 | Instant decision | "No medical, no labs" — middle market digital |

**Indices / Crediting Strategies (FlexLife / PeakLife / SummitLife / SurvivorLife)**:
- **S&P 500 Point-to-Point Cap Focus** — cap **9,25%** (effective Jan 2023; revisado anualmente; NY excluído de várias updates) `[confirmar cap atual no portal]`
- **S&P 500 Point-to-Point Participation Focus** — par rate ≥110%, cap menor (3,0%)
- **MSCI EAFE / MXEF Point-to-Point Cap Focus**
- **Balanced Trend** — uncapped
- **US Pacesetter** — uncapped, **proprietary index lançado Dez/2021** (atenção: foco do lawsuit — backtested data antes dessa data)
- **Systematic Allocation Strategy**
- **Basic Strategy** — fixed account (~2,35% LSW SummitLife na referência 2023)
- **Floor**: 0% (sem perda por movimento de mercado, mas COI/fees continuam debitando)
- **Crediting period**: 1 ano

**Riders padrão (todos os IULs)**:
- **Accelerated Benefits Riders (ABR)** — sem custo adicional:
  - Terminal Illness (até $1,5M lifetime cap)
  - Chronic Illness (2 of 6 ADLs por ≥90 dias OU cognitive impairment severo)
  - Critical Illness (cap $1M lifetime — ALS, câncer, AVC, infarto, Major Organ Transplant, etc.)
  - Critical Injury
  - **Alzheimer's Disease Rider** (industry-first, 2023) — Alzheimer ou Lewy Body Dementia
  - **Fertility Journey Rider** (industry-first, 2024)
- **Lifetime Income Benefit Rider (LIBR)** — guaranteed income for life. Issue ages 60–85; **waiting period varia**: alguns sources dizem 10 anos, outros 15 anos in-force. `[Confirmar período por produto/idade — provavelmente "later of age 60 ou 10/15 years"]`
- **Overloan Protection Rider** — sem custo; tipicamente requer 15+ anos in-force e age 75+
- **Premium Chronic Care Rider** (added Out/2025 ao FlexLife)
- **Value Added Services Rider** (added Out/2025 ao FlexLife)
- **Children's Term Rider** (até $25K)
- **Waiver of Premium**, **Unemployment Rider** (3-month premium waiver), **Guaranteed Insurability Rider**
- **Additional Protection Benefit (APB)** — max 3:1 APB-to-Base blend
- **Estate Preservation Rider** (SurvivorLife)
- **Policy Split Option** (SurvivorLife → 2 single-life policies)
- **Premium Deposit Account**
- **Death Benefit Protection Rider**

### 2.2 Whole Life

| Produto | Detalhes |
|---|---|
| **TotalSecure** (flagship WL) | Pay options: 10-Pay, 15-Pay, 20-Pay, Paid-up at 65, Lifetime. Min $50K, ages 0–85. Dividend-eligible (paid since **1855** — 170+ anos). "Direct recognition" loan policy. |
| **LSW ProtectorLife** | WL especializado para estate/business `[confirmar status atual]` |
| **ValuGuard Survivorship Whole Life** | Survivorship WL para estate planning `[confirmar status atual]` |

### 2.3 Universal Life

- **BasicSecure** — flexible premium UL, min $50K, ages 0–85. Inclui ABR sem custo.

### 2.4 Term Life

- 10, 15, 20, 30-year level term + **Annual Renewable Term (ART)**
- Ages 18–85 (varia por termo)
- **Conversível** para permanente (até age 70 tipicamente, sem novo exam)
- Riders: ABR, Children's Term, Waiver of Premium

### 2.5 Annuities

**Fixed Indexed Annuities (FIA)**:
- **FIT Secure Growth FIA** — flexible premium, accumulation focus. Min $5K lump sum ou $100/month. Multiple crediting strategies.
- **FIT Select Income FIA** — income focus. Issue ages **18–75**. Min $5K single ou $100/month. **GLIR (Guaranteed Lifetime Income Rider)** built-in (com fee).
- **Zenith Income 10** FIA — income-focused 10-year `[confirmar specs atuais]`
- **Green Mountain Freedom Flex** (NY: emitido por NLIC) — flexible premium MYDA-like, **aceita 403(b) salary reduction** (raríssimo no mercado).

**MYGAs**:
- **Green Mountain Freedom 5** — 5-year guaranteed
- **RetireMax Secure 3 / 5** — fixed terms
- Sample rates Abr/2026: 3.9%–5.1% conforme termo/tier
- Premium minimums tipicamente $20K–$100K+ por produto

**Annuity riders** (sem custo onde aprovado):
- Nursing Care Waiver
- Terminal Illness Waiver
- Emergency Access Waiver
- Free 10% withdrawal após ano 1
- 30-day free look

**FIA Rider plataforma**: a Guaranteed Lifetime Income Rider (GLIR) é destacada na linha de employer/plan sponsors (403b/457).

### 2.6 Variable Annuities & Securities

- Distribuídos via **ESI / EFA** (broker-dealer / RIA)
- ESI Illuminations (advisory fee-based)

---

## 3. Underwriting Guidelines

> Os PDFs oficiais do Underwriting Guide (Form 62797, NLG-Underwriting-Guide etc.) retornaram em formato binário não-extractable nas tentativas. Os pontos abaixo são compilados de IMOs e do underwriting agent blog. **Validar sempre no portal antes de cotar casos limítrofes.**

### 3.1 Risk Classes

Estrutura típica NLG (Form 62797):
- **Preferred Plus** (Super Preferred / Elite)
- **Preferred**
- **Standard Plus**
- **Standard** (Tobacco e Non-Tobacco)
- **Substandard** — Table A–H (ou 1–8) com flat extras possíveis
- **Tobacco** classes próprias

**Restrição-chave**: Preferred classes **não** disponíveis para ages 0–65 com face ≤ $250,000. Para esse tier, máximo é Standard.

### 3.2 Build Chart (BMI)

NLG tem build chart proprietário no Form 62797. Não consegui extrair tabela exata. Direcionalmente (padrão de mercado, alinhado ao Form):
- **Preferred Plus**: BMI ~18–28 `[confirmar limites NLG]`
- **Preferred**: BMI até ~30
- **Standard Plus**: BMI até ~33
- **Standard**: BMI até ~38
- Acima → tabular ratings
- Low BMI → "individual consideration" (NLG cita explicitamente)

> **Action item para Pedro/bot**: pegar a tabela exata do Form 62797 do portal e popular como knowledge estruturado. Sem ela, o bot deve dizer "consulte o build chart oficial" em vez de chutar.

### 3.3 No-Exam / Accelerated Underwriting

**EZ Underwriting** (programa principal):
- Ages **18–65**
- Permanente: até **$3,000,000** sem exam
- Term: até **$2,000,000** sem exam
- Powered by **LexisNexis Risk Classifier** — usa Rx, MIB, MVR, application data
- **18–25%** dos cases recebem **instant approval**

**RapidProtect** (instant-decision IUL, lançado Set/2025):
- Ages 0–60, $50K–$500K
- "No medical tests or lab work"
- Limited health questions
- Predictive underwriting com **transparent decision reasoning** (dá os top 3 motivos da decisão)

### 3.4 Exam vs. Paramed vs. APS

- Para casos fora de EZ/RapidProtect → paramedical exam (vendors típicos: ExamOne, APPS)
- **APS automático** para impairments: cancer, diabetes (insulin OU + tobacco), CAD/cardiovascular disease, emphysema, COPD, chronic bronchitis, heart murmur, hepatitis, kidney/renal disease.
- **Ages 60+**: precisam ter **routine care + physical nos últimos 24 meses** ou case é declined.

### 3.5 Medical conditions (handle típico)

| Condição | Tratamento NLG |
|---|---|
| Diabetes Type 2 (oral, controlada) | Standard a Table B/C tipicamente; APS sempre |
| Diabetes insulin-dependent | APS + tabular; Type 1 muito mais difícil |
| Hypertension controlada | Standard / Standard Plus possível |
| Coronary Artery Disease | APS + tabular; cardiologista report |
| Cancer history | APS; rated por tipo/stage/years since treatment |
| Mental health (depression/anxiety) | Disclosure obrigatório; raramente decline se controlada |
| Sleep apnea | CPAP compliance documentation |

### 3.6 Tobacco / Nicotine

- Política específica NLG não publicada nos sources `[unverified — confirmar Form 62797]`
- Direcionalmente: nicotina (cigarro/vape/chew) → Tobacco class
- Marijuana: tendência de mercado é tratar separadamente (não-tobacco) se uso ocasional `[confirmar política NLG]`

### 3.7 MVR (Driving Record)

`[unverified — sem source público que detalhe triggers NLG específicos]`. Padrão de mercado: 2+ moving violations em 3 anos, qualquer DUI em 5–10 anos, reckless driving → flat extra ou tabular.

### 3.8 Foreign Nationals

**NLG tem NLG Foreign National Guidelines PDF próprio** (não consegui extrair texto do PDF). Padrão de mercado para tier-based:
- **Country tiers A–E (ou I–IV)** baseados em risk político/socio-econômico/health
- **Visa types tipicamente aceitos** (padrão de mercado, não NLG-specific): E1, E2, E3, EB5, H1B, H4, K3, K4, L1, L2, O1, OPT-F1, P, TN/TN1
- US presence: tipicamente **6+ meses** no país
- **Para non-citizens / non-PR**: max no-exam tipicamente $300K
- Restrições maiores para tiers C/D/E

> **Action item**: extrair NLG Foreign National Guidelines do portal e codificar tier-by-tier. Esse é o ponto que mais varia entre carriers.

### 3.9 Financial Underwriting

`[unverified - confirmar thresholds NLG]`. Padrão:
- Income justification: face = 20–30x income (idades jovens), descrescendo com idade
- Cover letter do agente é **explicitamente valorizado** pela NLG (cita no guide)
- Net worth justification para affluent cases

### 3.10 Replacement / 1035

- 1035 exchange basis disponível via help system NLG (página NWI Peach)
- Sales desk faz suitability review específico em replacements

---

## 4. Processo de aplicação

### 4.1 Stack tecnológico

- **Illustration**: **NLG ForeSight** (Hexure) — web + desktop. Usado também no Quick Quote do mobile app.
- **eApp**: **iGo** (iPipeline) — eApp + e-signature + integração com illustration PDF
- **Underwriting engine**: **Resonant** (iPipeline) — automated rules + LexisNexis Risk Classifier
- **Resultado integrado**: NLG é citada como uma das primeiras a fazer **same-day issuance fully digital** (de ~46 dias para <1 dia em casos elegíveis)

### 4.2 Fluxo eApp (iGo)

1. Roda illustration no ForeSight
2. Envia diretamente para iGo (illustration PDF entra no application package)
3. Preenche application — **yellow fields** = required
4. Assinatura: e-Signature via email **OU** wet signature (print/sign/fax/mail)
5. Submissão automática
6. Underwriting Resonant → decisão (instant em ~18-25%, paramed em outros)

### 4.3 Documentos típicos pro ticket

- ID válido
- Voided check (para EFT)
- Illustration assinada (compliance NAIC)
- **Replacement forms** quando aplicável (Reg + state-specific)
- Cover letter do agente (recomendado para casos não-padrão)
- Para annuities: suitability questionnaire

### 4.4 Timeline típico

- **EZ / RapidProtect**: minutos a 1 dia
- **Standard com paramed**: 2–4 semanas
- **Com APS**: 4–8 semanas (variável por médico)

### 4.5 e-Delivery

- Suportada (e-signature na delivery também) via plataforma iPipeline

---

## 5. Case handling — diretrizes de compliance pro agente

### 5.1 Suitability / Best Interest

- **Carrier Specific Training (CST)** obrigatório antes de solicitar annuities — para todos os agentes em qualquer estado
- **State-specific overlays**:
  - **NY Reg 187** (Best Interest Standard) — vida E annuities. Sem treinamento Reg 187, **não se vende em NY**.
  - **CA**: 8-credit BIS inicial + 4-credit a cada 2 anos
  - **MN**: 4-credit MN-specific (não recíproco)
  - Demais estados NAIC Reg 275 → 4-credit one-time, recíproco entre eles

### 5.2 Replacement

- Forms estaduais (NAIC Replacement Form A/B onde aplicável)
- Sales desk NLG faz review interno
- 1035: tem help page específica no system; trigger justificativa para benefícios deixados na old policy

### 5.3 Illustration regulation

- Sign-off requirement on every illustration that goes with the app
- **CRÍTICO**: lawsuit Virani v NLG mostrou que **illustrations com proprietary index (US Pacesetter)** mostrando 20 anos de retorno **backtested** (índice só existe desde Dez/2021) gerou class action. **Não cite o "histórico" do US Pacesetter como se fosse retorno realizado** — sempre marcar como hypothetical / backtested. Vermont judge sided com NLG no breach/deception/RICO em jul ruling, mas plaintiff teve 20 dias para amend.
- Guideline pro agente: **mostrar hypothetical illustrated rate + guaranteed columns side-by-side**, explicar fees/COI, NUNCA prometer "returns" e NUNCA dizer "your money is in the market".

### 5.4 AML / KYC

- AML certification required no contracting (faz no agent back-office NLG)
- Refresher periódico

### 5.5 Forms anuidade

- Disclosure forms estaduais
- Suitability questionnaire NLG
- GLIR election form quando aplicável

---

## 6. Recursos pro agente

### 6.1 Illustration software

- **NLG ForeSight** (Hexure) — web e desktop. Help docs em `nationallife.com/NWI/Help/en-US/Peach/`
- **Quick Quote** dentro do NLG Agents app (mobile)

### 6.2 Agent Portal (`agent.nationallife.com`)

- **Lightning Bolt** (acesso rápido a tools mais usadas)
- Case management, status, commissions
- Marketing center, campanhas pré-fabricadas (Sleep Well Client Campaign, Term to Perm Conversion eKit)
- Forms library, training modules

### 6.3 NLG Agents Mobile App (iOS + Android)

- Case status & tracking
- Quick Quote (illustrations rápidas)
- **Commission calendar** + reports (pending + payable)
- Text notifications

### 6.4 Training

- **NLGroup University (NLGroupU)** — portal training video/online
- **New Advisor Lift-Off Program** (virtual, novos)
- **Practice Management Conference** (year-2 producers)
- **The Edge Annual Summit** (top leaders)
- **Illustration & Case Design School**
- On-site schools + virtual webinars
- Sales desk live + advanced sales team (poucas carriers têm dedicado)
- **CPA Advantage Program** — 30-year-old, focus em parceria com contadores

### 6.5 "Cabana" e "Get Rocket Fuel"

`[unverified — esses nomes NÃO aparecem como produtos oficiais NLG nas pesquisas]`. Possibilidades:
- Cabana.io é uma plataforma social marketing genérica para solopreneurs (não é NLG).
- "Rocket Fuel" não retornou ligação NLG.
- Pode ser nomes internos de IMO específico (ex.: AHCP, BenaVest, NFG Brokerage) ou recurso lançado recentemente. **Pedir confirmação ao Pedro / IMO** antes do bot citar esses nomes.

### 6.6 Producer Workplace

`[unverified]` — terminologia possível para agent portal mas não validada como nome oficial atual NLG.

### 6.7 Compensação (overview)

- Schedule oficial é gated; informações públicas limitadas:
  - **Level DL9** (BenaVest reference Fev/2026): New Business 95%, Renewal 2,75% `[validar para o nível contratado do Pedro]`
  - IUL: comissão sobre **target premium** (excess premium → comissão muito menor)
  - Bonuses + persistency bonuses + conferences (top producers)
  - Co-op funds disponíveis
  - Recruiting overrides para agency builders
- **Source recomendada**: pedir GAF_8175 commission schedule via IMO

### 6.8 Marketing materials

- Marketing Center no portal — print, social, email templates
- Customizable agent websites (via vendors parceiros)
- Social Media Playbook
- Consumer brochures por produto (TC numbers, ex.: SummitLife = TC125370)

---

## 7. Compliance e estados

### 7.1 Distribuição NLIC vs LSW

| Estado | Carrier emissor padrão |
|---|---|
| **NY** | NLIC (LSW NÃO licenciada em NY) |
| Outros 49 + DC | LSW (especialmente IUL e annuities recentes); NLIC para alguns produtos |

### 7.2 NY-specific

- Reg 187 (Best Interest) treinamento obrigatório
- Cap rates em IUL frequentemente **diferentes** (geralmente menores) que o resto do país — atualizações de cap geralmente excluem NY
- Free 10-day look (varia por produto)
- Some products **not available** em NY — sempre confirmar disponibilidade no portal por estado

### 7.3 License requirements

- Resident state life license (mínimo)
- Variable products (VUL/VA via ESI) → **Series 6 ou 7 + 63** + state securities reg
- Annuity training (NAIC Reg 275 onde adotado) + NLG CST

---

## 8. Sales workflow típico

1. **Lead in**: agente recebe lead (próprio funnel, IMO, referral, NLG-supplied campaign).
2. **Qualifier call**: identificar need (death benefit, retirement supplement, business protection, college funding via IUL), state, age, health overview.
3. **Illustration prep**: ForeSight — selecionar produto (FlexLife default middle America; PeakLife/SummitLife se >$1M target; RapidProtect se rapidez crítica; Term se budget-only).
4. **Fact-finder + Suitability**: needs analysis, financial data, beneficiary intent.
5. **Present illustration**: SEMPRE mostrar guaranteed columns + non-guaranteed; explicar floor/cap/par; mostrar living benefits.
6. **Application via iGo**: integra illustration → eApp → e-sign cliente.
7. **Underwriting decisão**:
   - EZ/RapidProtect: instant ou poucos dias
   - Outros: paramed agendado (ExamOne) → APS se trigger → Resonant decision → counter-offer ou approval
8. **Policy delivery**: e-delivery preferred (via iPipeline); cliente assina delivery receipt; first premium settlement.
9. **Post-issue**: client mobile app onboarding; agente acompanha persistency (importante para comissão e bonus).
10. **Annual review**: especialmente para IUL — reset de strategy, top-up via Premium Deposit Account, considerar APB ratio.

---

## 9. Erros comuns / pitfalls

1. **Ilustrar US Pacesetter como histórico real** → exposição legal (lawsuit Virani 2024+). Sempre marcar como backtested/hypothetical.
2. **Não explicar surrender charges** — schedule típico ~$50K ano 1, descrescendo até ~$5K ano 10 em IUL com target premium alto. Cliente que precisa do dinheiro cedo é caso para WL ou Term, não IUL.
3. **Vender Preferred sem ter elegibilidade** — face ≤$250K não tem Preferred até age 65. Cota Standard, não prometa Preferred.
4. **Esquecer de pedir physical para 60+** — auto-decline se não fez nos últimos 24 meses.
5. **Pitch "borrow your own money"** — semanticamente errado. É loan da seguradora com cash value como collateral.
6. **Não rodar CST + state training antes de annuity** — application bate volta.
7. **NY sem Reg 187** — não se vende. E LSW não emite em NY → use NLIC.
8. **Confundir target premium com max premium** — comissão integral só em target. Excess tem comissão drasticamente menor (~3-5% típico).
9. **Replacement sem 1035 vs withdrawal** — taxa hit se não estruturar como 1035.
10. **Não setar expectativa de COI growth** — IUL fees crescem com idade (mortality), o que pode comer cash em anos zero. Cliente surpreso = lawsuit risk.
11. **Vender PeakLife/SummitLife para cliente que não tem $1M target** — produto é overkill, vai ficar underfunded e implodir.
12. **Foreign national sem checar tier do país** — case rejeitado tarde.
13. **Não offer ABR explicitamente** — diferenciador NLG vs concorrência; agentes esquecem que vem grátis.
14. **Confundir LSW vs NLIC em conversation com cliente** — both são "National Life", explica corporate structure se perguntado.

---

## 10. Items para Pedro confirmar antes do bot ir live

1. **Build chart exato (BMI por classe)** — extrair Form 62797 do portal interno
2. **Foreign National country tiers + visa list NLG-specific** — extrair do PDF gated
3. **Tobacco/marijuana policy detalhada NLG**
4. **Cap rates atuais por strategy/produto/estado** (mudam anualmente)
5. **Commission schedule oficial** (GAF_8175 ou equivalente atual) por nível contratual do Pedro
6. **"Cabana" e "Get Rocket Fuel"** — confirmar se são NLG, IMO-específico ou não existem
7. **LIBR waiting period exato** por produto (10 vs 15 anos)
8. **Lista atualizada de WL/Survivorship WL** (LSW ProtectorLife, ValuGuard ainda ativos?)
9. **Producer guide PDF público vs gated** — qual versão pode ser exposta ao bot

---

## 11. Referências

### Oficial NLG
- https://www.nationallife.com/
- https://www.nationallife.com/OurStory-Financials-Ratings
- https://www.nationallife.com/Our-Story/newsroom/AM-Best-A-Plus-Rating
- https://insurancenewsnet.com/oarticle/national-life-group-releases-its-2025-annual-report-and-business-highlights
- https://www.nationallife.com/Individuals-Families-Living-Benefits
- https://www.nationallife.com/Our-Story/newsroom/NLG-expand-suite-of-living-benefits-adds-Alzheimers-and-Fertility-Riders
- https://www.nationallife.com/Our-Story/newsroom/flexlife-iul-enhancement-sandwich-generation-support
- https://www.nationallife.com/our-story/newsroom/rapidprotect
- https://www.nationallife.com/Resource-center
- https://www.nationallife.com/Financial-Professionals/New-to-the-Business
- https://www.nationallife.com/NWI/Help/en-US/Peach/Introduction.htm
- https://www.nationallife.com/NWI/Help/en-US/Peach/iGo_e-App_Submission.htm
- https://www.nationallife.com/NWI/Help/en-US/Peach/DBF_1035_Exchange_Basis.htm
- https://www.nationallife.com/our-businesses-esi
- https://www.nationallife.com/Employers-PlanSponsors/Guaranteed-Lifetime-Income-Rider
- https://www.nationallife.com/docs/digital/ob/tipsheets/UnderwritingTips.pdf (binary)
- https://www.nationallife.com/docs/digital/ob/ekitind/index.html
- https://digital.nationallife.com/workingwithNationalLife
- https://apps.apple.com/us/app/nlg-agents/id964515750
- https://play.google.com/store/apps/details?id=com.nlgroup.nlgagent

### IMOs / Wholesalers (third-party com material útil)
- https://nfgbrokerage.com/national-life-increased-caps-on-flexlife-peaklifem-summitlife-and-survivorlife-iuls/
- https://nfgbrokerage.com/national-life-group-national-lifes-survivor-life-index-universal-life/
- https://www.messerfinancial.com/resources/news-blog/news/carrier-updates/life-final-expense/national-life-increased-caps-on-flexlife-peaklife-summitlife-and-survivorlife-iuls
- https://www.fmiagent.com/carrier/national-life-group/survivorlife-survivorship-indexed-universal-life/
- https://www.fmiagent.com/wp-content/uploads/2025-11-12_National_Life_Group_IUL_Comparison_Advisor_Flyer_108350_10-25.pdf
- https://www.benavest.com/national-life-group-life-all-products/
- https://www.empowerbrokerage.com/downloads/Carriers/NLG/GAF_8175-0116.pdf
- https://www.insureuniversity.com/national-life-group-commissions-life/
- https://aegisfinancial.com/wp-content/uploads/2024/07/National-Life-Group-CST-Instructions.pdf
- http://www.cassaniinsurance.com/wp-content/uploads/2023/12/National-Life-Group-Underwriting-Guide-2023.pdf
- https://experiorusa.com/uploads/media/NLG-Underwiting-Guide-Experior.pdf
- https://www.totalfinancial.com/carriers/downloads/lsw/lsw-uw1.pdf
- https://lbfg.net/wp-content/uploads/National-Life-LSW-UW-Guide.pdf
- https://nfgbrokerage.com/wp-content/uploads/National-Life-Foreign-National-Guidelines.pdf

### Mídia / Análise independente
- https://en.wikipedia.org/wiki/National_Life_Group
- https://ogletreefinancial.com/blog/national-life-group-company-review/
- https://www.insuranceandestates.com/national-life-group-review/
- https://www.nerdwallet.com/insurance/life/national-life-group-life-insurance-review
- https://www.insuredbetter.com/insurance-articles/reviews/national-life-insurance-company-review/
- https://www.trustedchoice.com/insurance-articles/c/national-life-insurance-company-review/
- https://www.retireguide.com/annuities/companies/national-life-group/
- https://smartasset.com/retirement/national-life-group-annuity-review
- https://www.annuity.org/annuities/providers/national-life-group/
- https://myannuitystore.com/annuity-insurance-companies/national-life-group/
- https://insurancebyheroes.com/iul-explained-national-life-group-2025-update/
- https://ipipeline.com/ipipeline-ecosystem-enables-national-life-group-to-create-fully-automated-new-business-underwriting-platform/

### Lawsuits / Riscos
- https://insurancenewsnet.com/innarticle/new-lawsuit-accuses-national-life-of-misleading-iul-illustrations
- https://insurancenewsnet.com/innarticle/state-claims-added-to-amended-lawsuit-over-national-life-iul-illustrations
- https://insurancenewsnet.com/innarticle/vermont-judge-sides-with-national-life-on-iul-illustrations-lawsuit
- https://investorlosscenter.com/iul-lawsuits/national-life-group/
- https://www.insurance-forums.com/community/threads/national-life-iul-lawsuit.115820/
