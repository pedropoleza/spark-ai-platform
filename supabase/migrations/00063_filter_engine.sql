-- Migration 00063 — Filter Engine (H27)
-- Pedro 2026-05-15: plano _planning/filter-engine-and-bulk-v2.md.
--
-- Adiciona:
--   1. filter_executions — audit log de cada FEL executado (perf + debug + abuse detect)
--   2. bulk_message_recipients.segment_label — multi-segment bulk V2
--   3. bulk_message_recipients.personalized_message — snapshot do texto enviado por contato
--
-- filter_executions:
--   • 1 row por execução de get_contacts_filtered / get_opportunities_filtered /
--     count_filtered / schedule_bulk_message_v2 etc
--   • metadata jsonb guarda FEL completo + plan (passos) + aplicação de aliases
--   • duration_ms pra detectar queries lentas (>5s = alerta admin)
--   • consumer_tool diferencia uso por feature
--
-- Mudanças bulk_message_recipients:
--   • segment_label: identifica qual segment um recipient pertence (multi-segment bulk)
--   • personalized_message: texto pós-interpolação ({first_name} substituído etc)
--     útil pra debug por contato e auditoria de complaint ("o que vc mandou pro João?")

CREATE TABLE IF NOT EXISTS filter_executions (
  id uuid primary key default gen_random_uuid(),
  rep_id uuid references rep_identities(id) on delete cascade,
  agent_id uuid references agents(id) on delete set null,
  location_id text not null,

  entity text not null,                   -- 'contacts' | 'opportunities'
  fel_input jsonb not null,               -- FilterExpression completo
  plan_steps jsonb,                       -- PlanStep[] do executor
  applied_aliases jsonb,                  -- {stageName:M3 → uuid}

  ghl_calls_made integer not null default 0,
  pages_fetched integer not null default 0,
  total_returned integer not null default 0,
  total_reported_by_ghl integer,
  client_side_filter_applied boolean not null default false,
  hit_safety_cap boolean not null default false,

  duration_ms integer not null,
  status text not null,                   -- 'ok' | 'error' | 'not_found'
  error_message text,

  consumer_tool text,                     -- nome da tool LLM que chamou

  created_at timestamptz not null default now()
);

-- Indices: query por rep + ordem cronológica reversa
CREATE INDEX IF NOT EXISTS idx_filter_executions_rep_created
  ON filter_executions (rep_id, created_at DESC);

-- Index pra detectar queries lentas
CREATE INDEX IF NOT EXISTS idx_filter_executions_slow
  ON filter_executions (created_at DESC) WHERE duration_ms > 5000;

-- Index pra agrupar por consumer_tool (analytics)
CREATE INDEX IF NOT EXISTS idx_filter_executions_consumer
  ON filter_executions (consumer_tool, created_at DESC);

-- Comment pro DBA
COMMENT ON TABLE filter_executions IS
  'Audit log do Filter Engine (H27). 1 row por execução FEL. Mantém 30 dias automaticamente via job de cleanup (futuro).';

-- =====================================================================
-- Bulk message multi-segment (H28 — usa colunas no F4 do plano)
-- =====================================================================

ALTER TABLE bulk_message_recipients
  ADD COLUMN IF NOT EXISTS segment_label text,
  ADD COLUMN IF NOT EXISTS personalized_message text;

CREATE INDEX IF NOT EXISTS idx_bulk_message_recipients_segment
  ON bulk_message_recipients (job_id, segment_label) WHERE segment_label IS NOT NULL;

COMMENT ON COLUMN bulk_message_recipients.segment_label IS
  'H28 multi-segment: identifica qual segment do job o recipient pertence (M0, Prova Agendada, etc). NULL = single-segment job.';
COMMENT ON COLUMN bulk_message_recipients.personalized_message IS
  'H28 audit: texto final pós-interpolação ({first_name} → "Pedro" etc), antes da variação Haiku. Snapshot pra debug.';
