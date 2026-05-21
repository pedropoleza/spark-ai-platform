# SparkBot — Antispam de Proativos + Signals (plano de implementação)
### FORGE-3 · 2026-05-21

> Convenção: 🤖 Claude · 👤 Pedro · 🤝 Híbrido. Saiu da investigação do contato
> Wagner Witka (407-457-7537) + varredura do admin_signals.

---

## 1. Contexto / diagnóstico

**Antispam quebrado (confirmado):** Wagner tomou **11 proativos** desde o último
inbound (05-11) sem nenhum warning nem pausa. Raiz no `dispatcher.ts` (path
`proactive_rule`): a silence-gate é carregada (`loadSilenceDecision`, l.271) mas
o `recordProactiveSent` SÓ é chamado no branch de **skip** (l.279). No caminho
que ENVIA (`canSend=true`, l.510) o counter **nunca incrementa** (fica 0 eterno)
e o `warningPrefix` **nunca é prependado**. → nunca chega no warn (2/3) nem na
pausa (≥4). Risco: irritação + **ban do número no WhatsApp**.

**Scope-manager grita falso (confirmado):** `flagScopeIssue` emite signal HIGH
"Location precisa reconectar" em QUALQUER 403 isolado. O caso `b1ttBRVEnm5joFvP2UXO`
foi UM 403 em `remove_tag` (n=1) — a location estava 100% funcional (criou/atualizou
tasks minutos depois). Alarme falso. (Bonus: o `missing_scopes` não acumula — o
upsert sobrescreve com `[action]`.)

**Signals — padrões recorrentes:** `create_contact: já existe` ~18× (bot cria em
vez de buscar antes); `analyze_tabular_data: sem planilha` n=5 (chama a tool sem
anexo). Resto (coherence/hallucination) majoritariamente já `done`.

---

## 2. Plano (etapas)

### Etapa 1 — Antispam: incrementar + avisar (🤖) [P0]
`dispatcher.ts`, branch `mode==='real'` que envia:
- Prepend `silenceDecision.warningPrefix` no texto do proativo (o "⚠️ Tô percebendo…"
  / "⚠️ Último aviso…").
- Após `deliverProactiveMessage`, se entregou via **whatsapp**, chamar
  `recordProactiveSent(supabase, rep.id, silenceDecision)` (incrementa counter +
  marca warned). Só conta envio que de fato chegou no WhatsApp (web fallback não conta).
- **Saída:** counter sobe a cada proativo não-respondido; warn em 2/3; pausa em ≥4.

### Etapa 2 — Scope-manager: só escalar com PADRÃO (🤖) [P1]
`scope-manager.ts` `flagScopeIssue`:
- Acumular `missing_scopes` de verdade (union do array existente, não sobrescrever).
- Pra `scope_or_location`: só emitir o signal HIGH "precisa reconectar" quando a
  location tem **≥3 ações distintas** com 403 (padrão = desconexão real). 403
  isolado → signal **medium** "403 pontual em <action> — investigar se recorre".
- `unsupported_endpoint` (IAM) mantém como está (é definitivo).
- **Saída:** 403 solto não vira mais "reconnect"; desconexão real (vários tools) sim.

### Etapa 3 — Reforços de prompt (🤖) [P1]
`prompt-builder.ts` (seção CONFIABILIDADE):
- `create_contact`: SEMPRE `search_contacts` (nome/telefone/email) antes de criar;
  se achar, `update_contact`/`add_tag` em vez de criar (mata o erro "já existe").
- `analyze_tabular_data`: só chamar quando há planilha/CSV anexada NESTA mensagem;
  sem anexo → pedir o arquivo, não chamar a tool.

### Etapa 4 — Backfill dos super-spammados (🤝 via MCP) [P0]
- Pausar (`proactive_paused_at = now`) os reps que levaram ≥4 proativos desde o
  último inbound (incl. Wagner) — para o spam JÁ, sem esperar o ciclo. Reset
  automático em qualquer inbound (já implementado).

### Etapa 5 — Teste + build + deploy
- 🤖 `tsc` 0, suites verdes, `next build`. Commit + push (são fixes/bugs de prod,
  o antispam é urgente — ban risk).

## 3. Dúvidas pro Pedro (responder no fim)
- **daily_proactive_limit**: default 0 (off). Quer um teto secundário (ex: 4-5/dia
  por rep) além do gate? (Não mexi sem teu ok — afeta cadência de todos.)
- **post_meeting over-fire**: o Wagner levou 4 "Como foi a reunião?" só dia 20 — a
  regra parece disparar demais (1 reunião → N nudges?). Investigar o cooldown/claim
  num próximo round?

## 4. Rollback / segurança
- Antispam: reverter o commit (sem schema). O backfill (pausar) é reversível (inbound limpa).
- Scope-manager: reverter o commit. Nenhuma operação de cliente é afetada (só muda
  quando/qual signal de diagnóstico é gerado).
- Prompt: reverter o commit.
