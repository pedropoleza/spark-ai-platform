-- 00073: Proatividade configurável (FORGE-3 2026-05-21) — Etapa 0
--
-- Contexto: o rep vai poder ligar/desligar cada proatividade pra si (via chat e
-- via UID do Spark). Hoje as regras são globais por agente (assistant_proactive_rules).
-- Esta migration adiciona a camada de PREFERÊNCIA POR REP + habilita o novo
-- task_type pro lembrete de tarefa do GHL (event-driven).
--
-- Tudo aditivo e retrocompat: ausência de pref = default da regra (resolvido em
-- código, proactive/preferences.ts). Nenhuma operação de cliente é afetada — a
-- proatividade event-driven inteira fica atrás do env PROACTIVE_EVENTS_ENABLED.

-- 1. Preferências de proatividade por rep.
--    Formato: { "<rule_key>": { "enabled": bool, "params": { "lead_min": 15 } } }
--    {} = todas as regras seguem o default da matriz (preferences.ts).
ALTER TABLE rep_identities
  ADD COLUMN IF NOT EXISTS proactivity_prefs jsonb NOT NULL DEFAULT '{}'::jsonb;

-- 2. Novo task_type pro lembrete de tarefa do GHL (one-shot agendado em due-15min).
--    Reusa assistant_scheduled_tasks + reminder-runner (entrega ao REP, kind=nudge,
--    sujeito ao silence-gate). NÃO é outbound_to_contact (não vai pro contato).
ALTER TABLE assistant_scheduled_tasks
  DROP CONSTRAINT IF EXISTS assistant_scheduled_tasks_task_type_check;

ALTER TABLE assistant_scheduled_tasks
  ADD CONSTRAINT assistant_scheduled_tasks_task_type_check
  CHECK (task_type = ANY (ARRAY[
    'reminder'::text,
    'recurring_reminder'::text,
    'outbound_to_contact'::text,
    'outbound_to_contact_recurring'::text,
    'ghl_task_reminder'::text
  ]));

-- 3. Índice pra dedup/cancelamento rápido do lembrete por task do GHL
--    (lookup por ghl_task_id dentro do task_payload, só os pendentes).
CREATE INDEX IF NOT EXISTS idx_scheduled_tasks_ghl_task
  ON assistant_scheduled_tasks ((task_payload->>'ghl_task_id'))
  WHERE task_type = 'ghl_task_reminder' AND status = 'pending';
