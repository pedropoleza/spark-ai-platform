-- Canal da mensagem (SMS, WhatsApp, Instagram, Email)
-- O webhook grava o canal detectado e o processor usa para responder
-- pelo mesmo canal.
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'SMS';
