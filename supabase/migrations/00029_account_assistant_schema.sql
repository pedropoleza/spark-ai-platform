-- Account Assistant V1 — schema base.
--
-- Diferente de sales/recruitment, o Account Assistant conversa com o REP
-- comercial humano (não com leads). Precisa identificar reps por telefone
-- (podendo ser user em múltiplas locations) e manter estado de sessão
-- separado.
--
-- Apenas tabelas essenciais pro V1. Tabelas pra proatividade
-- (assistant_scheduled_tasks, assistant_alert_state) entram em migrations
-- futuras quando V2/V3 chegar.

-- =====================================================
-- 1. rep_identities: quem é o rep (por phone, multi-location)
-- =====================================================
CREATE TABLE IF NOT EXISTS rep_identities (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone                  TEXT UNIQUE NOT NULL,
  display_name           TEXT,
  -- Array de { location_id, ghl_user_id, location_name, role }
  -- Um rep pode ser user em N locations. A whitelist de agent_configs é
  -- quem filtra quais reps cada location autoriza.
  ghl_users              JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Location ativa na sessão atual. Se NULL e ghl_users > 1, assistente
  -- pergunta qual operar antes de agir.
  active_location_id     TEXT,
  -- Memória adaptativa: preferências, hábitos, opt-outs
  profile                JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Termos de uso. Primeiro contato pede aceite.
  terms_accepted_at      TIMESTAMPTZ,
  -- Alerta de no-response: rep não tá respondendo → pausa temporária
  unanswered_count       INT NOT NULL DEFAULT 0,
  unanswered_pause_until TIMESTAMPTZ,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rep_identities_phone ON rep_identities(phone);

ALTER TABLE rep_identities ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON rep_identities;
CREATE POLICY deny_anon_all ON rep_identities AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =====================================================
-- 2. assistant_conversations: estado de sessão rep↔assistente
-- =====================================================
CREATE TABLE IF NOT EXISTS assistant_conversations (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id                  UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  -- ID da conversa no GHL Hub (1 por rep, persistente)
  ghl_conversation_id     TEXT,
  -- Pending state: ação ou desambiguação aguardando resposta do rep
  -- { type: "confirm_action"|"clarify_entity"|"choose_location",
  --   tool?, args?, options?, expires_at }
  pending_action          JSONB,
  -- Buffer de rajada (debounce): msgs empilhadas aguardando agrupamento
  pending_messages        JSONB NOT NULL DEFAULT '[]'::jsonb,
  debounce_expires_at     TIMESTAMPTZ,
  -- Estatísticas
  last_turn_at            TIMESTAMPTZ,
  turn_count              INT NOT NULL DEFAULT 0,
  -- AI paused state
  ai_paused_at            TIMESTAMPTZ,
  ai_paused_reason        TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_assistant_conv_rep ON assistant_conversations(rep_id);
CREATE INDEX IF NOT EXISTS idx_assistant_conv_debounce
  ON assistant_conversations(debounce_expires_at)
  WHERE debounce_expires_at IS NOT NULL;

ALTER TABLE assistant_conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS deny_anon_all ON assistant_conversations;
CREATE POLICY deny_anon_all ON assistant_conversations AS RESTRICTIVE FOR ALL TO anon
  USING (false) WITH CHECK (false);

-- =====================================================
-- 3. agent_configs: colunas específicas do Account Assistant
-- =====================================================
-- Account Assistant reusa a tabela agent_configs pra manter consistência
-- com sales/recruitment (mesma estrutura de admin dashboard, billing, etc).
-- Estas colunas só são usadas quando agent.type = 'account_assistant'.
ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS
  -- Array de ghl_user_ids autorizados a falar com o assistente na location.
  -- Formato: [{ ghl_user_id, name, phone }]
  allowed_ghl_users     JSONB DEFAULT '[]'::jsonb;

ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS
  -- Modo de confirmação pra ações:
  -- 'always' = confirma tudo, 'medium_and_high' = confirma leve+pesado (default),
  -- 'high_only' = só confirma irreversíveis
  confirmation_mode     TEXT DEFAULT 'medium_and_high';

ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS
  -- Quantas msgs sem resposta antes de pausar (default 3)
  no_response_threshold INT DEFAULT 3;

ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS
  -- Quiet hours: { enabled, start, end, timezone, days[] }
  -- Fora desse horário o assistente não envia proativos (V2+)
  quiet_hours           JSONB DEFAULT '{}'::jsonb;

ALTER TABLE agent_configs ADD COLUMN IF NOT EXISTS
  -- Toggles de alertas proativos (V2+). Estrutura:
  -- { meeting_briefing, post_meeting, no_show, stale_opportunity, task_due, ... }
  alert_toggles         JSONB DEFAULT '{}'::jsonb;
