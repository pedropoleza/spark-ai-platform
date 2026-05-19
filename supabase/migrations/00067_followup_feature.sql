-- =====================================================================
-- 00067 — Follow-up Feature schema (Pedro 2026-05-18).
-- =====================================================================
-- Plano: _planning/followup-feature.md
--
-- Cria infra pra follow-ups inteligentes agendados por IA:
--   - followup_sequences: 1 row por pedido de follow-up (1+ msgs)
--   - followup_messages: cada msg agendada da sequence
--   - followup_events: audit trail (created/approved/paused/replied/etc)
--   - agent_configs: 9 cols novas pra controlar feature
--
-- Arquitetura modular: core service `followup/core.ts` aceita source
-- (chat | proactive_rule | webhook futuro) — schema agnostico de origem.

-- =====================================================================
-- followup_sequences
-- =====================================================================
CREATE TABLE IF NOT EXISTS followup_sequences (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL,
  agent_id UUID REFERENCES agents(id),
  contact_id TEXT NOT NULL,
  contact_name TEXT,
  contact_phone TEXT,
  conversation_id TEXT,

  -- Origem do request (modular core service)
  source TEXT NOT NULL DEFAULT 'chat',
                              -- 'chat' | 'proactive_rule' | 'webhook' (futuro)
  source_metadata JSONB,

  -- Goal & contexto
  goal TEXT,
  sequence_type TEXT DEFAULT 'sales',
                              -- 'sales' | 'service' | 'reschedule' | 'pos_sale'
                              -- 'internal_reminder' | 'recurring' | 'custom'
  tone TEXT,
  context_source TEXT,        -- 'manual_only' | 'conversation_used' | 'mixed' | 'none'
  context_summary TEXT,       -- resumo do que LLM leu da conversa (auditavel)

  -- Spam scoring
  spam_score INT,             -- 0-100
  spam_risk TEXT,             -- 'low' | 'medium' | 'high'
  spam_flags JSONB,
  spam_recommendation TEXT,

  -- Approval
  approval_status TEXT NOT NULL DEFAULT 'pending_approval',
                              -- 'pending_approval' | 'approved' | 'auto_approved'
                              -- 'edited' | 'rejected'
  approved_at TIMESTAMPTZ,
  approved_by_rep BOOLEAN,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'draft',
                              -- 'draft' | 'scheduled' | 'running' | 'paused'
                              -- 'completed' | 'cancelled' | 'skipped_reply' | 'failed'
  stop_on_reply BOOLEAN NOT NULL DEFAULT true,
  delivery_channel TEXT NOT NULL DEFAULT 'whatsapp_web_sms',

  -- Counters (denormalized — mantido em sync por runner/scheduler)
  total_messages INT DEFAULT 0,
  sent_messages INT DEFAULT 0,
  failed_messages INT DEFAULT 0,
  skipped_messages INT DEFAULT 0,

  -- Timestamps
  scheduled_first_at TIMESTAMPTZ,
  scheduled_last_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  paused_at TIMESTAMPTZ,
  cancelled_at TIMESTAMPTZ,
  cancelled_reason TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followup_seq_rep_status
  ON followup_sequences (rep_id, status);
CREATE INDEX IF NOT EXISTS idx_followup_seq_loc_status
  ON followup_sequences (location_id, status);
CREATE INDEX IF NOT EXISTS idx_followup_seq_contact_active
  ON followup_sequences (contact_id, location_id)
  WHERE status IN ('scheduled', 'running', 'paused');
CREATE INDEX IF NOT EXISTS idx_followup_seq_created
  ON followup_sequences (created_at DESC);

COMMENT ON TABLE followup_sequences IS
  'Pedro 2026-05-18: 1 row por pedido de follow-up. Tabela domain-specific, ' ||
  'separada de bulk_message_jobs pra evolução independente da feature.';

-- =====================================================================
-- followup_messages
-- =====================================================================
CREATE TABLE IF NOT EXISTS followup_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  position INT NOT NULL,              -- 1, 2, 3...

  message_text TEXT NOT NULL,         -- texto FINAL (pós-edits do rep)
  message_text_original TEXT,         -- pré-edits (audit)
  tone_hint TEXT,

  scheduled_at TIMESTAMPTZ NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
                                      -- 'pending' | 'sending' | 'sent'
                                      -- 'failed' | 'skipped' | 'cancelled'
  sent_at TIMESTAMPTZ,
  error_message TEXT,
  ghl_message_id TEXT,

  -- Spam recheck antes do envio
  requires_final_check BOOLEAN DEFAULT true,
  spam_score_at_send INT,

  -- Claim atomic (runner)
  claim_token UUID,
  claimed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followup_msg_seq_pos
  ON followup_messages (sequence_id, position);
CREATE INDEX IF NOT EXISTS idx_followup_msg_pending
  ON followup_messages (status, scheduled_at)
  WHERE status = 'pending';
CREATE UNIQUE INDEX IF NOT EXISTS idx_followup_msg_seq_pos_unique
  ON followup_messages (sequence_id, position);

COMMENT ON TABLE followup_messages IS
  'Pedro 2026-05-18: cada msg física de uma sequence. Runner claim ' ||
  'atomic via claim_token (similar bulk-message-runner).';

-- =====================================================================
-- followup_events (audit trail)
-- =====================================================================
CREATE TABLE IF NOT EXISTS followup_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sequence_id UUID NOT NULL REFERENCES followup_sequences(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
              -- 'created' | 'approved' | 'auto_approved' | 'edited' | 'rejected'
              -- 'paused' | 'resumed' | 'cancelled' | 'message_sent' | 'message_failed'
              -- 'contact_replied' | 'spam_recalc' | 'completed' | 'skipped'
              -- 'safety_blocked'
  event_data JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_followup_evt_seq
  ON followup_events (sequence_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_followup_evt_type
  ON followup_events (event_type, created_at DESC);

COMMENT ON TABLE followup_events IS
  'Pedro 2026-05-18: audit trail imutavel de cada sequence. ' ||
  'Usado por dashboard + debug + compliance.';

-- =====================================================================
-- agent_configs — 9 cols novas pra follow-up feature
-- =====================================================================
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS followup_feature_enabled BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS followup_approval_mode TEXT DEFAULT 'adaptive',
  ADD COLUMN IF NOT EXISTS followup_default_sequence_length INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS followup_max_sequence_length INT DEFAULT 3,
  ADD COLUMN IF NOT EXISTS followup_default_interval_hours INT DEFAULT 48,
  ADD COLUMN IF NOT EXISTS followup_max_messages_without_response INT DEFAULT 2,
  ADD COLUMN IF NOT EXISTS followup_allow_conversation_context BOOLEAN DEFAULT true,
  ADD COLUMN IF NOT EXISTS followup_allowed_channels JSONB DEFAULT '["whatsapp_web_sms"]'::jsonb,
  ADD COLUMN IF NOT EXISTS followup_stage_triggers JSONB;

COMMENT ON COLUMN agent_configs.followup_approval_mode IS
  'adaptive (low risk auto, medium/high pede approval) | always_ask | auto_low_risk | auto_all';
COMMENT ON COLUMN agent_configs.followup_stage_triggers IS
  'Pedro 2026-05-18: preparação pra webhook futuro. ' ||
  'JSON com mapping stage_id → followup rule (sequence_type, length, tone).';
