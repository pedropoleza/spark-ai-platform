-- =============================================================================
-- Migration 00071: stevo_webhook_samples (captura de formato)
-- 2026-05-20 — Mudança de fluxo: recebimento via webhook do Stevo DIRETO
-- (GHL vira fallback). Antes de implementar o parsing/roteamento, capturamos
-- o body cru de cada webhook do Stevo nesta tabela pra ver o formato exato
-- (texto / arquivo / áudio / imagem). Tabela TEMPORÁRIA de diagnóstico —
-- pode ser dropada depois que o parser estiver estável.
-- =============================================================================

CREATE TABLE IF NOT EXISTS public.stevo_webhook_samples (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  body         jsonb,
  headers      jsonb,
  received_at  timestamptz DEFAULT now()
);
