-- =====================================================================
-- 00115 — Task Orchestrator: rascunho persistente de tarefas N-etapas
-- (Pedro 2026-06-20). Plano: _planning/jussara-sparkbot/EXECUCAO.md (F0).
-- =====================================================================
-- Peça-mãe do motor anti-alucinação: "a tarefa é um OBJETO PERSISTENTE no DB,
-- não uma lembrança na janela de contexto". Resolve os 2 buracos do caso Jussara:
--   L7 — o bot perdia o início do fluxo de 40 dias porque NADA era persistido
--        ("não salvei nada, só registrei mentalmente"). Agora cada passo é uma row.
--   L11 — o bot afirmava "agendado" pra 7 contatos com ZERO inserts. O materializador
--        (F2) só reporta o COUNT REAL de rows; aqui fica o draft + audit append-only.
--
-- Aditiva e gated: nenhuma tool usa estas tabelas com a flag TASK_ORCHESTRATOR_ENABLED
-- OFF (default). Espelha o estilo do 00067 (followup) — sem RLS, acesso via admin client.
--
-- Generaliza por `kind`: followup_sequence (caso Jussara), file_export (gerar PDF),
-- campaign (futuro). O mesmo trio (draft persistente + mutators determinísticos +
-- materializador atômico com count real) atende qualquer tarefa multi-etapa.

-- =====================================================================
-- task_drafts — 1 row por TAREFA em construção (fonte da verdade entre turnos)
-- =====================================================================
CREATE TABLE IF NOT EXISTS task_drafts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  rep_id UUID NOT NULL REFERENCES rep_identities(id) ON DELETE CASCADE,
  location_id TEXT NOT NULL,
  agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,

  -- Tipo da tarefa (generaliza o motor além de follow-up).
  kind TEXT NOT NULL DEFAULT 'followup_sequence'
    CHECK (kind IN ('followup_sequence', 'file_export', 'campaign')),

  -- Máquina de estado do CICLO de montagem. Só transiciona via mutator/materializador;
  -- o LLM NÃO pode pular pra 'materialized' por conta própria (anti-alucinação).
  status TEXT NOT NULL DEFAULT 'building'
    CHECK (status IN ('building', 'ready_for_review', 'materializing',
                      'materialized', 'failed', 'cancelled')),

  title TEXT,                          -- rótulo humano ("Fluxo no-show seguro de vida")

  -- Alvo + parâmetros da tarefa (contact_id/nome/phone, timezone, cíclico, temperatura
  -- da lista, etc). jsonb pra ser agnóstico de kind.
  meta JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Preenchido SÓ na materialização atômica (F2) com o job real criado. Prova de disparo.
  materialized_job_id UUID REFERENCES bulk_message_jobs(id) ON DELETE SET NULL,
  materialized_count INT,              -- nº REAL de rows inseridas (honestidade L11)
  materialized_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_drafts_rep_status
  ON task_drafts (rep_id, status);
CREATE INDEX IF NOT EXISTS idx_task_drafts_location
  ON task_drafts (location_id, created_at DESC);

COMMENT ON TABLE task_drafts IS
  'Pedro 2026-06-20 (motor anti-alucinação, caso Jussara): rascunho persistente de '
  'tarefa N-etapas. Fonte da verdade entre turnos — o bot relê via show_draft, não '
  '"lembra". status só promove a materialized DENTRO do materializador atômico.';
COMMENT ON COLUMN task_drafts.materialized_count IS
  'Count REAL de rows inseridas no disparo. O bot só afirma "agendado" a partir daqui (fecha L11).';

-- =====================================================================
-- draft_steps — N passos do rascunho (sem clamp de 3; cap defensivo no código)
-- =====================================================================
CREATE TABLE IF NOT EXISTS draft_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE CASCADE,
  position INT NOT NULL,               -- ordem 1-based

  -- Agendamento DIA-RELATIVO por passo (resolve L4: o SISTEMA calcula scheduled_at no
  -- fuso do rep; o LLM não inventa offset_hours). offset_days a partir do início.
  offset_days INT NOT NULL DEFAULT 0
    CHECK (offset_days >= 0 AND offset_days <= 365),
  send_time TEXT,                      -- "HH:MM" local do rep; NULL = hora padrão
  -- F3 (multi-msg/dia): vários passos no MESMO offset_days com delay intra-dia.
  intra_day_delay_s INT NOT NULL DEFAULT 0
    CHECK (intra_day_delay_s >= 0 AND intra_day_delay_s <= 86400),

  message_text TEXT NOT NULL DEFAULT '',  -- conteúdo (pode ficar vazio durante building)

  -- F4/F5 (mídia): URL do anexo + tipo. Vídeo/imagem/PDF por passo.
  media_url TEXT,
  media_type TEXT,                     -- 'image' | 'video' | 'application/pdf' | ...

  -- Condição de envio (F3+: "se não respondeu"). MVP usa só pause-on-reply global.
  send_condition TEXT,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (draft_id, position)
);

CREATE INDEX IF NOT EXISTS idx_draft_steps_draft_pos
  ON draft_steps (draft_id, position);

COMMENT ON TABLE draft_steps IS
  'Pedro 2026-06-20: passos do rascunho. SEM clamp de 3 (cap defensivo no código). '
  'offset_days+send_time → scheduled_at calculado pelo SISTEMA no fuso do rep, não pelo LLM.';

-- =====================================================================
-- task_events — audit APPEND-ONLY (honestidade retroativa)
-- =====================================================================
CREATE TABLE IF NOT EXISTS task_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  draft_id UUID NOT NULL REFERENCES task_drafts(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,            -- step_added | step_edited | step_removed |
                                       -- reordered | committed | materialize_failed | ...
  event_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_task_events_draft
  ON task_events (draft_id, created_at);

COMMENT ON TABLE task_events IS
  'Pedro 2026-06-20: log imutável de cada mutação/materialização. Fonte de auditoria e '
  'de "o que de fato saiu" (molde de followup_events). Append-only.';
