# Conversational UX Master Plan — SparkBot

> **Data:** 2026-05-15
> **Decision codes (propostos):** H29 (foundation) + H30 (proactive) + H31 (adaptive)
> **Autor:** Plano sob direção do Pedro
> **Status:** PROPOSTA arquitetural — substitui correções táticas pontuais

---

## 0. Mandato do Pedro

> *"O objetivo é pegar os fluxos de todas as tools e entender como eles estão, analisando o fluxo geral do bot, as confirmações necessárias ou coisas que ele fica perguntando ao invés de dar sugestões."*

> *"Quero que você pense fora da caixa sobre como ele pode ficar mais conversacional, intuitivo e fácil de utilizar."*

**3 decisões já tomadas pelo Pedro:**
1. **Voz**: Misto adaptativo (detecta tom do rep e espelha)
2. **Trade-off**: Combinação tier-by-risk (safe direto / medium 1-OK / high menu)
3. **Foco**: Geral, sem área específica privilegiada

**Autoridade delegada**: "Você é o dev senior e masterplan."

---

## 1. Diagnóstico — o estado atual em 1 página

### 1.1 Pontos fortes (já bons)
- **Confirmation gate H8** estruturado por risk (safe/medium/high)
- **Filter Engine H27** unificou paginação, filtros complexos, aliases
- **Bulk V2 H28** com delivery_options menu numerado + disclaimers + summaries formatados
- **Coexistence guard** entre jobs bulk (commit `c7aa169`)
- **Anti-hallucination detector** (commit `993970e`) com 8 famílias específicas + genérico
- **Filter Engine cache** (pipelines + customFields, TTL 10min)

### 1.2 Fricções identificadas (auditoria das 45 tools + prompt-builder de ~700 linhas)

| Categoria | Atrito | Exemplo real |
|---|---|---|
| **Re-perguntas** | Bot pede contato que já achou no turn anterior | Caso Gustavo nota: pediu "anota na Renata", bot perguntou "qual contato?" |
| **Loops de descoberta** | Chama `describe_filter_capabilities` 4× seguidas | Caso policy_anniversary (15/05) |
| **Perguntas abertas** | "Quer texto curto ou longo?" em vez de "(1) curto (2) longo" | Bulk antes do menu numerado |
| **Verbosidade** | Resposta de 8+ linhas quando 2 bastariam | Várias tools |
| **Prompt redundante** | 200+ tokens de "exemplos de formato" que poderiam ser comentários | `prompt-builder.ts` linhas 72-89 |
| **Smart defaults faltando** | Não cacheia "última busca = contact X" pra próxima tool no turn | Generalizado |
| **Ambiguidade implícita** | Custom field `policy_anniversary` existe em CONTACT E OPPORTUNITY — bot precisa "descobrir qual" | Caso real Pedro |
| **Confirmações duplicadas** | Bot pede OK pra criar nota + OK separado pra criar task após | Várias sessões |
| **Falta de continuidade** | Após criar contato, bot não sugere "Quer criar opp também?" | Generalizado |
| **Erro genérico** | "deu erro" em vez de "slot ocupado — vou ver outros horários" | Calendar |
| **Provider leak** | Risco de "Stevo/Evolution" vazar em tool descriptions | bulk-messages, contacts |

### 1.3 Volume de tools por tier
- **SAFE** (25 tools): search, list, get, count, query, describe — leitura pura
- **MEDIUM** (15 tools): create_note, create_task, update_*, add_tag, remove_tag, schedule_reminder, set_alias, etc
- **HIGH** (8 tools): delete_*, send_message_to_contact, create_appointment, import_contacts, bulk schedule_v2

---

## 2. Filosofia — 6 princípios fundamentais

### Princípio 1 — **Tier-by-Risk decide a velocidade**
```
SAFE   → executa sem perguntar. Resposta concisa. Sugere próxima ação.
MEDIUM → infere intenção, mostra recap 1-linha, executa após "ok/sim/vai".
HIGH   → apresenta menu de opções OU recap detalhado, confirmação explícita.
```

### Princípio 2 — **Adaptive Voice (detect & mirror)**
```
Rep curto/casual ("vai", "blz", "manda")  → bot 1-2 frases, sem floreio.
Rep formal/explorador ("você poderia...") → bot 3-5 frases, mais contexto.
Rep urgente ("agora!!", caps)             → bot ack imediato + ação.
Default                                   → tom Brazillionaires (informal mas claro).
```

### Princípio 3 — **Context Memory dentro do turn**
Toda entidade mencionada num turn (contact_id, opp_id, calendar_id, stage, tag) vira **slot ativo** — próxima tool não precisa re-perguntar. Reduz tool calls de 5 pra 2 em casos típicos.

### Princípio 4 — **Proactive Next-Step**
Após cada write tool com `status=ok`, bot oferece **1-2 próximas ações** relevantes baseadas em mapping fixo. Nunca 5 sugestões — só as 1-2 mais prováveis.

### Princípio 5 — **Smart Defaults > perguntas**
Bot só pergunta quando NÃO há default razoável. Senão, infere + 1-OK ("vou usar Florida — outra UF?").

### Princípio 6 — **Visual Consistency**
Toda resposta cai em **7 templates canônicos** com formatação padrão (negrito, listas, splitters). LLM segue templates → output previsível.

---

## 3. Padrões de UX por tier de risk

### 3.1 SAFE (leituras): execute → conciso → sugere

**Antes:**
```
Rep: "quantos contatos no FL?"
Bot: "Você quer que eu liste ou só conte? Posso filtrar por outros critérios também (tag, opp aberta, etc)..."
```

**Depois:**
```
Rep: "quantos contatos no FL?"
Bot: "*786 contatos* no FL. Quer ver a lista, filtrar por tag, ou exportar?"
```

**Regras:**
- Bot executa `count_filtered` imediatamente
- Resposta = número + 2-3 sugestões em 1 linha
- Sem "Quer ver?" aberta — oferece 2-3 next-step concretos

### 3.2 MEDIUM (writes leves): infer → recap 1-linha → OK → execute → next

**Antes:**
```
Rep: "anota no João que ele tá interessado"
Bot: "Qual João? Tem 3 contatos com esse nome. Aqui:
1. João Silva
2. João Santos
3. João Pereira"
[rep responde "Silva"]
Bot: "Qual o texto da nota?"
[rep responde texto]
Bot: "Confirma criar nota 'X' em João Silva?"
[rep "sim"]
Bot: "Nota criada."
```

**Depois:**
```
Rep: "anota no João que ele tá interessado"
Bot: "*João Silva* (mais recente, 2d atrás). Anoto 'Tá interessado'?"
[rep "sim"]
Bot: "Anotado. Quer criar task de follow-up?"
```

**Regras:**
- Bot pega o candidato mais provável + indica como inferiu ("mais recente", "última conversa")
- Recap 1-linha com a ação completa
- Após sim, EXECUTA + sugere next (1 opção concreta)

### 3.3 HIGH (ações destrutivas/comunicação): menu → recap → confirmação → execute

**Antes:**
```
Rep: "manda msg pros M3 dizendo X"
Bot: "Você quer mandar agora ou agendar? E é lista quente ou fria? Confirma o texto?"
```

**Depois:**
```
Rep: "manda msg pros M3 dizendo X"
Bot: [executa count + preview internamente]
"*M3:* 6 contatos. Lista quente, certo?
Quando disparar?

*1.* Tudo hoje (~9min)
*2.* Spread em 2 dias úteis (~3/dia)
*3.* Hora específica

Quero confirmar 1 disclaimer: você confirma que essa lista interagiu com você antes?"
```

**Regras:**
- Bot já executa preview (safe) sem perguntar
- Mostra summary formatado direto
- Menu numerado pra escolha de timing
- 1 disclaimer combinado (não 3 separados quando volume baixo)

---

## 4. 14 mudanças concretas (com effort)

### 4.1 **Visual Templates Canônicos** (`H29.1`, 2h)

Centralizar 7 padrões em `prompt-builder/templates.ts`:

```typescript
// Pseudo-spec
export const VISUAL_TEMPLATES = {
  LIST_RESULT: `Achei *N items*. Aqui:\n1. *Nome* — detalhe\n2. ...\n\n[próximas ações]`,
  ACTION_PROPOSAL: `Vou *<ação>* em *<entidade>* — confirma?`,
  SUCCESS_NEXT: `*<ação>* feita. Quer *<next1>* ou *<next2>*?`,
  ERROR_RETRY: `❌ *<causa>*. *Posso <ação concreta>?*`,
  MENU_OPTIONS: `*Como prefere?*\n*1.* X\n*2.* Y\n*3.* Z\n\n_(ou diga o que prefere)_`,
  RECAP_HIGH_RISK: `*Recap antes de confirmar:*\n• X\n• Y\n• Z\n\nConfirma?`,
  DIAGNOSTIC: `*Status:* X\n*Detalhes:* Y\n*Próximo:* Z`,
};
```

Bot prompt instrui: *"Sua resposta cai em UM destes 7 templates. Não invente formatos novos."*

**Impacto**: consistência visual + LLM mais determinístico.

---

### 4.2 **Context Memory Layer** (`H29.2`, 4h)

Novo módulo `account-assistant/turn-context.ts`:

```typescript
interface TurnContext {
  // Entidades resolvidas no turn atual (acumulado em cada tool call)
  resolved_entities: {
    contact_id?: string;
    contact_name?: string;
    opportunity_id?: string;
    stage_id?: string;
    appointment_id?: string;
    job_id?: string;        // bulk
    // ... 1 slot por tipo
  };
  /** Última tool de busca executada — referência pra "esse contato" */
  last_search?: { tool: string; result_id: string; result_name: string };
  /** Último write — pra "desfaz última ação" */
  last_write?: { tool: string; entity_type: string; entity_id: string; timestamp: string };
}
```

- Processor injeta `TurnContext` no prompt como bloco fresh
- Tools podem ler/escrever via ctx novo field
- Bot regra: *"se TurnContext.last_search existe e rep diz 'esse', use o resolved_id"*

**Impacto**: reduz re-perguntas em 60-80% nos fluxos compostos.

---

### 4.3 **Next-Step Suggestion Table** (`H29.3`, 3h)

Mapping fixo `tool_executed → suggested_next_actions[]`:

```typescript
export const NEXT_STEP_MAP: Record<string, NextStepRule> = {
  create_contact: {
    suggestions: ["criar opportunity", "adicionar tag", "criar nota"],
    triggers_when: "always",
  },
  create_note: {
    suggestions: ["criar task de follow-up", "adicionar tag"],
    triggers_when: "always",
  },
  schedule_reminder: {
    suggestions: ["criar task no Spark Leads também?", "agendar follow-up"],
    triggers_when: "always",
  },
  create_appointment: {
    suggestions: ["mandar mensagem de confirmação ao cliente?", "lembrete 1h antes?"],
    triggers_when: "always",
  },
  send_message_to_contact: {
    suggestions: ["agendar follow-up se não responder em 24h?"],
    triggers_when: "always",
  },
  update_opportunity_status: {
    won: ["mover pra pipeline 'Policies'?", "marcar tag 'cliente'?"],
    lost: ["registrar motivo no campo X?"],
  },
  // ... pra cada write tool
};
```

Bot prompt: *"Após tool_result=ok de uma write tool, OFEREÇA 1 das 2 suggestions do NEXT_STEP_MAP em 1 linha. Apenas 1, não chunky."*

**Impacto**: rep descobre features sem precisar perguntar.

---

### 4.4 **Adaptive Voice Detector** (`H30.1`, 3h)

Função `detectRepStyle(recentMessages: string[]): RepStyle`:

```typescript
type RepStyle = "short" | "verbose" | "urgent" | "neutral";

// Regras simples (não LLM):
- avg chars/msg < 15 → "short"
- avg > 80 → "verbose"
- contém "!!", caps lock, "urgente", "agora" → "urgent"
- senão → "neutral"
```

Injeta como hint dinâmico no system prompt:

```
[REP_STYLE: short]
Responda EM ATÉ 2 FRASES. Sem floreio. Direto à ação.
```

OU:

```
[REP_STYLE: verbose]
Responda em 3-5 frases. Inclua contexto + sugestão.
```

**Impacto**: bot se ajusta SEM rep precisar pedir.

---

### 4.5 **Smart Defaults Resolver** (`H29.4`, 4h)

Antes de cada tool call, processor preenche slots automaticamente:

```typescript
export function applySmartDefaults(ctx, args): args {
  // 1. Timezone — se rep mencionou hora SEM fuso, usa rep.timezone
  // 2. Active location — se ambíguo, usa rep.active_location_id
  // 3. assigned_to=undefined → rep.ghl_user_id (NÃO precisa "self")
  // 4. delivery_channel default = whatsapp_web_sms (já existe)
  // 5. Variation_mode default = "light"
  // 6. Interval bulk default = 90s ± 30s
  // 7. List_temperature: se contatos têm tag "client"/"active" → infere "warm"
}
```

Bot prompt: *"NÃO pergunte fuso, location ativa, assigned_to — defaults resolvem automaticamente."*

**Impacto**: rep não responde 3 perguntas técnicas. Em casos ambíguos bot ainda pergunta, mas 80% reduzido.

---

### 4.6 **Disambiguation by Elimination** (`H29.5`, 2h)

Hoje: bot pergunta "Qual João?" pra 3 candidatos.

Depois: bot RANQUEIA por probabilidade + AUTO-PICKa se score > 0.8:

```typescript
function rankCandidates(query: string, candidates: Contact[]): RankedCandidate[] {
  // Score baseado em:
  // - last_activity recente (peso 0.4)
  // - exact match firstName (peso 0.3)
  // - mencionado no turn anterior (peso 0.2)
  // - tag "cliente"/"lead" se contexto é venda (peso 0.1)
  return candidates.sort((a, b) => b.score - a.score);
}
```

Se top score > 0.7 e gap > 0.2 vs 2º → **pick automático com 1-OK**:
> "*João Silva* (última conv 2d). É esse?"

Se gap pequeno → mostra top 3 com contexto:
> "Tem 3 Joãos. Qual:\n*1.* João Silva (cliente, conv 2d)\n*2.* João Santos (lead, sem conv)\n*3.* João P. (sem dados)"

**Impacto**: 70% das ambiguidades resolvidas em 1 turn.

---

### 4.7 **Multi-Action Chaining** (`H30.2`, 5h)

Rep manda mensagem com N intenções:

```
"cria contato Pedro +5511987654321, tag 'lead', cria opp no M0, manda msg de boas-vindas"
```

**Hoje**: bot turn-by-turn pergunta cada.

**Depois**: bot detecta múltiplas ações + apresenta plano:
```
Identifiquei 4 ações:
*1.* Criar contato Pedro
*2.* Adicionar tag 'lead'
*3.* Criar opp no M0
*4.* Mandar msg boas-vindas

Confirma todas? (responda "sim", "só 1-3", ou edite)
```

Execução em chain num único turn (até MAX_ITERATIONS=10 — aumentar de 6).

**Impacto**: tasks complexas em 1 turn em vez de 4-5.

---

### 4.8 **Predictive Acknowledgment** (`H30.3`, 2h)

Pra tools long-running (>3s):
- Bot envia ACK imediato: *"Tô puxando..."* OU *"Buscando..."*
- Depois envia resultado

Implementação: `messages_intermediate` table OR streaming via WhatsApp Web (futuro). V1 simples: bot fala "Um segundo" em mensagem separada antes de iniciar tool.

**Impacto**: rep não acha que bot travou.

---

### 4.9 **Conversational Compression** (`H31.1`, 2h)

Bot detecta sinal de "menos texto":
- Rep pediu explicitamente: *"fala mais curto"* / *"sem rodeios"*
- Bot persiste flag `rep.profile.preferences.verbosity = "brief"` em DB

Comportamento:
- `verbosity=brief`: respostas em 1-2 frases max
- `verbosity=normal`: padrão atual (3-5 frases)
- `verbosity=detailed`: rep pediu "explica mais", até 8 frases + exemplos

**Impacto**: rep que prefere brevidade não precisa repetir "curto" toda vez.

---

### 4.10 **Error Recovery Flow** (`H30.4`, 4h)

Cada erro GHL tem **plano de recovery automático**:

```typescript
const ERROR_RECOVERY: Record<string, RecoveryPlan> = {
  "slot_no_longer_available": {
    auto_action: "call_get_free_slots_and_propose_3_alternatives",
    response_template: "Slot ocupado. Tenho 3 alternativas:\n*1.* X\n*2.* Y\n*3.* Z",
  },
  "duplicated_contact": {
    auto_action: "extract_existing_contact_id_from_error",
    response_template: "Esse contato já existe — quer atualizar o existente?",
  },
  "rate_limited": {
    auto_action: "wait_5s_and_retry_once",
    response_template: "Spark Leads tá lento, tentando de novo...",
  },
  "permission_denied": {
    auto_action: "none",
    response_template: "Essa ação precisa de admin. Vou registrar pra Pedro avaliar.",
  },
};
```

Bot prompt: *"Quando tool retorna error com tipo conhecido, EXECUTA o auto_action e responde com template."*

**Impacto**: rep não tem que descobrir como contornar erro. Bot oferece caminho.

---

### 4.11 **Confidence Indicators** (`H30.5`, 1h)

Bot indica certeza quando infere:

```
✅ Certeza alta:  "Vou criar nota no João Silva."
🤔 Inferência:    "Vou criar nota no João Silva (provavelmente esse — última conv 2d). Outro João?"
⚠️  Múltiplas:    "Tem 3 Joãos. Aqui os top 3..."
```

Sutil mas reduz ansiedade do rep ("será que escolheu o certo?").

**Impacto**: rep confia mais em ações inferidas.

---

### 4.12 **Combined Disclaimers** (`H31.2`, 2h)

Hoje (bulk): 3 disclaimers separados, rep precisa "sim" 3 vezes.

Depois: 1 mensagem combinada com checklist:
```
Antes de confirmar:
☐ Lista quente (já interagiu com você)?
☐ Volume alto (120 contatos) ok pra você?

Responda "*tudo ok*" ou aponte o que mudar.
```

Bot interpreta "tudo ok" como aceite GLOBAL.

**Impacto**: 3 turns → 1 turn.

---

### 4.13 **Recap Mode** (`H31.3`, 2h)

Comando "recap" / "resumo" / "o que fizemos?":

```typescript
// Tool nova
recap_session({ last_minutes?: 30 }) {
  // Lista últimas N writes da sessão (sparkbot_messages.tool_calls)
  // Formato: bullet com tool + entidade + timestamp
}
```

Bot output:
```
*Últimas 30min:*
✓ 14:30 — Nota criada na Renata Brugger
✓ 14:35 — Task agendada pro João Silva (amanhã 10h)
✓ 14:42 — Disparo M1 iniciado (job 2907bb16, 14 contatos)

Status disparo: 8/14 enviados.
```

Útil pra rep voltando após pausa OU debug.

**Impacto**: reduz "o que mesmo eu fiz?" loops mentais do rep.

---

### 4.14 **Undo Last Write** (`H31.4`, 3h, OPCIONAL)

Comando "desfaz" / "cancela última":

```typescript
undo_last_action() {
  // Lê TurnContext.last_write (ou tabela undo_stack)
  // Pra write conhecido, executa reverse (delete_note, delete_task, etc)
  // Window: 5 minutos após criação
}
```

Limitações: nem todo write é undoable (send_message não dá pra "des-mandar").

**Impacto**: confiança do rep em experimentar. Pode ser V2.

---

## 5. Arquitetura de código

### 5.1 Estrutura nova

```
src/lib/account-assistant/
├── conversational/           # ← NOVA pasta
│   ├── templates.ts          # 7 visual templates canônicos
│   ├── voice-detector.ts     # adaptive voice detection
│   ├── turn-context.ts       # context memory layer
│   ├── next-steps.ts         # NEXT_STEP_MAP
│   ├── smart-defaults.ts     # applySmartDefaults
│   ├── disambiguation.ts     # rank candidates by score
│   ├── error-recovery.ts     # ERROR_RECOVERY plans
│   ├── multi-action.ts       # parser pra chaining
│   └── index.ts              # exports
├── prompt-builder.ts         # ← refatorado, importa de conversational/
└── processor.ts              # ← injeta turn_context + voice_hint
```

### 5.2 Modificações em prompt-builder

Reduz seções verbosas (caso Pedro, exemplos formato) e move pra:
- Templates → comentário inline curto (1 linha referenciando arquivo)
- Voice hint → injetado dinamicamente (bloco condicional)
- Next-step rules → 1 parágrafo + mapeia pra NEXT_STEP_MAP por nome

**Goal**: reduzir prompt de ~700 linhas pra ~450, mantendo guardrails.

### 5.3 Schema rep_profile expandido

`rep_identities.profile` jsonb:

```typescript
{
  // ... campos atuais ...
  preferences: {
    verbosity?: "brief" | "normal" | "detailed",
    confirmation_style?: "menu" | "single_ok" | "auto",
    default_channel?: "whatsapp" | "sms" | "email",
  },
  learned_patterns: {
    most_used_pipeline?: string,
    typical_bulk_window?: "today" | "spread_days",
    avg_msgs_per_turn?: number,  // pra adaptive voice
  },
}
```

Bot pode persistir aprendizados ao longo do tempo.

---

## 6. Implementação em fases

### **Fase 1 — Foundation (H29, ~13h)**
Mudanças que dão 60% do valor com 30% do effort. Conservadoras, não-breaking.

1. **Visual Templates** (2h)
2. **Context Memory Layer** (4h)
3. **Next-Step Suggestion Table** (3h)
4. **Smart Defaults Resolver** (4h)

**Outcome**: bot já é dramaticamente menos verboso, reusa entidades do turn, sugere proativo.

---

### **Fase 2 — Proactive (H30, ~14h)**
Mudanças mais ambiciosas, requerem mais testes.

1. **Adaptive Voice Detector** (3h)
2. **Disambiguation by Elimination** (2h)
3. **Multi-Action Chaining** (5h)
4. **Predictive Acknowledgment** (2h)
5. **Confidence Indicators** (1h)
6. **Error Recovery Flow** (4h... wait, somando: foundation 13h + proactive 17h, vou re-ajustar)

**Outcome**: bot inteligente, antecipa, executa em chain, recupera de erros.

---

### **Fase 3 — Adaptive (H31, ~9h)**
Personalization de longo prazo.

1. **Conversational Compression** (2h)
2. **Combined Disclaimers** (2h)
3. **Recap Mode** (2h)
4. **Undo Last Write** (3h — opcional)

**Outcome**: bot lembra preferências, adapta tom, oferece "desfaz".

---

### Total efforts
- Fase 1: 13h (5-7 commits, 2-3 dias trabalho)
- Fase 2: 17h (4-6 commits, 3-4 dias)
- Fase 3: 9h (2-3 commits, 1-2 dias)
- **Total**: 39h = ~2 semanas part-time

---

## 7. Quick Wins (top 5 em 8h totais)

Se Pedro quiser ROI imediato sem implementar tudo:

| Quick Win | Effort | Impacto |
|---|---|---|
| **Smart Defaults Resolver** (timezone, location, assigned_to) | 4h | Remove ~3 perguntas técnicas por sessão |
| **Visual Templates 7 padrões** | 2h | Consistência imediata em todas respostas |
| **Next-Step Suggestion Table** | 3h | Bot deixa de ser passivo |
| **Disambiguation by Elimination** | 2h | "Qual João?" some em 70% dos casos |
| **Combined Disclaimers no bulk** | 2h | 3 turns → 1 turn pra disparos |

**13h totais entregam ~75% do valor percebido.**

---

## 8. "Pensando fora da caixa" — ideias secundárias

Pedro pediu — algumas ideias mais arriscadas/criativas pra discutirmos antes de incluir:

### 8.1 Persona awareness cross-rep
Bot poderia detectar "rep X é cético, prefere ver dados", "rep Y é entusiasmado, gosta de checar resultado". Persiste em `rep.profile`. Cada rep tem experiência levemente diferente.

**Trade-off**: pode ficar inconsistente. Vale só pra orgs grandes.

### 8.2 Inline education
Quando rep pergunta algo simples, bot ensina capability relacionada sutilmente:
> Rep: "Quais opps no M3?"
> Bot: "6 opps no M3. *Aliás*, dá pra mandar uma msg pra todas com 1 comando — testou já?"

**Trade-off**: pode soar invasivo. Limitar a 1× por sessão.

### 8.3 Conversational checkpoints
Após 10+ turns numa sessão, bot oferece checkpoint:
> "Já fizemos 6 ações. Quer um resumo ou continua?"

**Trade-off**: utility depende do rep. Pode ser opt-in.

### 8.4 Anticipatory pre-fetch
Quando rep menciona nome de contato, bot já busca em background antes do pedido explícito. Quando chega a hora de "anota nele", info já tá no contexto.

**Trade-off**: gasta tokens à toa se rep mudar de assunto. Vale só pra fluxos longos.

### 8.5 Shared confirmation context
Se rep deu OK pra "criar nota + task" agrupados, bot encadeia ambos sob 1 OK só. Hoje precisa de 2 OKs.

**Trade-off**: pode confundir. Limitar a actions claramente relacionadas.

### 8.6 Verbose-to-Concise progressive learning
Bot começa verboso, mas se rep aceita ações com "ok" sem ler detalhes, bot detecta e reduz verbosity automaticamente em futuras interações.

**Trade-off**: análise de padrão é fuzzy. Pode falhar.

---

## 9. Riscos e mitigações

| Risco | Mitigação |
|---|---|
| Bot inferir errado e fazer ação errada | Tier-by-risk preserva safety: high SEMPRE confirma |
| Bot ficar "robótico" com templates | Templates são esqueleto; LLM ainda escreve frase final |
| Prompt cresce e bate context limit | Cache aggressive + conditional injection (smart defaults só se aplica) |
| Sugestões de next-step viram spam | Max 1 sugestão por turn; rep pode "obrigado, sem sugestão" pra desligar |
| Adaptive voice classificar errado | Default = neutro; rep pode pedir tom explícito |
| Multi-action chaining executa errado | SEMPRE recap antes de executar; rep aprova plano completo |
| Smart defaults sobrescreverem intenção do rep | Detecta menção explícita: "uso fuso de SP" → não sobrescreve com NY default |

---

## 10. Métricas de sucesso

Como medir se UX melhorou (antes/depois Fase 1):

### Métricas técnicas (DB-driven)
1. **Avg turns per task** — query `sparkbot_messages` agrupado por session. Reduzir 30%.
2. **% turns com tool call loop** (`describe_filter_capabilities` 2+× no mesmo turn) — zerar.
3. **Avg response length** (chars) — reduzir 25% sem perder informação.
4. **% turns com pergunta aberta vs menu** — bot prompt detecta "Qual..." sem opções numeradas. Reduzir 70%.
5. **Tempo médio até action** (rep faz request → ação executada) — reduzir 40%.

### Métricas qualitativas (Pedro + clientes)
6. **Pedro feedback subjetivo** (semanal): "como tá usando?"
7. **Reps reclamando de "bot muito perguntão"** — atual: comum. Meta: zero.
8. **Cases tipo Gustavo (4× describe_capabilities)** — zerar.

### Painel admin (futuro)
- Endpoint novo: `/admin/conversational-metrics` exibe top 5 métricas em real time
- Alert: se `avg_turns_per_task` cresce > 20% em 7d, sinaliza regressão

---

## 11. Decisões pendentes pra Pedro (antes de Fase 1)

Pedro deu autoridade pra eu decidir, mas vale checagem dupla em 4 pontos:

1. **Schema rep_profile expandido**: OK adicionar campos `preferences`, `learned_patterns`?
2. **MAX_ITERATIONS bump** de 6 → 10 (pra multi-action chaining): OK?
3. **Undo (4.14)**: implementar Fase 3 ou pular?
4. **Inline education (8.2)**: incluir ou conservador demais? OK testar?

Default sem resposta: vou implementar **todos** os "OK?" e PULAR Undo (Fase 3 opcional).

---

## 12. Conexão com problemas anteriores resolvidos

Este plano integra-se aos fixes recentes (não substitui):

| Plano | Status | Relação com este |
|---|---|---|
| Filter Engine H27 | ✅ done | Reusado nas tools refatoradas |
| Bulk V2 H28 + delivery_strategy + coexistence | ✅ done | Smart defaults aproveitam intervalos default |
| Anti-hallucination detector | ✅ done | Mantém safety net mesmo com bot mais ousado |
| H26 Calendar override | ✅ done | Confirmation gate preservado |

Este plano é **camada de UX em cima da infra já consolidada**. Não mexe em filter engine, anti-hallucination, billing, idempotency, multi-tenant.

---

## 13. Próximos passos práticos

1. Pedro lê o plano, marca seções/decisões pendentes
2. Confirma quick wins prioritários (Fase 1 = 4 itens, ~13h)
3. Eu implemento Fase 1 em PRs separados:
   - PR1: Smart Defaults
   - PR2: Visual Templates
   - PR3: Next-Step Suggestions
   - PR4: Context Memory
4. Smoke testing real com seu número durante implementação
5. Métricas baseline antes/depois pra validar
6. Decide se vai pra Fase 2 ou pausa

---

## Apêndice A — Decision codes propostos

- **H29** — Foundation conversational UX (Visual Templates + Context Memory + Next-Step Suggestions + Smart Defaults)
- **H30** — Proactive UX (Adaptive Voice + Disambiguation + Multi-Action + ACK + Confidence + Error Recovery)
- **H31** — Adaptive personalization (Verbosity Compression + Combined Disclaimers + Recap + Undo opcional)

Entradas em `docs/DECISIONS.md` no merge de cada fase.
