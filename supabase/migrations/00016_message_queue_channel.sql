-- Canal da mensagem (SMS, WhatsApp, Instagram, Email)
-- O webhook grava o canal detectado e o processor usa para responder
-- pelo mesmo canal.
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS channel TEXT DEFAULT 'SMS';

-- Suporte a mensagens de audio: o webhook grava a URL e o processor
-- transcreve via Whisper antes de enviar para a IA.
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS audio_url TEXT,
  ADD COLUMN IF NOT EXISTS audio_mime_type TEXT;
