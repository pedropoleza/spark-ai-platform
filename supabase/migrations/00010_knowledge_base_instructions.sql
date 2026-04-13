-- Add description and usage instructions per KB item
ALTER TABLE knowledge_base
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS usage_instructions TEXT;
