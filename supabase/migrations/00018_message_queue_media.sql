-- Armazena attachments de midia (imagens, PDFs, docs) como JSONB array.
-- Formato: [{ "url": "...", "contentType": "image/jpeg", "fileName": "foto.jpg" }]
ALTER TABLE message_queue
  ADD COLUMN IF NOT EXISTS media_attachments JSONB DEFAULT '[]'::jsonb;
