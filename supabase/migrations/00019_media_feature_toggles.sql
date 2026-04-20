-- Toggles independentes para features de midia.
-- Cada feature tem custo separado (Whisper para audio, Vision para imagem,
-- tokens extras para PDF). Desabilitados por padrao para controle de custo.
ALTER TABLE agent_configs
  ADD COLUMN IF NOT EXISTS enable_audio_transcription BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_image_analysis BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS enable_pdf_reading BOOLEAN NOT NULL DEFAULT false;
