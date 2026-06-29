-- =============================================================================
-- Migration 00123 — Colunas de mídia outbound (H46/F4)
-- Fecha o gap: os runners hoje só mandam `message` (texto). Pra anexar um asset da
-- rep_media (00122) num disparo, o recipient/step carrega o media_id; o runner
-- resolve a signed URL NO ENVIO (TTL curto) e manda attachments:[url].
--
-- D4: media_id (FK), NÃO media_url crua/signed (que algum runner mandaria literal
-- e expiraria dias depois). draft_steps tem media_url legado (00115) — passa a
-- carregar media_id; o materializer copia media_id (não a URL) e o message_text
-- vira caption LIMPA (mata o composeText-com-URL).
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

ALTER TABLE public.draft_steps
  ADD COLUMN IF NOT EXISTS media_id uuid REFERENCES public.rep_media(id) ON DELETE SET NULL;

COMMENT ON COLUMN public.bulk_message_recipients.media_id IS
  'H46: asset rep_media a anexar neste envio (signed URL resolvida no runner, TTL curto). NULL = texto puro.';
COMMENT ON COLUMN public.followup_messages.media_id IS
  'H46: asset rep_media a anexar (signed URL no envio). NULL = texto puro.';
COMMENT ON COLUMN public.draft_steps.media_id IS
  'H46: asset rep_media do passo (substitui media_url crua da 00115; o materializer copia media_id).';
