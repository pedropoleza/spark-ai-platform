-- =============================================
-- 00051_admin_signals
--
-- Pedro 2026-05-04: painel admin pra rastrear sinais do uso do SparkBot.
-- Captura coisas que precisam de atenção:
--   - failure: bot tentou executar e travou (ex: tool retornou erro persistente)
--   - missed_capability: rep pediu algo que o bot não consegue fazer ainda
--                        (auto-registrado quando bot diz "não tenho essa função")
--   - error: erro técnico recorrente (ex: API rejeitando, parsing falhando)
--   - idea: ideia/sugestão (manual via UI, ou bot detecta de feedback do rep)
--
-- Clustering: pra evitar 100 rows de "rep pediu disparo em massa" antes
-- da feature existir, signals com mesmo `fingerprint` (hash normalizado
-- do title + type) acumulam em 1 row com occurrence_count++ e last_seen_at.
--
-- Status: open (novo) → triaged (Pedro viu) → in_progress (sendo resolvido)
--         → done (entregue) → wontfix (decidido não fazer).
-- =============================================

CREATE TABLE IF NOT EXISTS admin_signals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Categorização
  type text NOT NULL CHECK (type IN ('failure', 'missed_capability', 'error', 'idea')),
  severity text NOT NULL DEFAULT 'medium' CHECK (severity IN ('low', 'medium', 'high', 'critical')),

  -- Conteúdo
  title text NOT NULL,
  description text,

  -- Clustering anti-duplicação
  -- Hash de (type + normalized_title) — 2 signals com mesmo fingerprint
  -- viram 1 row com count++. Calculado pela aplicação no insert.
  fingerprint text NOT NULL,

  -- Contagem + janelas
  occurrence_count integer NOT NULL DEFAULT 1,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),

  -- Workflow
  status text NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'triaged', 'in_progress', 'done', 'wontfix')),

  -- Origem + contexto
  -- source: 'bot_auto' (criado pelo executeTool/report_missed_capability),
  --         'manual' (Pedro adicionou via UI), 'system' (cron/job)
  source text NOT NULL DEFAULT 'bot_auto'
    CHECK (source IN ('bot_auto', 'manual', 'system')),

  -- Sample data pra debug (rep_id, location_id, last error, etc).
  -- Não é PII sensível — admin só (Pedro).
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Anotação manual do Pedro (notes durante triage)
  admin_notes text,

  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- UNIQUE no fingerprint pra ON CONFLICT incrementar atomicamente
CREATE UNIQUE INDEX IF NOT EXISTS idx_admin_signals_fingerprint
  ON admin_signals(fingerprint);

-- Lista padrão: ordenar por count desc + status open first
CREATE INDEX IF NOT EXISTS idx_admin_signals_status_count
  ON admin_signals(status, occurrence_count DESC);

CREATE INDEX IF NOT EXISTS idx_admin_signals_type_count
  ON admin_signals(type, occurrence_count DESC);

CREATE INDEX IF NOT EXISTS idx_admin_signals_last_seen
  ON admin_signals(last_seen_at DESC);

COMMENT ON TABLE admin_signals IS
  'Sinais agregados pro painel admin do SparkBot. Failures, missed capabilities, erros, ideias — tudo dedup por fingerprint.';
COMMENT ON COLUMN admin_signals.fingerprint IS
  'Hash normalizado (lowercase + trim + sem pontuação) do type + title. Mesmo fingerprint = mesmo signal, incrementa count.';
COMMENT ON COLUMN admin_signals.metadata IS
  'Contexto: rep_ids amostrais, last_error, location_id, sample_messages. Útil pra debug.';
