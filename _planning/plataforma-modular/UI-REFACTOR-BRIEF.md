# BRIEF — Refatoração COMPLETA do Front-End · Spark AI Hub
### Prompt para agente de frontend-design (Claude Code) · 2026-05-25

> Cole este arquivo inteiro como prompt no Claude Code. Ele é auto-contido.

---

## 0. SUA MISSÃO

Você vai **reconstruir TODO o front-end** do Spark AI Hub — uma plataforma SaaS multi-tenant de **agentes de IA para agências de seguros** (CRM "Spark Leads"). A UI atual é funcional mas inconsistente; o dono quer uma **refatoração completa, coesa, production-grade e visualmente distinta** — tudo encaixando numa só linguagem de design.

**Use a skill `frontend-design`** (metodologia de design distinto, anti-"AI-slop"). **Antes de codar, explore o repositório** pra entender o que existe (rotas, componentes, APIs, tokens) e construa **em cima da stack atual** — não reinvente o backend.

Você tem **liberdade criativa total na estética e nos fluxos não-definidos** (ex.: o passo-a-passo exato do onboarding, empty states, micro-interações, copy). O que está abaixo é o **contrato de produto + dados + telas obrigatórias**; o *como fica bonito e fluido* é com você. Comprometa-se com **uma direção forte e coesa** (light ou dark, tipografia distinta, sistema de tokens) e execute com precisão. Evite genérico (nada de Inter/Roboto, gradiente roxo, layout clichê).

---

## 1. CONTEXTO DO PRODUTO (entenda o modelo antes de desenhar)

**Spark AI Hub** = painel onde uma agência configura e opera **agentes de IA**. Modelo modular:

- **SparkBot** — agente **rep-facing** (fala com o **corretor/rep**, não com leads). Ajuda o rep a operar o CRM via WhatsApp (busca contatos, cria notas/tasks, agenda, dispara follow-ups). **Incluso e grátis** em toda conta.
- **Agentes lead-facing** — **Venda**, **Recrutamento** e **Custom** (evento/nicho). Falam com **leads/contatos** em nome do rep. São **upsell pago** ($50/agente/mês). Cada um vive numa **sub-account própria** com **canais conectados** (WhatsApp, Instagram DM, e mais no futuro).
- **Agente = Template + Módulos compostos.** Um agente é montado de **módulos** que encaixam: `comportamento`, `janela de tempo (active_hours)`, `follow-up`, `qualificação (data fields)`, `agendamento`, `anti-spam/compliance`, `canal`, `operações CRM (crm_ops)`, `base de conhecimento (knowledge)`, `disparo em massa (bulk)`.
- **Entitlement** controla acesso aos agentes pagos (por enquanto liberação **manual** por admin; self-serve depois).
- **Eixo central: audiência** — `rep` (SparkBot) × `lead` (venda/recrut/custom). A UI deve deixar isso claro.

**Público:** donos/operadores de agência de seguros (BR + US). Tom: **profissional, confiável, moderno, premium** — software sério, mas com personalidade. Idioma da UI: **PT-BR**.

---

## 2. STACK + RESTRIÇÕES TÉCNICAS

- **Next.js 14 (app router)** · **TypeScript** · **Tailwind CSS**.
- Componentes base em `src/components/ui/**` (estilo shadcn/ui sobre **Radix**: Button, Card, Input, Select, Tabs, Switch, Dialog, Badge, Slider, Skeleton, Separator…). **Reuse e evolua** esses; pode criar novos.
- Ícones: **lucide-react** (⚠️ esta versão NÃO exporta `Instagram` — use `Camera`/`AtSign`). Toasts: **sonner**. Sem lib de form (inputs controlados + zod).
- Auth: **SSO** via `getSession()` (server) — retorna `{ userId, companyId, locationId, isAdmin }`. Multi-tenant via `TenantProvider` (context com location/company/user).
- Estado: React hooks + Context (sem Redux/zustand).
- **NÃO quebre o backend.** Pode refatorar páginas/componentes/estilos à vontade, mas as **rotas de API e o schema do banco são contratos** (seção 3). Se precisar de um endpoint novo, crie seguindo os padrões existentes (auth com `getSession`/`unauthorized`, `errorResponse`).
- **Qualidade:** `npx tsc --noEmit` e `npx next build` têm que passar limpos. Responsivo (mobile→desktop). Acessível (foco visível, labels, contraste AA, teclado). Performance (server components onde der; client só onde precisa de estado).

### 🚫 REGRA DE NOME INVIOLÁVEL
Em **qualquer texto que o usuário vê** (labels, botões, mensagens, vazios, tooltips): use **"Spark Leads"** (ou "Spark") pra se referir ao CRM. **NUNCA** "GHL" nem "GoHighLevel". (OK manter "GHL" só em nomes de variável/type/função internos.) Não exponha jargão técnico/stack (Stevo, Evolution, etc.) na UI.

---

## 3. MODELO DE DADOS + APIs (wire em dados REAIS, não mock)

**Tabelas (Supabase/Postgres) relevantes:**
- `agents`: `id, location_id, type ('account_assistant'|'sales_agent'|'recruitment_agent'|'custom_agent'), status ('active'|'inactive'), name, audience ('rep'|'lead'), template_key, expires_at`.
- `agent_configs`: config rica por agente — `ai_model, custom_instructions, system_prompt_override, tone_creativity/formality/naturalness/aggressiveness (0-100), data_fields (jsonb), enabled_channels (text[]), confirmation_mode, daily_proactive_limit, quiet_hours (jsonb), working_hours (jsonb), targeting_rules (jsonb), deactivation_rules (jsonb), disabled_tools (text[])…`.
- `agent_templates`: `key, name, audience, description, default_modules (jsonb array de module keys), version`. Seeds: `sparkbot, sales, recruitment, custom`.
- `agent_modules` (catálogo): `key, name, category, audience_scope ('rep'|'lead'|'both'), version`. Catálogo atual: behavior, active_hours, followup, qualification, scheduling, compliance, channel, crm_ops, knowledge, bulk.
- `agent_module_instances` (composição por agente): `agent_id, module_key, module_version, enabled, settings (jsonb), prompt_override, sort_order`.
- `agent_entitlements`: `location_id, capability ('sales_agent'|'recruitment_agent'|'custom_agent'), status ('active'|'revoked'), source ('manual'|'purchase'), granted_by, granted_at, expires_at, monthly_price_usd (default 50)`.

**APIs já existentes (use):**
- `GET /api/agent-platform/catalog` → `{ templates, modules, activeCapabilities, isAdmin, capabilityByTemplate }` (catálogo + o que a location tem liberado).
- `POST /api/agent-platform/agents` → cria agente do wizard. Body `{ template_key, name?, module_keys[] }`. Mapeia template→tipo+audiência, passa pelo gate de entitlement, cria `agents + agent_configs + agent_module_instances`.
- `GET/POST /api/agents` → lista/cria (legado; tem gate de entitlement no POST).
- `GET/PUT /api/agents/[agentId]/config` → config do agente.
- `/api/agents/[agentId]/activity`, `/api/agents/sparkbot/rules` (proatividade), `/api/sparkbot/*` (embed: send/inbox/scheduling-prefs).
- Crie endpoints novos pra **entitlement admin** (liberar/revogar) e o que mais precisar — há repo pronto: `src/lib/repositories/agent-platform.repo.ts` (`grantEntitlement`, `revokeEntitlement`, `listEntitlements`, `listTemplates`, `listModules`, `getAgentModuleInstances`).
- Gate de entitlement: `src/lib/agent-platform/entitlements.ts` (`checkAgentEntitlement`, `capabilityForAgentType`).

---

## 4. TELAS OBRIGATÓRIAS (todas — com elementos, botões, estados, funções)

> Para CADA tela: projete os estados **loading / vazio / erro / sucesso**, e onde houver agente pago **bloqueado (sem entitlement)**. Toasts em ações. Validação em forms. Responsivo.

### 4.1 Shell do app (navegação)
- Top bar + navegação entre seções. Mostra a **location/tenant** ativa (multi-tenant) e troca de location se o user tiver várias. Marca Spark Leads. Busca global (opcional).
- Seções: **Agentes (Hub)** · **Atividade** · **Billing** · **Configurações** · (se admin) **Admin**.

### 4.2 Hub de Agentes (home) — **peça central**
- Lista os agentes da conta **agrupados por audiência**: bloco *"Seu SparkBot"* (rep, incluso) e bloco *"Agentes de Leads"* (venda/recrut/custom).
- Cada **card de agente**: nome, tipo, badge de audiência (fala com você × fala com leads), status (ativo/pausado), canais conectados, **badge de preço/entitlement** ($50/mês ou Incluso, ou "Bloqueado/Liberar"), mini-stats (msgs 24h, taxa de resposta), data de expiração se temporário. Botões: **Abrir/Configurar**, **Pausar/Ativar**, **Testar**.
- **CTA forte `+ Novo Agente`** → wizard (4.3).
- Empty state quando só tem SparkBot: convida a criar o 1º agente de leads.

### 4.3 Onboarding / Wizard de criação de agente — **você define o fluxo exato**
Objetivo: o usuário monta um agente do zero de forma deliciosa. Esqueleto sugerido (refine à vontade): **escolher tipo (template) → conexão (sub-account/canal) → compor módulos → revisar → criar**.
- **Tipo:** cards dos templates (SparkBot incluso; Venda/Recrut/Custom pagos), com audiência, preço e **cadeado** se não liberado (admin vê tudo). Selecionar pré-seleciona os `default_modules`.
- **Conexão:** rep = "fala direto com você"; lead = escolher canais conectados (WhatsApp/Instagram). (Provisionamento da sub-account é manual pela agência — a UI assume canais já conectados; mostre-os.)
- **Módulos:** ligar/desligar módulos do catálogo filtrados pela audiência (`audience_scope`). Deixe o conceito de "montar de peças" tangível.
- **Revisar + nomear + Criar** → `POST /api/agent-platform/agents`. Sucesso → vai pro agente/hub com toast.
- Considere também uma variante **conversacional** (uma IA que pergunta e monta) como fase futura — pode deixar o gancho na UI.

### 4.4 Detalhe / Configuração do Agente — **config MODULAR (unificada)**
- A grande mudança: a config do agente é **organizada por MÓDULOS ligados** — cada módulo é uma **seção** com toggle (ligar/desligar) + seus settings. Isso vale **igual** pra SparkBot e pra lead agents (linguagem única).
- Settings por módulo (exemplos): *comportamento* (tom: 4 sliders 0-100, instruções custom, modelo IA, confirmation_mode), *janela de tempo* (quiet/working hours + timezone + dias), *follow-up* (sequência/intervalos), *qualificação* (data_fields editáveis), *agendamento* (calendário padrão, duração, override), *canal* (enabled_channels), *crm_ops* (tools liberadas/bloqueadas), *knowledge* (KB + instruções), *compliance/anti-spam* (limites, opt-out), *bulk*.
- Header do agente: nome editável, status, audiência, conexão, preço, expiração. Ações: **Salvar**, **Pausar/Ativar**, **Testar** (chat de teste inline), **Adicionar módulo** (abre o catálogo), **Remover módulo**.
- Aba/área de **Atividade** do agente (conversas, métricas).

### 4.5 Admin → Entitlements (substitui o script manual)
- Só pra admin. **Grid/lista location × capacidade** (`sales_agent`, `recruitment_agent`, `custom_agent`): status (ativo/revogado), preço ($50 default, editável), fonte (manual/compra), liberado por/quando, expiração.
- Ações: **Liberar** (com preço + expiração opcional), **Revogar**, editar preço. Busca/filtro por location. Crie os endpoints (use `grantEntitlement`/`revokeEntitlement`).

### 4.6 Dashboard / Analytics
- Visão consolidada: KPIs (msgs, taxa de resposta, agendamentos, leads qualificados), filtro de período (presets + custom), breakdown por agente, gráfico de atividade. (Já existe um `getOverview` com date range + taxa de resposta — reutilize/evolua.)

### 4.7 Billing
- Assinatura + uso: agentes pagos ativos ($50/mês cada), uso medido (tokens/áudio/imagem), cap mensal, histórico. Deixe claro o que é incluso (SparkBot) vs pago.

### 4.8 Atividade (log) e Configurações (conta)
- Log de mensagens/ações com filtros. Configurações da conta/agência (preferências, fuso, etc.).

### 4.9 (Opcional, alto valor) Embed do SparkBot
- Há um chat embed (`/embed/sparkbot`) carregado num iframe dentro do Spark Leads (auth por JWT, não SSO). Já é polido (azul, mascote). **Opcional:** alinhar à nova linguagem. Mantenha-o funcional (send/inbox/upload/áudio).

### 4.10 Login / Landing
- Tela de entrada coerente com a nova marca.

---

## 5. O QUE VOCÊ DEFINE (liberdade criativa)
- **Direção estética completa**: tema (light/dark), tipografia distinta (display + corpo), paleta (sobre o azul Spark #1675F2/#155EEF — pode introduzir 1 acento), textura/atmosfera, sombras, motion, sistema de tokens (CSS vars + tailwind). Comprometa-se com algo memorável e coeso.
- **Fluxo de onboarding** exato (passos, copy, micro-interações), empty/error states, padrões de navegação, densidade.
- **Componentização**: um design system enxuto e reutilizável.

## 6. ESTADOS & FUNÇÕES OBRIGATÓRIOS (não esqueça)
loading (skeletons), vazio (com CTA), erro (amigável + retry), **bloqueado por entitlement** (com caminho pra liberar), sucesso (toast), validação de form, confirmação em ações destrutivas (pausar/revogar/remover módulo), optimistic UI onde fizer sentido, foco/teclado/a11y, responsivo.

## 7. ENTREGÁVEIS + BARRA DE QUALIDADE
- Código Next.js 14 + Tailwind **production-grade**, wired nas APIs reais (seção 3), `tsc` + `build` limpos.
- Design **coeso, distinto, premium** — nada de AI-slop.
- PT-BR em toda a UI. "Spark Leads" (nunca GHL). Responsivo + acessível.
- Um **design system documentado** (tokens, componentes) pra tudo encaixar.

## 8. PROCESSO SUGERIDO
1. Explore o repo (rotas, `src/components/ui`, `tailwind.config.ts`, `globals.css`, APIs, schema). 2. Defina a direção + tokens + design system. 3. Shell/navegação. 4. Hub de Agentes. 5. Wizard de onboarding. 6. Config modular do agente. 7. Entitlement admin. 8. Dashboard/Billing/Atividade. 9. Polish (motion, estados, responsivo, a11y). Commit incremental, `tsc`/`build` verdes a cada etapa.

---

### Contexto extra (se quiser se aprofundar)
- Plano da plataforma modular: `_planning/plataforma-modular/PLANO.md`.
- Convenções do projeto: `CLAUDE.md` (raiz). Decisões: `docs/DECISIONS.md` (H35 = plataforma modular).
