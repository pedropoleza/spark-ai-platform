-- 00074: Acompanhamento Guiado (outreach 1-por-vez) — FORGE-3 2026-05-21
--
-- Fluxo stateful pro rep mandar mensagem pra uma LISTA de contatos UM POR VEZ,
-- com botão Confirmar/Editar/Pular (confirmar dispara + vai pro próximo). Resolve
-- o travamento do lote grande (timeout 60s) quebrando em passos de 1 contato.
-- Cursor = primeiro item 'pending' por position (derivado, sem drift).
--
-- Aditivo + gated por GUIDED_OUTREACH_ENABLED. Não afeta nada existente.

CREATE TABLE IF NOT EXISTS guided_outreach_sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id             UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id        TEXT NOT NULL,
  agent_id           UUID NOT NULL,
  -- Intenção/contexto do rep (ex: "acompanhamento M0 — perguntar da prova").
  goal               TEXT,
  status             TEXT NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'completed', 'cancelled')),
  -- Envia na hora ou agenda (escalona +2min por contato).
  send_mode          TEXT NOT NULL DEFAULT 'now'
                     CHECK (send_mode IN ('now', 'scheduled')),
  schedule_anchor_at TIMESTAMPTZ,
  total              INT NOT NULL DEFAULT 0,
  sent_count         INT NOT NULL DEFAULT 0,
  skipped_count      INT NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS guided_outreach_items (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id         UUID NOT NULL REFERENCES guided_outreach_sessions(id) ON DELETE CASCADE,
  position           INT NOT NULL,
  contact_id         TEXT NOT NULL,
  contact_name       TEXT,
  contact_phone      TEXT,
  suggested_message  TEXT,
  final_message      TEXT,
  status             TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending', 'sent', 'skipped')),
  decided_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (session_id, contact_id)
);

-- Cursor: próximo item a tratar = menor position com status='pending'.
CREATE INDEX IF NOT EXISTS idx_guided_items_pending
  ON guided_outreach_items (session_id, position)
  WHERE status = 'pending';

-- 1 sessão ativa por rep (lookup rápido).
CREATE INDEX IF NOT EXISTS idx_guided_sessions_active
  ON guided_outreach_sessions (rep_id)
  WHERE status = 'active';
