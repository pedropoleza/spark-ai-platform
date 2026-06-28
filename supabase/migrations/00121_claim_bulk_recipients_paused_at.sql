-- =============================================================================
-- Migration 00121 — claim_bulk_recipients respeita paused_at (H46/F3)
--
-- Pause POR-GRUPO (00120): setar bulk_message_recipients.paused_at nos recipients
-- daquele grupo. Pra a pausa valer, o CLAIM atômico não pode reivindicar rows
-- pausadas. Adiciona `AND r.paused_at IS NULL` no CTE `due` (mantém todo o resto
-- da 00105: priority-first, FOR UPDATE SKIP LOCKED, carimbo de claim_token).
--
-- Defense-in-depth: o loop do bulk-runner também checa recipient.paused_at e
-- reverte (safety-net caso esta migration ainda não tenha sido aplicada). Mas o
-- caminho eficiente (nem reivindica pausado) vem daqui.
--
-- CREATE OR REPLACE preserva grants; re-emitimos REVOKE/GRANT por garantia.
-- Idempotente. Aplicar via MCP + arquivo.
-- =============================================================================

CREATE OR REPLACE FUNCTION public.claim_bulk_recipients(
  p_limit       INT,
  p_claim_token UUID
) RETURNS SETOF bulk_message_recipients
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  WITH due AS (
    SELECT r.id
    FROM bulk_message_recipients r
    JOIN bulk_message_jobs j ON j.id = r.job_id
    WHERE r.status = 'pending'
      AND r.paused_at IS NULL          -- H46: pause por-grupo
      AND r.scheduled_at <= now()
      AND j.status = 'running'
    ORDER BY j.priority DESC, r.scheduled_at ASC
    LIMIT GREATEST(p_limit, 0)
    FOR UPDATE OF r SKIP LOCKED
  )
  UPDATE bulk_message_recipients r
  SET status      = 'sending',
      claim_token = p_claim_token,
      claimed_at  = now()
  FROM due
  WHERE r.id = due.id
  RETURNING r.*;
$$;

REVOKE ALL ON FUNCTION public.claim_bulk_recipients(INT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_bulk_recipients(INT, UUID) TO service_role;

COMMENT ON FUNCTION public.claim_bulk_recipients(INT, UUID) IS
  'H46 (2026-06-28): claim priority-first do bulk-runner, agora pulando recipients pausados (paused_at IS NULL — pause por-grupo). Resto = 00105 (FOR UPDATE SKIP LOCKED, carimbo claim_token/claimed_at).';
