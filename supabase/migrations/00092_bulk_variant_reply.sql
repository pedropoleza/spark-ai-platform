-- Variant reply tracking (Etapa 4.7 final — Pedro 2026-05-28).
-- _planning/_gaps-prospeccao-2026-05-28/PLANO.md §6.7 (fechar A/B com stats reais)
--
-- Adiciona coluna `replied_at` em bulk_message_recipients pro tracking de
-- A/B reply rate. Quando contato responde inbound, o tracker procura o
-- recipient enviado mais recente (últimos 7 dias) e marca replied_at.
-- Resultado: HubCampaignDetail mostra reply_count + reply_rate por variant.
--
-- Aditivo, NULL default, zero impacto em jobs existentes.

ALTER TABLE bulk_message_recipients
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ;

-- Index pra lookup rápido por contato+job (variant-reply-tracker usa).
CREATE INDEX IF NOT EXISTS idx_bulk_recipients_contact_sent
  ON bulk_message_recipients(contact_id, sent_at DESC)
  WHERE sent_at IS NOT NULL;

COMMENT ON COLUMN bulk_message_recipients.replied_at IS
  'Pedro 2026-05-28: timestamp do primeiro reply do contato após o envio. Usado pra A/B reply rate stats. NULL = sem reply ou recipient pré-tracker.';
