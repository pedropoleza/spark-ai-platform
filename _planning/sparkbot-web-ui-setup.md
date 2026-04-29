# Sparkbot Web UI — Setup Guide

Instruções pra ativar o painel flutuante do Sparkbot dentro do GHL.

## 1. Aplicar migrations no Supabase

No SQL Editor do Supabase (como postgres):

```sql
-- Aplicar 00040 (já feito na sprint 0)
-- Aplicar 00041 (CRON_SECRET rotation — já feito)
-- Aplicar 00042 (channel awareness):
\i supabase/migrations/00042_sparkbot_web_channel.sql
```

## 2. Configurar env vars no Vercel

Em `Production`, `Preview` e `Development`:

```
NEXT_PUBLIC_APP_URL=https://spark-ai-platform.vercel.app
ASSISTANT_HUB_LOCATION_ID=<id da location Hub onde o Sparkbot é agente>
ASSISTANT_HUB_COMPANY_ID=<company_id que dona dessa location>
```

## 3. Snippet pra colar no GHL

Vá em **Agency Settings → Custom JavaScript** (precisa Pro plan) e cole esse snippet:

```html
<script>
(function(){
  if (window.__sparkbotInjected) return;
  var s = document.createElement('script');
  s.src = 'https://spark-ai-platform.vercel.app/embed/sparkbot/loader';
  s.async = true;
  document.head.appendChild(s);
})();
</script>
```

Cinco linhas. Não precisa atualizar nunca mais — todas as mudanças do widget vão na URL do nosso server.

> **Nota**: GHL pode precisar de "Custom JavaScript" no Agency Pro+. Se você
> só tem Custom CSS, fala comigo que tem fallback (Custom Menu Link simples
> sem painel flutuante).

## 4. Como funciona

### Fluxo de auth
1. Pedro entra no GHL, app GHL injeta o snippet em todas as páginas
2. Snippet detecta:
   - `locationId` da URL `/v2/location/<id>/...`
   - `companyId` de globals/meta
   - `userId` do JWT em `localStorage` (chave `token-id`)
3. POST `/api/sparkbot/check-admin` com esses dados
4. Server valida via GHL API (`/users/<id>` retorna role/type) — admin = `admin`, `owner`, `agency_owner`, `agency_user`, `account`, `agency`
5. Se admin: emite JWT temp (1h) + cria/atualiza `rep_identity`
6. Snippet injeta botão flutuante (canto inferior direito) com badge de não-lidas

### Fluxo de uso
- Click no botão → abre painel 450px à direita com iframe `/embed/sparkbot?token=...`
- Painel mostra histórico unificado (WhatsApp + Web UI numa só timeline)
- Rep digita → POST `/api/sparkbot/send` → processIncoming roda igual ao webhook do WhatsApp
- Resposta volta no painel via polling (5s)

### Proatividade

Lembretes agendados usam `delivery_channel`:
- `whatsapp` (default): aparece como notificação push no celular do rep + msg no histórico
- `web_ui`: aparece como notificação browser + badge no botão flutuante (só quando aba GHL aberta)
- `both`: dois lugares ao mesmo tempo

**Comportamento do bot:**
- Se rep pedir lembrete pelo **WhatsApp**: bot agenda direto com `delivery_channel='whatsapp'` (sem perguntar)
- Se rep pedir lembrete pelo **Web UI**: bot SEMPRE pergunta "computador, celular ou ambos?" antes de agendar

### Heartbeat e canal automático

- Painel web envia heartbeat a cada 30s pra `/api/sparkbot/inbox` → atualiza `rep_identities.web_session_active_at`
- Reminder com `delivery_channel='auto'` (futuro) consultaria esse timestamp pra decidir

## 5. Validar que funciona

1. Aplicar migrations
2. Setar env vars
3. Colar snippet no Agency Settings
4. Reload qualquer location no GHL
5. Devagar (até 30s) deve aparecer o botão flutuante
6. Click → painel abre
7. Manda "oi" → bot responde

### Troubleshooting

**Botão não aparece:**
- DevTools → Console → procura `[Sparkbot]`
- "não consegui extrair contexto GHL" → user não tá em `/v2/location/...` ou globals do GHL mudaram (ajustar `detectUserId()` em loader.js)
- "não autorizado: not_admin" → user não tem role admin no GHL → trocar pra admin ou remover o gate (`is_admin` no check-admin)

**Painel abre mas chat não responde:**
- DevTools → Network → POST `/api/sparkbot/send` → ver erro
- Provavelmente `ASSISTANT_HUB_LOCATION_ID` não setado
- Ou `agent_id` (Sparkbot) não ativo na Hub location → criar agent no dashboard `/dashboard/agents`

**Notificações não aparecem:**
- Browser bloqueou? Check `chrome://settings/content/notifications`
- Aba precisa estar aberta (Notification API client-side só)
- Push real (com aba fechada) requer Service Worker — backlog futuro

## 6. Para reverter

1. Remover snippet do Agency Settings → Custom JS
2. (opcional) Pause `agents.status='inactive'` na Hub location pra parar billing
3. Migrations 00040-00042 são forwards-compat — não precisam ser revertidas

## 7. Backlog

- [ ] Push notification real (Service Worker + VAPID + tabela `sparkbot_web_subscriptions`)
- [ ] Widget pra location-level (sem precisar Agency Custom JS)
- [ ] V3: WhatsApp send real via GHL Hub conversations/messages
- [ ] Compartilhamento de "templates" de pergunta entre reps de uma agência
- [ ] Dark mode no painel
