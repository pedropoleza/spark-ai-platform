# SparkBot — Agendamento V2 (rápido: áudio → 1 confirm → pronto)
### FORGE-3 · 2026-05-22

> 🤖 Claude · 👤 Pedro · 🤝 Híbrido. Saiu da análise da conversa real do agendamento
> com Jonathan Duque (rep 1eeb02cc, 22/05 15:48-15:51) — 7 turnos pra 1 reunião.
> Objetivo do Pedro: "mando áudio 'agenda com X, dia Y, hora Z', aperto Confirmar
> e o bot finaliza, mesmo com override".

---

## 1. Análise do fluxo ATUAL (conversa Jonathan, 22/05) — 7 turnos / ~2.5min
1. 🎤 "Marca terça 6PM com Jonathan Duke, calendário Client Appointment"
2. bot "Confirma marcar?" → **Confirmar** ← confirma a INTENÇÃO cedo demais (antes de resolver contato/slot/user)
3. bot "Achei 4 Jonathan Duque, qual?" → tap ← desambiguação de contato
4. bot "6PM não disponível, livres: 1:30, 3:00…" ← oferece SLOTS em vez de override
5. "Faz o override" → bot "Forçar mesmo assim?" → **Forçar** ← 2 passos pro override
6. bot "Qual membro atribuir?" → **Pedro Poleza** ← pergunta o user em vez de assumir self
7. bot "Marcado ✅"

**Gargalos:** (a) confirma a intenção ANTES de resolver tudo; (b) conflito → despeja slots livres em vez de oferecer override direto; (c) pergunta o assignee em vez de default=self; (d) desambiguação de contato (4 Jonathans) — necessária, mas dá pra mitigar com contexto.

## 2. Visão (Pedro): resolver tudo ANTES → 1 confirm (override-aware) → pronto
Áudio → bot resolve contato + calendário + user(=self) por preferência/contexto → UM `present_options` no fim. Se o horário tá ocupado, o próprio confirm já é "ocupado — Confirmar mesmo assim (override) / Editar".

## 3. Fluxo NOVO
1. Rep: 🎤/texto "agenda com X, dia Y, hora Z [calendário opcional]".
2. Bot resolve em 1 turno (sem confirmar ainda):
   - **Contato**: search_contacts(X). 1 match → usa. Vários → usa o do CONTEXTO recente (acabou de falar do Jonathan 3T) ou empresa dita; só pergunta se REALMENTE ambíguo.
   - **Calendário**: nomeado > preferência salva do rep > único calendário do rep. Só pergunta se >1 e sem pref/nome.
   - **Assignee**: **= SELF** (ghl_user do rep) por padrão. Só outro se o rep disser "atribui pro Fulano".
   - **Slot**: checa disponibilidade (get_free_slots) no dia/hora pedido.
3. UM `present_options` de confirmação:
   - **Livre** → "Marcar com *X*, ter 26/mai 18h, calendário *C*, com você. `[Confirmar ✅]` `[Editar ✏️]`"
   - **Ocupado** → "18h tá ocupado nesse calendário. `[Confirmar mesmo assim ✅]` `[Editar ✏️]`" (override embutido — 1 passo, não 2)
4. **Confirmar** → create_appointment (com override flag se ocupado) → "Marcado! ✅".
   **Editar** → `present_options` "O que mudar? `[Horário]` `[Dia]` `[Pessoa/quem atende]` `[Calendário]`" → ajusta o item → volta pro confirm.

Caminho ideal: **áudio → 1 confirm → pronto** (2 turnos). Com conflito: **áudio → 1 confirm-com-override → pronto** (2 turnos). Contato ambíguo: +1. Editar: +N.

## 4. Implementação (em sua maioria PROMPT + uma preferência nova)
- **Assignee = self** por padrão (usa `getRepGhlUserId`); só pergunta/usa outro se o rep especificar. Mata o passo "qual membro atribuir?".
- **Conflito → confirm override-OU-editar** direto quando o rep deu hora específica (NÃO despejar slots livres). Reusa `buildOverridePayload` (ignore_free_slot_validation) no create_appointment.
- **Resolver-tudo-ANTES-de-confirmar**: 1 só `present_options` no fim (não confirmar a intenção no começo).
- **Preferência de calendário por rep** (NOVO, aditivo): `profile.preferences.scheduling.default_calendar_id` (+ talvez default_duration_min). Resolução: nome dito > pref > único. Set: o bot APRENDE no 1º uso ("uso esse calendário sempre que você marcar?" → salva) — ou via UI/tool depois.
- **Sub-fluxo Editar**: present_options do que mudar → captura o novo valor → re-confirma.
- Tools reusadas: search_contacts, list_calendars, get_free_slots, create_appointment (+override), present_options.

## 5. Pontos que talvez você ignorou (você pediu pra eu sinalizar)
- (a) **Desambiguação de contato NÃO some com preferência** — 4 "Jonathan Duque" ainda precisam de escolha. Mitigo com contexto recente/empresa, mas não elimino 100%. E o nome resolvido SEMPRE aparece no confirm final (pra você pegar se pegou o errado).
- (b) **Override** — ✅ **D1 fechada (Pedro):** rep PODE forçar override na PRÓPRIA agenda (assignee = ele mesmo); na agenda de OUTROS, só admin/internal. → afrouxar `buildOverridePayload` (H26): permitir override quando `assigned_user_id` == ghl_user do rep (ou não setado = self); manter admin-only quando assignee for OUTRO user.
- (c) **Duração** — appointment precisa de duração; hoje usa o default do calendário. Manter default (e ajustável no Editar)?
- (d) **Como setar a preferência de calendário** — aprender no 1º uso (recomendo) vs setting na UI.
- (e) **Agendar pra OUTRO** (não self) — quando o rep marca reunião de outra pessoa, o default-self cede se ele disser "marca pro Gabriel". Coberto, mas vale lembrar.
- (f) **Fuso** — já resolvido (`confirm_rep_timezone`); "6 PM" interpretado no fuso do rep.
- (g) **Conflito real vs preferência de override** — se o rep SEMPRE força, talvez não queira nem ver o aviso. Por ora mantenho 1 confirm (mostra "ocupado" + Confirmar override) — seguro.

## 6. Etapas
### Etapa 0 — Decisões ✅ (fechadas 2026-05-22)
- D1: override liberado na própria agenda (self), admin-only pra outros. D2: preferência de calendário = aprende no 1º uso + setting na UI. D3 (duração): default do calendário (ajustável no Editar).

### Etapa 1 — Gate de override self-aware (CÓDIGO) 🤖
- `buildOverridePayload` (calendar.ts): além de `is_internal`, permitir override quando o appointment é do PRÓPRIO rep (`assigned_user_id` == `getRepGhlUserId(ctx)` ou não setado=self). Bloquear override quando assignee for OUTRO user e o rep não for admin. Mensagem de erro ajustada. Unit test do gate (self ok / outro bloqueado / admin ok).

### Etapa 2 — Preferência de calendário (aditivo) 🤖
- `profile.preferences.scheduling.{default_calendar_id, default_duration_min?}` + resolução (nome dito > pref > único). "Aprender no 1º uso": bot pergunta 1× e salva. Tool/handler pra setar.

### Etapa 3 — Reescrita do fluxo no prompt 🤖
- Seção AGENDAMENTO: resolver contato+calendário+assignee(self)+slot ANTES; 1 present_options no fim; conflito → Confirmar-override-OU-Editar (self/admin) / slots-OU-Editar (na agenda de outro sem permissão); sub-fluxo Editar (Horário/Dia/Pessoa/Calendário). Few-shot do caminho feliz (áudio → 1 confirm → pronto).

### Etapa 4 — Setting de calendário padrão na UI 🤖🤝
- Controle na UI do Spark (embed/admin) pra ver/definir o `default_calendar_id` do rep (D2 — "setting na UI").

### Etapa 5 — Teste + smoke + deploy 🤝
- tsc/build/suites. Smoke do Pedro: áudio → 1 confirm → pronto; ocupado (própria agenda) → 1 confirm-override → pronto; ocupado (agenda de outro, não-admin) → slots/editar; ambíguo → +1 escolha; Editar → muda horário/pessoa. Deploy (melhoria de fluxo existente, reversível por commit).

## 7. Rollback / segurança
- Mudança é majoritariamente prompt + uma preferência aditiva. Reverter = reverter o commit. `create_appointment` + gate de override (H26) inalterados — segurança do calendário preservada. Confirmação sempre presente antes de marcar.

## 8. Riscos
| Risco | Mitigação | Resp |
|---|---|---|
| Pegar o contato errado (desambiguação por contexto agressiva) | nome resolvido SEMPRE no confirm; rep vê antes de marcar | 🤖 |
| Default-self marcar pro user errado | só self salvo se não disser outro; assignee no confirm | 🤖 |
| Não-admin tentando override | gate H26 mantido; bot oferece slots/editar (D1) | 🤖 |
| Preferência de calendário errada salva | confirm sempre mostra o calendário; rep edita | 🤝 |
