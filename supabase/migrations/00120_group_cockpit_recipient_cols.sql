-- =============================================================================
-- Migration 00120 — Colunas do cockpit por-grupo (H46/F3)
-- Campanhas em Grupo V2: o rep controla CADA grupo via SparkBot (ver/editar/
-- reagendar/pausar). Ver _planning/group-campaigns-v2-contatos/.
--
-- (1) paused_at: pausa POR-GRUPO dentro de um job multi-grupo (skipped/cancelled
--     são terminais; precisamos de um estado reversível). Não-NULL = o claim do
--     runner PULA (claim_bulk_recipients exige paused_at IS NULL — migration 00121
--     + safety-net no loop do runner). Resume = setar NULL.
-- (2) edited_at / edit_count: audit do "editar a mensagem" de um post pendente.
-- (3) índice parcial pra a consulta do cockpit "o que está pendente neste grupo".
--
-- Aditiva/nullable. Aplicar via MCP + arquivo.
-- =============================================================================

ALTER TABLE public.bulk_message_recipients
  ADD COLUMN IF NOT EXISTS paused_at timestamptz,
  ADD COLUMN IF NOT EXISTS edited_at timestamptz,
  ADD COLUMN IF NOT EXISTS edit_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.bulk_message_recipients.paused_at IS
  'H46: pause POR-GRUPO num job multi-grupo. Não-NULL = o claim do runner pula (claim_bulk_recipients exige paused_at IS NULL + safety-net no loop). Resume = NULL.';
COMMENT ON COLUMN public.bulk_message_recipients.edited_at IS
  'H46: última edição do texto (personalized_message) deste post pendente pelo rep.';

-- Cockpit: "o que está programado neste grupo" = pending por (job, contato-grupo).
CREATE INDEX IF NOT EXISTS idx_bulk_recipients_pending_group
  ON public.bulk_message_recipients (job_id, contact_id, scheduled_at)
  WHERE status = 'pending';
