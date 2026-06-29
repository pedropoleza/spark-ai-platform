-- =============================================================================
-- Migration 00123 — Colunas de mídia outbound (H46/F4)
-- Fecha o gap: os runners hoje só mandam `message` (texto). Pra anexar um asset da
-- rep_media (00122) num disparo, o recipient/step carrega o media_id; o runner
-- resolve a signed URL NO ENVIO (TTL curto) e manda attachments:[url].
--
-- D4: media_id (FK), NÃO media_url crua/signed (que algum runner mandaria literal
-- e expiraria dias depois). Caminho LIVE: rep_media → bulk_message_recipients →
-- bulk-runner (campanha de grupo). followup_messages.media_id é forward-looking
-- (group N-msgs via followup materializer, §4.6) — o runner já o trata. A
-- integração do task-orchestrator (draft_steps.media_id + add_step) fica como
-- follow-up (não há tool escrevendo media_id no passo ainda).
--
-- Aditiva/nullable. ON DELETE SET NULL: apagar um asset não quebra o disparo (só
-- vira texto puro). Aplicar via MCP + arquivo.
-- =============================================================================

ALTER TABLE public.followup_messages
  ADD COLUMN IF NOT EXISTS media_id uuid REFERENCES public.rep_media(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_type text;

ALTER TABLE public.bulk_message_recipients
  ADD COLUMN IF NOT EXISTS media_id uuid REFERENCES public.rep_media(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS media_type text;

COMMENT ON COLUMN public.bulk_message_recipients.media_id IS
  'H46: asset rep_media a anexar neste envio (signed URL resolvida no runner, TTL curto). NULL = texto puro.';
COMMENT ON COLUMN public.followup_messages.media_id IS
  'H46: asset rep_media a anexar (signed URL no envio). NULL = texto puro. Forward-looking (group N-msgs).';
