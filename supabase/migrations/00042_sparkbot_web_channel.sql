-- Sparkbot Web UI — channel awareness.
--
-- Adiciona suporte ao canal "web_ui" (painel flutuante injetado no GHL via
-- Custom JS) ao lado do "whatsapp" existente. Reps podem operar pelos 2
-- canais simultaneamente; histórico fica unificado em sparkbot_messages.
--
-- Decisões (review 2026-04-29 com Pedro):
--   1. Histórico unificado, channel só pra debug/UX
--   2. Canal preferido do rep — default 'auto' (decide na hora baseado em
--      heartbeat web). Pode ser sobrescrito pra 'whatsapp', 'web_ui', 'both'
--   3. Lembretes agendados carregam delivery_channel ('whatsapp', 'web_ui',
--      'both'). WhatsApp request → automático whatsapp. Web request → bot
--      pergunta antes de chamar schedule_reminder.

-- =============================================================
-- 1. rep_identities: canal preferido + heartbeat web
-- =============================================================
ALTER TABLE rep_identities ADD COLUMN IF NOT EXISTS
  preferred_proactive_channel TEXT NOT NULL DEFAULT 'auto'
  CHECK (preferred_proactive_channel IN ('auto', 'whatsapp', 'web_ui', 'both'));

-- Atualizado pelo Web UI a cada N segundos enquanto painel está aberto.
-- 'auto' usa esse heartbeat: se < 60s, manda no web; senão WhatsApp.
ALTER TABLE rep_identities ADD COLUMN IF NOT EXISTS
  web_session_active_at TIMESTAMPTZ;

-- =============================================================
-- 2. sparkbot_messages: distingue canal + leitura web
-- =============================================================
ALTER TABLE sparkbot_messages ADD COLUMN IF NOT EXISTS
  channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (channel IN ('whatsapp', 'web_ui', 'system'));

-- Quando rep abriu o painel e viu a msg. Usado pra badge de "novas msgs".
-- 'role=agent' && channel='web_ui'/'system' && read_in_web_at IS NULL = não lida
ALTER TABLE sparkbot_messages ADD COLUMN IF NOT EXISTS
  read_in_web_at TIMESTAMPTZ;

-- Index pro endpoint inbox (msgs proativas não-lidas)
CREATE INDEX IF NOT EXISTS idx_sparkbot_messages_unread_web
  ON sparkbot_messages(rep_id, created_at DESC)
  WHERE role = 'agent' AND read_in_web_at IS NULL;

-- =============================================================
-- 3. assistant_scheduled_tasks: canal de entrega
-- =============================================================
ALTER TABLE assistant_scheduled_tasks ADD COLUMN IF NOT EXISTS
  delivery_channel TEXT NOT NULL DEFAULT 'whatsapp'
  CHECK (delivery_channel IN ('whatsapp', 'web_ui', 'both'));

-- =============================================================
-- 4. assistant_alert_state: canal usado no disparo (auditoria)
-- =============================================================
ALTER TABLE assistant_alert_state ADD COLUMN IF NOT EXISTS
  delivery_channel TEXT;

-- =============================================================
-- 5. Sparkbot web push subscriptions (Notification API persistente)
-- =============================================================
-- Quando rep dá permissão de notificação no browser, salvamos endpoint VAPID
-- pra enviar push mesmo se aba estiver inativa (mas não fechada). MVP usa
-- só Notification API client-side (sem service worker), mas tabela já
-- existe pra futuro upgrade.
CREATE TABLE IF NOT EXISTS sparkbot_web_subscriptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id          UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  endpoint        TEXT NOT NULL,
  keys            JSONB NOT NULL, -- {p256dh, auth}
  user_agent      TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (rep_id, endpoint)
);

CREATE INDEX IF NOT EXISTS idx_sparkbot_web_subs_rep
  ON sparkbot_web_subscriptions(rep_id);

ALTER TABLE sparkbot_web_subscriptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON sparkbot_web_subscriptions;
CREATE POLICY deny_anon_all ON sparkbot_web_subscriptions AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);
