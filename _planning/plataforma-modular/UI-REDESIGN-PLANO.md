# PLANO — Redesign completo da UI + Fluxo de criação de agente

> **Plataforma Modular de Agentes · Fase 3 (UI) — versão definitiva**
> Data: 2026-05-25 · Autor: Claude (com Pedro) · Status: **plano aprovado p/ execução, aguardando "go" da Fase A**
> Fonte de design: handoff do Claude Design `Spark AI Hub v3` (`/tmp/spark-design/sparkbot-refactor/`)
> Documento-irmão: `PLANO.md` (plataforma modular, fonte de verdade do back-end) · `UI-REFACTOR-BRIEF.md` · `UI-DESIGN-PROMPT.md`

---

## 0. Decisões travadas (Pedro, 2026-05-25)

Quatro escolhas que definem a forma do plano:

| # | Pergunta | Escolha | Consequência |
|---|----------|---------|--------------|
| 1 | IA conversacional é porta de entrada de todo agente, ou só do Custom? | **IA só no Custom** | Venda/Recrutamento abrem **direto na config pré-montada** do template. Só o Custom abre o **builder com IA**. SparkBot nunca é criado (já existe). |
| 2 | Como a IA monta o agente custom no V1? | **Claude monta tudo** | Conversa livre → Claude emite um **spec estruturado** (módulos, tom, instruções, qualificação) → cai na config já preenchida pra revisar/testar. |
| 3 | Onde a UI vive + mantém sidebar? | **GHL iframe + sidebar** | Embeda como custom link no menu do **Spark Leads**. Mantemos nossa sidebar como sub-navegação. Login via SSO (já existe). |
| 4 | Substitui de uma vez ou paralelo? | **Paralelo (rota/flag)** | UI nova nasce em **rota nova** (`/hub`); a UI atual (`/dashboard`) fica no ar. Viramos a chave quando você validar em prod. |

**Princípio-guia herdado do design (e que eu concordo):** isso mora **dentro do Spark Leads**, pra **corretor 30-50 anos, não-tech, BR+EUA**. Logo: **linguagem plana PT-BR, zero jargão** ("Como o agente fala", não "módulo Comportamento"), 1 ação principal por tela, botões grandes, CRM-native (não produto editorial paralelo). Tudo neste plano respeita isso.

---

## 1. O que transferir do Claude Design (matriz)

O v3 passou por 3 iterações no Claude Design (creme editorial → lemon/dark "spark/hub" → **v3 CRM-native**, que é a que você gostou). Reconciliando o v3 com a minha visão e com o código real:

### 1.1 TRANSFERIR fielmente (o v3 acertou)
- **Shell:** sidebar clara (220px) + topbar (52px) com breadcrumbs, busca ⌘K, sino, botão **"Novo agente"**, rodapé de usuário. Nav: **Início · Agentes · Mensagens · Faturamento · Conta** (+ **Acessos** só admin).
- **Início:** saudação "Olá, {nome}", 4 KPIs grandes, lista "Seus agentes", card escuro do **SparkBot** com sugestões clicáveis + "Abrir no WhatsApp", feed "Atividade recente".
- **Agentes:** filtros (Todos/Ativos/Pausados) + linhas (AMark, nome, template, canais, status, badge de preço).
- **Agente → detalhe:** header (voltar, marca, nome, status/canais/preço, Testar/Pausar/Salvar) + tabs (Configurações/Mensagens/Documentos/Histórico).
- **Config = cards expansíveis** com **rótulos amigáveis** (o `labelMap`/`subMap` do v3 é ótimo): "Como o agente fala", "Horário de atendimento", "Mensagens automáticas (follow-up)", "Qualificação de leads", "Agendamento de reuniões", "Limites e LGPD", "Canais", "Ações no CRM", "Documentos de apoio", "Disparo em massa".
- **TestChat** inline (modo teste, "não toca no CRM").
- **Acessos** (entitlements): KPIs + busca + tabela (escritório × Vendas/Recrutamento/Custom, status, preço, liberado em) + ação Liberar/Editar.
- **Faturamento:** próxima cobrança + itens, forma de pagamento, uso do mês (3 barras), histórico.
- **Conta:** dados da agência + notificações.
- **Login:** card "Entrar com Spark Leads" (SSO) + email.
- **Design tokens v3:** **Geist** (corpo) + **Geist Mono** (números), **azul Spark primário** (`#155EEF` / `#1675F2`), sidebar clara `#F8FAFC`, cards padrão com borda + sombra sutil, raios 8-14px, modos de densidade, suporte a tema escuro.
- **Componentes:** `AMark`, `StatusBadge`, `ChannelChip`, `PriceBadge`, `KPI`, `ActRow`, `FRow`, `Sld` (slider rotulado), `UseBar`, `EntCell`.

### 1.2 REPENSAR (minha visão > o v3)
- **★ Fluxo de criação** — o v3 reduziu pra "3 perguntas" (Tipo→Nome→Canais). **Insuficiente** pro que você quer. Substituo por um **fluxo ciente do tipo** (Seção 4): Venda/Recrutamento caem direto na config pré-montada; **Custom abre o builder com IA conversacional** + animação de montagem. Esta é a peça-mãe.
- **Config persistente** — o v3 é mock. Vou **conectar os toggles e settings ao back-end real**: toggle de seção → `agent_module_instances.enabled`; ajustes → `agent_configs`. Adiciono **"+ Adicionar módulo"** (catálogo) — o v3 só lista módulos estáticos.
- **TestChat real** — conectar aos endpoints de teste que já existem (`/api/agents/account-assistant/test` + `sessions`), em vez do eco mockado.
- **Mensagens / KPIs** — ligar à `/api/activity` e ao dashboard real (taxa de resposta, qualificados já existem do trabalho de dashboard).
- **Multi-escritório ("3 escritórios")** — o `useTenant` hoje é 1 location. O switcher fica **stub visual no V1** (mostra a location atual) e vira real quando houver troca de conta de verdade (V2). Documentado, não inventado.

### 1.3 NÃO transferir (descartar)
- **Instrument Serif / display editorial** — o próprio v3 já largou; ficamos **all-sans** (Geist).
- **Lima `#A3E635` + Bricolage Grotesque + textura blueprint** — sobras da v2 editorial **rejeitada**, hoje presentes no `tailwind.config.ts` (primeira tentativa). **Reverter** pra azul + Geist.
- **Wizard antigo de 4 passos** (`wizard.jsx`) e a **primeira tentativa** (`src/app/agents/new/page.tsx`) — superados.
- **⌘K command palette** e **sino de notificações** — ficam como **stub visual** (V2 real).

---

## 2. Sistema de design (reconciliação com o código)

O código já está **quase lá**: `globals.css` usa azul Spark `#1675F2`, cards claros, sombras sutis. O ajuste é adotar o **token-set do v3** e **reverter** os tokens da tentativa rejeitada.

### 2.1 Tokens (alvo v3 — CRM-native)
- **Cor:** primário `--primary: #155EEF` (hover `#1352D7`), `--primary-soft: #E8F0FE`, acento azul `#1675F2`. Tinta `#1A2230`. Linhas `#E1E5EC`. Sidebar `#F8FAFC`. Status: success `#0E8F5A`, warning `#C97A0F`, danger `#C7331F`. **Sem laranja, sem lima.**
- **Tipografia:** `--f-body: "Geist"`, `--f-mono: "Geist Mono"`. Corpo 14.5px, h1 26-28px, KPI 32px. **Sem display serif.**
- **Raio:** xs 4 / sm 6 / md 8 / lg 10 / xl 14 / pill 999.
- **Densidade:** `data-density` comfy/regular/dense. **Tema:** `data-theme` light/dark.

### 2.2 Mudanças de arquivo
- `tailwind.config.ts`: **remover** `colors.spark` (lima), `colors.paper/ink`, `fontFamily.display` (Bricolage), `bg-blueprint`. **Manter** escala `brand` (azul). Adicionar tokens semânticos do v3 se útil (ou via CSS vars).
- `src/app/layout.tsx`: **carregar Geist + Geist Mono** (next/font ou CDN); remover Bricolage display. Manter `--font-sans` apontando pra Geist.
- **Novo** `src/app/hub/hub-tokens.css` (ou estender `globals.css` sob `[data-hub]`): porta as CSS vars do `v3.css` (sidebar, primary, raios, densidade, dark). Escopo no shell do `/hub` pra **não afetar `/dashboard`** durante o paralelo.

### 2.3 Componentes (reaproveitar `src/components/ui`)
Já existem: `button, badge, card, input, label, select, separator, skeleton, slider, switch, tabs, textarea` (Radix/shadcn). **Reskino** pros tokens v3 (escopados ao /hub) em vez de reescrever. Crio os do v3 que faltam como componentes React reais em `src/components/hub/`: `AMark`, `StatusBadge`, `ChannelChip`, `PriceBadge`, `KPI`, `ActRow`, `FRow`, `LabeledSlider`, `UseBar`, `EntCell`, `Sidebar`, `TopBar`.

---

## 3. Arquitetura da UI (rota, embed, shell)

### 3.1 Rota paralela + flag
- Nova árvore sob **`/hub`** com seu próprio `layout.tsx` (shell sidebar) + `TenantProvider` estendido (`isAdmin`, `locationName`).
- A UI atual (`/dashboard`, `/agents/*`, `/admin/*`) **fica intacta** no ar.
- Flag de visibilidade: **`NEXT_PUBLIC_NEW_HUB_UI`** (env) e/ou por conta (admin/interno primeiro). Default OFF em prod.
- **Cutover (Fase I):** apontar o custom link do Spark Leads pra `/hub`, `redirect('/dashboard') → '/hub'`, e remover shell antigo.

### 3.2 Embed no Spark Leads (GHL iframe)
- O `/hub` precisa **renderizar dentro de um iframe** no menu do GHL. Implica:
  - **Sem chrome de topo conflitante** — nossa topbar é a única; nada de header global do site.
  - **SSO**: o GHL injeta o usuário; já temos `getSession()` → `{userId, companyId, locationId, locationName, isAdmin}` e `/api/auth/sso`. Reuso.
  - **Headers**: garantir que `X-Frame-Options`/`CSP frame-ancestors` permitam o domínio do GHL (next config / middleware). **Sem isso o iframe fica em branco** — risco mapeado.
  - **Largura contida + responsivo**: sidebar colapsável em largura estreita do iframe.
  - **Cookies**: SSO em iframe cross-site exige cookie `SameSite=None; Secure` (verificar o fluxo atual de sessão).
- **Standalone** (spark-ai-platform.vercel.app) continua funcionando pra teste direto — o mesmo `/hub` abre em tela cheia.

### 3.3 Estrutura de arquivos (proposta)
```
src/app/hub/
  layout.tsx                 # shell: <HubShell session>
  hub-shell.tsx              # Sidebar + TopBar + TenantProvider(+isAdmin)
  page.tsx                   # Início
  agents/page.tsx            # Agentes (lista)
  agents/[agentId]/page.tsx  # Detalhe + tabs + config
  agents/new/page.tsx        # Entrada de criação (tiles de tipo)
  agents/new/custom/page.tsx # Builder com IA (Custom)
  messages/page.tsx          # Mensagens (log)
  billing/page.tsx           # Faturamento
  settings/page.tsx          # Conta
  access/page.tsx            # Acessos (admin)
src/components/hub/*         # componentes do design system v3
src/app/api/agent-platform/
  catalog/route.ts           # (existe) GET catálogo
  agents/route.ts            # (existe) POST criar — estender p/ status=paused + spec
  builder/message/route.ts   # (novo) turno da IA (Claude tool-use → spec)
  builder/commit/route.ts    # (novo) spec → cria agente paused + config + módulos
  entitlements/route.ts      # (novo) GET lista / POST liberar
  entitlements/[id]/route.ts # (novo) PATCH editar preço/expiração / DELETE revogar
src/app/api/agents/[agentId]/config/route.ts  # (existe) GET/PATCH config
```

---

## 4. ★ Fluxo de criação de agente (a peça-mãe)

Objetivo: **intuitivo, estilo wizard, com animação de montagem**; pro **Custom**, começa com **IA que entende o agente** e o monta o mais próximo possível do pedido; depois cai na **config pra ajustes manuais + teste**.

### 4.1 Entrada única — "Novo agente"
Botão "Novo agente" (topbar e Agentes) → tela **`/hub/agents/new`**: grid de **tiles de tipo** (cards grandes, ícone, nome, audiência, descrição, preço):
- **Venda** ($50/mês) — fala com leads.
- **Recrutamento** ($50/mês) — fala com candidatos.
- **Personalizado** ($50/mês) — "Eu te ajudo a montar do zero, conversando."
- (SparkBot **não** aparece como criável — já existe; aparece como card "incluso" só informativo, se fizer sentido.)
- Tile pago **sem entitlement** e usuário não-admin → estado **"Bloqueado · Falar com suporte"** (cadeado). Admin vê tudo (libera por Acessos).

Clicar:
- **Venda/Recrutamento →** fluxo **4.2** (pré-config, sem IA).
- **Personalizado →** fluxo **4.3** (builder com IA).

### 4.2 Venda / Recrutamento — direto na config pré-montada
1. **1 passo leve**: nome (sugestão "Venda — [seu nicho/cidade]") + canais (WhatsApp pré-marcado; Instagram se conectado). Botão **"Criar agente"**.
2. `POST /api/agent-platform/agents` com `template_key` + `module_keys` (default do template) + `channels` + `name`. **Cria PAUSADO** (mudar o atual `status:"active"` → `paused` p/ criação manual; ver §6.1).
3. **Animação de montagem** (§4.4, versão leve).
4. **Handoff** → `/hub/agents/[id]` (Configurações pré-preenchidas com os defaults do template) + **"Testar agora"** em destaque. Fica **pausado** até o usuário clicar **Ativar**.

> Racional: venda/recrutamento têm template forte (prompt + módulos + data_fields default já existem). O usuário não precisa de IA pra isso — precisa **revisar e ligar**.

### 4.3 ★ Personalizado — Builder com IA conversacional
A experiência que "tem que ser muito bem feita". Tela dedicada **`/hub/agents/new/custom`** (dentro do shell, embedável).

**Layout (split):**
- **Esquerda — conversa** (60%): superfície de chat calma, bolhas, composer com sugestões. **Não** é o modalzinho apertado do v3.
- **Direita — "ficha do agente" ao vivo** (40%, sticky): vai se preenchendo conforme a IA entende — nome, resumo do propósito, badge de audiência, canais, **módulos acendendo** (com micro-animação), barras de tom assentando. Torna tangível a metáfora "montar de peças".

**Roteiro da conversa (Claude real, Sonnet):**
- **Abertura** (plain PT-BR, acolhedora): *"Me conta com suas palavras o que você quer que esse agente faça. Pode ser bem informal — eu cuido da parte técnica."* + 3 chips de exemplo:
  - "Um agente pro feirão de seguros que vai durar até junho"
  - "Quero qualificar quem pede cotação de auto no Instagram"
  - "Um agente que reativa clientes antigos por WhatsApp"
- A IA pergunta **uma coisa de cada vez**, em linguagem de gente: o que faz? fala com quem? por quais canais? precisa **marcar reunião**? coleta quais infos do lead? tem **horário**? é **temporário** (data de expiração)? Ela **explica** quando pedem ("o que é qualificação?").
- Conforme responde, a **ficha à direita atualiza** (módulos ligam, tom move, canais aparecem).
- A IA **resume e confirma** no fim: "Então é isso: [resumo]. Posso montar?" → botão **"Criar agente"** (e "Ajustar mais um pouco").

**Motor (decisão: Claude monta tudo):**
- `POST /api/agent-platform/builder/message` — recebe histórico, chama Claude com uma **tool `propose_agent`** disponível. Enquanto falta info, a IA conversa; quando tem o suficiente, **chama a tool** emitindo o **spec estruturado**. Reusa o client LLM + cadeia de fallback (Sonnet→Haiku→GPT) já existente.
- **Spec (schema, validado server-side com zod — nunca confiar no JSON do modelo cru):**
```ts
type AgentSpec = {
  name: string;
  purpose_summary: string;              // 1-2 frases plain PT-BR
  audience: "lead";                     // custom é sempre lead-facing
  channels: ("whatsapp" | "instagram")[];
  modules: string[];                    // keys do catálogo (whitelist)
  behavior: {
    tone: { creativity: number; formality: number; naturalness: number; assertiveness: number }; // 0-100, clamp
    custom_instructions: string;        // limite de tamanho
    confirmation_mode: "always" | "medium_and_high" | "never";
    model: "sonnet" | "haiku" | "gpt";
  };
  qualification_fields?: { label: string; key: string; type: "text"|"select"|"number"|"bool"; required: boolean; options?: string[] }[];
  scheduling?: { default_duration_min: number; reminders: string[] };
  active_hours?: { tz: string; start: string; end: string; days: number[] };
  followup?: { steps: { delay: string; message: string }[] };
  compliance?: { daily_cap: number; optout_words: string[]; lgpd_notice: string };
  expires_at?: string | null;           // agente temporário (feirão/evento)
};
```
- O spec **mapeia 1:1** pra `agent_configs` (behavior/tones/instructions/model/confirmation/data_fields/scheduling/hours/followup/compliance), `agent_module_instances` (modules) e `agents.expires_at`.
- `POST /api/agent-platform/builder/commit` — valida o spec, **cria o agente PAUSADO** + config + módulos, retorna `agent_id`. Gate de entitlement (`custom_agent`) + bypass admin. Entrada já é gated (tile bloqueado se não liberado).
- **Guard-rails**: system prompt prende a IA ao escopo (só montar agente; recusa off-topic), **cap de turnos**, sanitização do `custom_instructions`, clamp dos tons, whitelist de `modules`/`channels`. Naming: a IA **nunca escreve "GHL"** — só "Spark Leads".

**Pós-confirmar →** animação de montagem (§4.4) → **handoff** pra `/hub/agents/[id]` (config **pré-preenchida pelo spec**) com **"Testar agora"** em destaque. **Pausado** até Ativar.

### 4.4 Animação de montagem ("animações de criação")
Sequência curta e satisfatória (~1.5-2.5s), CSS/Motion, com `prefers-reduced-motion` respeitado:
1. A **marca do agente** (AMark) se forma (scale+fade).
2. Os **módulos escolhidos "encaixam"** num stack, um a um (staggered ~80ms), mostrando o **nome amigável** ("Como o agente fala", "Agendamento de reuniões"…).
3. **Barras de tom** preenchem; **canais** acendem (WhatsApp/Instagram).
4. Check final + "Pronto. Agora é só ajustar e testar." → transição suave pra config.
Versão **leve** pra venda/recrutamento (sem a parte de "compor", só o encaixe dos módulos default).

---

## 5. Telas, uma a uma (com discernimento)

### 5.1 Início (`/hub`)
- Saudação + subtítulo com números do dia. **4 KPIs** (Mensagens hoje, Taxa de resposta, Leads qualificados, Reuniões) — **dados reais** do dashboard (`/api/admin/dashboard` já calcula taxa de resposta/qualificados; mapear). Onde não houver número real ainda, **esconder o card** (não inventar).
- **"Seus agentes"** (4 primeiros, real do catálogo+agents) + **card SparkBot** (escuro) com sugestões → abre o embed do SparkBot (`/embed/sparkbot` já existe) ou "Abrir no WhatsApp".
- **"Atividade recente"** (real de `/api/activity`).

### 5.2 Agentes (`/hub/agents`)
- Filtros (Todos/Ativos/Pausados) + linhas reais. Badge de preço via entitlement (Incluso/$50/Bloqueado). Click → detalhe.

### 5.3 Agente → detalhe + config (`/hub/agents/[id]`)
- Header real (nome editável, status, canais, preço, expiração se temporário) + **Salvar/Pausar-Ativar/Testar**.
- Tabs: **Configurações** (cards expansíveis, §abaixo), **Mensagens** (atividade do agente), **Documentos** (KB), **Histórico**.
- **Configurações (write real):**
  - Cada card = um **módulo** com **toggle** (liga/desliga → `agent_module_instances.enabled`) + corpo de settings.
  - Corpos (do v3, ligados ao back-end): **Como o agente fala** (modelo, 4 sliders de tom, instruções, modo de confirmação), **Horário de atendimento**, **Mensagens automáticas (follow-up)**, **Qualificação de leads** (data_fields), **Agendamento** (calendário/duração/lembretes — reusa scheduling-prefs), **Limites e LGPD**, **Canais**, **Ações no CRM** (tools liga/desliga), **Documentos de apoio** (KB upload/list), **Disparo em massa**.
  - **"+ Adicionar módulo"** → abre catálogo (filtrado por audiência) → insere `agent_module_instances`.
  - Persistência via `PATCH /api/agents/[agentId]/config` (existe) + endpoints de módulo.
  - **Paridade SparkBot**: a MESMA tela serve pro SparkBot (audiência rep) — só muda o conjunto de módulos. Cuidado: mexer na config do SparkBot afeta prod → manter o caminho de save **idêntico** ao atual e validar 1 conversa real antes de soltar (flag).

### 5.4 Mensagens (`/hub/messages`)
- Log real (`/api/activity`) com filtros (agente, tipo, busca, período). Export/atualizar.

### 5.5 Faturamento (`/hub/billing`)
- Próxima cobrança + itens (SparkBot incluso vs agentes pagos $50) — **real** via `/api/billing` + `pricing.ts` (markup 10%, cap $100). Uso do mês (tokens/áudio/imagem) das `usage_records`. Histórico. **Sem ação de pagamento** (fora de escopo de ações financeiras — só exibir).

### 5.6 Conta (`/hub/settings`)
- Agência (nome, escritório, fuso, idioma) + notificações. Liga a `/api/settings` + scheduling-prefs.

### 5.7 Acessos (`/hub/access`) — admin
- Substitui o `scripts/grant-entitlement.ts`. KPIs + busca + tabela (escritório × Vendas/Recrutamento/Custom, status, preço, liberado em, expiração).
- **Modal "Liberar acesso"**: escolhe escritório (location) + capacidade + preço (default $50, editável) + expiração opcional → `grantEntitlement`.
- Linha: **Revogar** (`revokeEntitlement`), **Editar** preço/expiração.
- Endpoints novos: `GET/POST /api/agent-platform/entitlements`, `PATCH/DELETE /api/agent-platform/entitlements/[id]`. Admin-only (checa `session.isAdmin`).
- **Importante (regra de segurança):** liberar/revogar entitlement **muda quem pode usar agente pago** — é mudança de acesso. Mantenho **admin-only no servidor** (não confiar no client), e a ação fica **explícita** (modal com confirmação), nunca automática.

### 5.8 Login (`/hub` deslogado)
- Card "Entrar com Spark Leads" (SSO/OAuth — fluxo de **login em conta existente**, com permissão do usuário) + email. **Nunca** criar conta nem digitar senha pelo usuário.

---

## 6. Back-end / contratos

### 6.1 Ajustes em endpoints existentes
- `POST /api/agent-platform/agents`: hoje cria `status:"active"`. **Mudar pra `paused`** quando vier do fluxo de criação manual (campo `start_paused:true` no body, default true). Relaxar o `UNIQUE(location_id, type)` p/ **múltiplos custom** por location (migration aditiva) — hoje trava o 2º custom.
- `GET /api/agent-platform/catalog`: já entrega templates+módulos+entitlements+isAdmin+capabilityByTemplate. **Suficiente**; talvez adicionar `channelsConnected` (quais canais a location tem) pro passo de canais.
- `PATCH /api/agents/[agentId]/config`: confirmar que cobre todos os campos do spec (tones, instructions, model, confirmation_mode, data_fields, scheduling, hours, followup, compliance). Estender onde faltar.

### 6.2 Endpoints novos
- `POST /api/agent-platform/builder/message` — turno da IA (Claude tool-use → spec parcial/final). Stream se der.
- `POST /api/agent-platform/builder/commit` — spec validado → cria agente paused + config + módulos.
- `GET/POST /api/agent-platform/entitlements` + `PATCH/DELETE /.../[id]` — admin.
- (Opcional) `GET /api/agent-platform/agents` — lista p/ a tela Agentes (ou reusar a existente).

### 6.3 Repositório
`agent-platform.repo.ts` já tem `listTemplates/listModules/listEntitlements/getActiveEntitlement/grantEntitlement/revokeEntitlement/getTemplate/getAgentModuleInstances`. Falta talvez `updateEntitlement` (preço/expiração) e `setModuleInstanceEnabled` / `addModuleInstance` / `removeModuleInstance`.

---

## 7. Faseamento (ordenado, cada fase shippável atrás de flag)

| Fase | Entrega | Critério de saída |
|------|---------|-------------------|
| **A — Fundo & shell** | Tokens v3 reconciliados (reverter lima/Bricolage→azul/Geist); shell `/hub` (Sidebar+TopBar), SSO, TenantProvider(+isAdmin), embed-friendly (CSP/iframe/cookies), tweaks tema/densidade. Componentes base do design system. | `/hub` renderiza embedado no Spark Leads via SSO, nav funciona, **zero impacto no `/dashboard`**. |
| **B — Telas read** | Início, Agentes, Agente-detalhe (read), Mensagens — ligadas a dados reais. | Uma conta real (Alves Cury/interna) vê seus agentes + atividade reais no `/hub`. |
| **C — Config modular (write)** | Cards expansíveis ligados ao save real (toggle módulo + settings), "+ Adicionar módulo", Salvar/Pausar/Ativar. | Editar um módulo persiste e reflete no agente; **SparkBot validado em 1 conversa real** (flag-safe). |
| **D — TestChat real** | Painel de teste ligado aos endpoints de modo-teste. | Testar um lead agent inline sem escrever no CRM. |
| **E — Criação venda/recrut + animação** | Tiles de tipo → nome/canais → cria paused → animação → config. | Criar um agente de venda ponta a ponta, cai pausado na config. |
| **F — ★ Criação Custom (builder IA)** | Builder (conversa + ficha ao vivo), endpoints message/commit, spec validado, animação de montagem, handoff config+teste. | Descrever um custom em PT-BR → IA monta → cai na config pré-preenchida → testa → ativa. |
| **G — Acessos (entitlements UI)** | Tabela + Liberar/Revogar/Editar (admin), endpoints, repo. | Liberar/revogar pela UI muda o gate; substitui o script. |
| **H — Faturamento + Conta** | Billing real (pricing/uso) + Conta (settings/prefs). | Números reais; sem ação financeira. |
| **I — Cutover** | Apontar custom link → `/hub`; `redirect /dashboard → /hub`; aposentar shell antigo + wizard rejeitado. | `/hub` é a UI de produção; UI antiga removida. |

**Ordem de valor:** A→B→C→D dá uma UI nova **navegável e funcional** sobre os agentes que já existem. E→F entrega a criação (o que estava "não legal"). G→H completam admin/billing. I encerra o paralelo.

---

## 8. Riscos & mitigações

| Risco | Prob | Impacto | Mitigação | Resp |
|-------|------|---------|-----------|------|
| iframe em branco no GHL (CSP/X-Frame/cookies) | M | Alto | Configurar `frame-ancestors` + cookie `SameSite=None;Secure`; testar embed cedo (Fase A). | 🤝 Claude prepara, Pedro testa no GHL |
| Mexer na config do SparkBot quebra prod | M | Alto | Caminho de save idêntico ao atual; flag; validar 1 conversa real antes de soltar. | 🤝 |
| IA do builder "alucina" spec inválido | M | Médio | Validação zod server-side, clamp/whitelist, cap de turnos, agente nasce **pausado** (humano revisa). | 🤖 |
| Custo de token do builder | B | Médio | Sonnet + cap de turnos; só no Custom (não em todo agente). | 🤖 |
| `UNIQUE(location_id,type)` trava 2º custom | A | Médio | Migration aditiva relaxando p/ custom. | 🤖 |
| Naming "GHL" vazar em UI/IA | M | Médio (regra do Pedro) | Lint/review de strings; system prompt do builder proíbe; usar só "Spark Leads". | 🤖 |
| Divergência visual com o GHL real | M | Baixo | Pegar 1 screenshot do GHL aberto pra calibrar paddings/tons. | 👤 Pedro manda screenshot |

---

## 9. Fora de escopo (V2 backlog)
- Self-serve billing (comprar agente sem admin) — Fase 4 da plataforma.
- IA-builder pra venda/recrutamento (hoje: só custom).
- Troca real de multi-conta no switcher.
- ⌘K command palette e central de notificações reais.
- Provisionamento self-serve de canal/sub-account (hoje manual pela agência).
- Multicanal além de WhatsApp/Instagram.

---

## 10. Perguntas remanescentes (não bloqueiam começar a Fase A)
1. **Screenshot do GHL aberto** (qualquer tela) pra calibrar paddings/sombras/tom exatos do embed — opcional, melhora fidelidade.
2. **Múltiplos custom por location**: pode existir mais de um agente custom por escritório? (assumo **sim** → relaxar o UNIQUE). Confirmar.
3. **"Abrir no WhatsApp"** no card do SparkBot: abre o embed web do SparkBot (`/embed/sparkbot`) ou um deep-link `wa.me`? (assumo embed web + opção wa.me).
4. **KPIs do Início**: confirmar quais já têm número real hoje (Mensagens, Taxa de resposta, Qualificados, Reuniões) pra não mostrar card vazio.

---

## 11. Próximo passo
Aguardo teu "go" pra começar pela **Fase A** (fundo + shell embedável). Posso já emendar A→B→C numa sessão longa (UI navegável sobre agentes reais) e parar pra você validar o embed no Spark Leads antes de seguir pra criação (E/F). Se quiser ajustar qualquer decisão da Seção 0 ou a ordem das fases, é só falar.
