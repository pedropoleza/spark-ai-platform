# F41 — Janela inteligente baseada em volume + preferência do rep

> Pedro 2026-06-02. O F40.B (greeting "Bom dia"/"Boa tarde"/"Boa noite" check) era heurística fraca. O que faz sentido é: bot CALCULA a janela ideal baseado em N contatos + preferência salva, em vez de extender janela artificialmente.

## 1. O que muda

### Remove
- ❌ `detectGreetingMismatch()` em `bulk-messages-v2.ts` (F40.B)
- ❌ Parâmetro `confirmed_greeting_mismatch` da tool

### Mantém
- ✅ Cap hard 21h (F40.A) — "ninguém quer madrugada"
- ✅ Migration F37, banner F39, retry robust F39 — tudo OK

### Adiciona
- ✨ `pickSmartWindow(N, prefs, now)` — função que calcula janela ideal
- ✨ `rep_identities.profile.bulk_pacing` JSONB — preferência salva por rep
- ✨ `delivery_strategy.type = "auto"` — novo modo onde bot delega cálculo

## 2. Algoritmo `pickSmartWindow(N, prefs, channel)`

```
Inputs:
  N                   = total contatos
  prefs.interval_seconds  = 300 (5min) default; override do rep
  prefs.max_window_hours  = 4 default
  prefs.preferred_start_hour = null | 9..21
  channel             = "whatsapp_web_sms" | "whatsapp_api"
  now (timestamp)

Constants:
  FLOOR_INTERVAL      = 60s (1 msg/min — abaixo disso WhatsApp pode flag)
  CEILING_INTERVAL    = 900s (15min)
  BUSINESS_END_HOUR   = 21 (cap F40.A)
  BUSINESS_START_HOUR = 9

Algoritmo:
  1. base_interval = prefs.interval_seconds
  2. base_window_s = N × base_interval
  3. SE base_window_s ≤ prefs.max_window_hours × 3600:
       interval_final = base_interval
       window_s = base_window_s
     SENÃO:
       # Muitos contatos. Tenta reduzir intervalo pra caber.
       max_window_s = prefs.max_window_hours × 3600
       new_interval = floor(max_window_s / N)
       SE new_interval ≥ FLOOR_INTERVAL:
         interval_final = new_interval
         window_s = N × new_interval
       SENÃO:
         # Impossível mesmo reduzindo. Spread_days.
         return { type: "spread_days", days: ceil(base_window_s / max_window_s), ... }

  4. start_at = computeStartAt(prefs, now)
       # Se prefs.preferred_start_hour, pula pra essa hora
       # Senão usa now ou next business window

  5. end_at = start_at + window_s
       SE end_at > today.set_hour(BUSINESS_END_HOUR):
         # Reduz intervalo OU spread_days
         restante = today.set_hour(BUSINESS_END_HOUR) - start_at
         new_interval = floor(restante / N)
         SE new_interval ≥ FLOOR_INTERVAL:
           interval_final = new_interval
           end_at = today.set_hour(BUSINESS_END_HOUR)
         SENÃO:
           return spread_days(...)

  6. return { type: "custom_window", start_at, end_at, interval_seconds: interval_final }
```

### Exemplos concretos

| N | prefs.interval | resultado |
|---|---|---|
| 12 | 5min | 1h janela, 5min entre (caso teu) |
| 30 | 5min | 2.5h janela, 5min entre |
| 50 | 5min | 4.2h > 4h → comprime pra ~4.8min entre, 4h janela |
| 100 | 5min | 8.3h > 4h → comprime pra 2.4min, 4h janela |
| 300 | 5min | 25h > 4h e mesmo comprimindo: 4h/300 = 48s < FLOOR → spread_days(2 dias) |
| 12 | 1min | 12min total — OK, mas mín 60s entre tá no FLOOR |
| 5 | 5min | 25min — janela curta razoável |

## 3. Preferência salva: `rep_identities.profile.bulk_pacing`

Schema:
```json
{
  "interval_seconds": 300,         // default 300 (5min). Range 60-900.
  "max_window_hours": 4,           // default 4. Range 1-8.
  "preferred_start_hour": null,    // null = "agora" / próximo horário comercial. Override: 9-20.
  "last_applied_at": "2026-06-02T...",
  "last_n_contacts": 12            // pra debug
}
```

### Como aprende:
- **Implícita**: toda vez que `schedule_bulk_message_v2` roda com sucesso, persiste o `interval_seconds` realmente usado em `bulk_pacing.interval_seconds`. Assim a próxima campanha já vem com o pacing da última.
- **Reset**: rep pode dizer "usa o padrão" → bot zera prefs.

### Onde NÃO salvar:
- `interval_seconds` fixo por agente (`agent_configs.outreach_config.rate_per_hour` já existe pro outreach automático — esse é diferente, é o disparo manual do SparkBot).

## 4. Mudanças no código

### Arquivo: `src/lib/account-assistant/tools/bulk-delivery-strategy.ts`
- Nova função `pickSmartWindow(N, prefs, now)` — algoritmo acima
- Refator do preview: opção 1 vira "Sugestão inteligente", opções 2/3 são alternativas

### Arquivo: `src/lib/account-assistant/tools/bulk-messages-v2.ts`
- Remove `detectGreetingMismatch` + `confirmed_greeting_mismatch`
- Mantém `clampEndAtTo9PM` (cap 21h)
- Aceita `delivery_strategy.type: "auto"` — chama `pickSmartWindow` e seta strategy efetiva
- Após salvar job com sucesso, persiste `bulk_pacing.interval_seconds = jobInterval` em `rep_identities.profile`

### Arquivo: `src/lib/account-assistant/tools/bulk-messages-v2.ts` (preview)
- `preview_bulk_message_v2` retorna 3 opções inteligentes:
  - **Opção 1 (Sugestão)**: pickSmartWindow com prefs do rep
  - **Opção 2 (Rápido)**: intervalo mínimo razoável (~1-2min)
  - **Opção 3 (Espalhar)**: spread_days(2)

### Sem mudança no schema do DB
- Reutiliza `rep_identities.profile` (JSONB já existente)

## 5. Tests (`scripts/test-f41-smart-window.ts`)

Casos:
- `pickSmartWindow(12, {interval: 300, max: 4h})` → janela 1h, intervalo 5min
- `pickSmartWindow(50, {interval: 300, max: 4h})` → comprime intervalo
- `pickSmartWindow(300, {interval: 300, max: 4h})` → spread_days(2)
- Pref do rep aplicada: `interval: 60` → respeita
- Cap 21h respeitado quando start_at é tarde
- Preferred_start_hour: 14h funciona

## 6. UX no SparkBot — prompt update

Prompt builder ganha contexto novo:
```
Quando rep pedir um disparo bulk:
- NÃO pergunte janela manual. Calcula com pickSmartWindow.
- Preview mostra: "12 contatos × 5min entre = 1h. Hoje 14:00-15:00."
- Se rep ajustar, salva como pref pra próximas campanhas.
- Nunca extenda artificialmente — janela mínima necessária.
```

## 7. Decisões pendentes — preciso confirmar contigo

### D1. Default `interval_seconds`
Tu citou "1x5min" pro caso 12 contatos. Vou usar **300s (5min)** como default.

**Alternativa**: 180s (3min) — mais rápido, ainda parece humano.

→ **Pergunta**: 5min ou 3min como default?

### D2. Default `max_window_hours`
Vou usar **4h** — cabe na manhã (9-13h) ou tarde (14-18h) ou começo da noite (17-21h).

**Alternativas**: 3h (mais agressivo), 6h (manhã inteira).

→ **Pergunta**: 4h tá bom?

### D3. FLOOR_INTERVAL (mínimo entre msgs)
Vou usar **60s (1 msg/min)** — abaixo disso WhatsApp/Stevo pode dar flag spam.

→ **Pergunta**: 60s tá ok? Se quiser ser mais conservador, 90s ou 120s.

### D4. Aprender pref implícito
Toda vez que rep aprova um disparo, salva o `interval` usado como pref. Sem perguntar.

**Alternativa**: bot pergunta no final "Quer salvar 5min como teu padrão pra próximas?"

→ **Pergunta**: implícito (silencioso) ou explícito (bot pergunta)?

### D5. Cap 21h — mantém?
Confirmado contigo na sessão anterior — mantém.

### D6. `preferred_start_hour` — implementa já?
Setar pelo rep via fala ("Sempre que eu mandar, começa às 14h").

**Alternativa**: deixar pra fase 2 — fase 1 só faz cálculo de duração/intervalo.

→ **Pergunta**: implementa start_hour agora ou fica pra depois?

## 8. Etapas (se aprovado)

1. **E1** — Nova fn `pickSmartWindow` em `bulk-delivery-strategy.ts` (~50 linhas) + 20 unit tests
2. **E2** — Remove greeting check + adiciona "auto" type em `bulk-messages-v2.ts schedule`
3. **E3** — Update `preview_bulk_message_v2` pra usar pickSmartWindow nas 3 opções
4. **E4** — Persiste pref em `rep_identities.profile.bulk_pacing` após schedule sucesso
5. **E5** — Update prompt builder do SparkBot (instrução pro LLM usar `type: "auto"`)
6. **E6** — TSC + build + smoke + deploy
7. **E7** — Docs (CLAUDE.md)

ETA total: ~2-3h de codar/testar.
