-- F37 (Pedro 2026-05-29): Lead Awareness + Handoff Inteligente.
--
-- Adiciona ao agent_configs:
--   - lead_history_config: bot carrega histórico do contato do Spark Leads
--     (msgs anteriores, notas, opp stage, tags) antes de responder.
--   - handoff_policy: regras pra bot decidir SKIP em vez de responder, e
--     notificar rep humano via SparkBot quando aplicável.
--
-- Nova tabela handoff_notifications: audit + idempotência das notificações
-- enviadas pro rep via SparkBot (evita spam quando lead manda 5 msgs em
-- sequência — só 1 notify por contato+razão em 4h).
--
-- Defaults conservadores (enabled=false em ambos) — zero mudança em prod
-- até admin ligar via UI.

ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS lead_history_config JSONB
    DEFAULT '{
      "enabled": false,
      "messages_count": 20,
      "include_notes": true,
      "include_opportunities": true,
      "include_tags": true
    }'::jsonb,
  ADD COLUMN IF NOT EXISTS handoff_policy JSONB
    DEFAULT '{
      "enabled": false,
      "skip_if_human_replied_within_minutes": 60,
      "skip_if_lead_requested_human": true,
      "notify_rep_via_sparkbot": true,
      "notify_on_opp_stage_closed": true,
      "custom_keywords_handoff": ["humano", "atendente", "pessoa", "falar com alguem", "falar com alguém", "real person", "agent please"]
    }'::jsonb;

COMMENT ON COLUMN agent_configs.lead_history_config IS
  'F37: toggle pra carregar histórico do contato do GHL/Spark Leads antes de responder. Default OFF (retrocompat).';
COMMENT ON COLUMN agent_configs.handoff_policy IS
  'F37: regras pra bot decidir SKIP em vez de responder (humano já respondeu, lead pediu humano, opp fechada) e notificar rep via SparkBot.';

-- Audit + idempotência das notificações de handoff enviadas pelo bot
-- pro rep humano via SparkBot.
CREATE TABLE IF NOT EXISTS handoff_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL,
  contact_id TEXT NOT NULL,
  rep_id UUID REFERENCES rep_identities(id) ON DELETE SET NULL,
  reason TEXT NOT NULL,
  trigger_message TEXT,
  sparkbot_message_id UUID,
  metadata JSONB DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index pra busca de "já notificou esse contato por essa razão recentemente?"
CREATE INDEX IF NOT EXISTS idx_handoff_notif_recent
  ON handoff_notifications (location_id, contact_id, reason, created_at DESC);

-- Index pra dashboard por rep
CREATE INDEX IF NOT EXISTS idx_handoff_notif_rep
  ON handoff_notifications (rep_id, created_at DESC);

COMMENT ON TABLE handoff_notifications IS
  'F37: histórico das notificações que o bot lead-facing mandou pro rep humano via SparkBot quando decidiu não responder.';
