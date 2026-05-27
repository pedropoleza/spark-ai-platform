-- =============================================================================
-- Migration 00088: estende o deny-anon RLS (defesa em profundidade) pras tabelas
-- criadas DEPOIS da 00028 que ficaram sem cobertura.
-- Ultra-review 2026-05-26 (fato transversal C4: "RLS dormente / cobertura parcial").
--
-- Contexto (igual 00028): auth é via GHL SSO (JWT custom) e TODO acesso a dados no
-- runtime usa o service_role key — que tem rolbypassrls=true (provado: pg_roles).
-- pg_cron roda como postgres (bypassrls=true). O client anon (NEXT_PUBLIC_ key)
-- NÃO é usado em lugar nenhum do runtime (dead code). Logo estas policies têm
-- IMPACTO ZERO no fluxo normal — só fecham o buraco de "se uma rota/uso acidental
-- pegar o anon key, acesso = zero". É exatamente o padrão da 00028.
--
-- Por que importa: várias dessas tabelas guardam PII (followup_*, bulk_message_*)
-- ou SEGREDOS (cron_config.proactive_secret, stevo_instances) e estavam sem o
-- deny-anon que as demais já têm.
--
-- SEGURO de aplicar: idempotente; só adiciona policy RESTRICTIVE p/ role anon.
-- Não cria policy permissiva (não muda nada pra service_role/postgres que
-- bypassam). Verificação pós-aplicação: cron billing-retry segue cobrando +
-- /hub lê dados normalmente (ambos service_role/postgres).
-- =============================================================================

DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'admin_signals',
    'bulk_cap_overrides',
    'bulk_contact_cooldown',
    'bulk_message_jobs',
    'bulk_message_recipients',
    'bulk_runner_health',
    'cron_config',
    'filter_executions',
    'followup_events',
    'followup_messages',
    'followup_sequences',
    'guided_outreach_items',
    'guided_outreach_sessions',
    'location_scope_coverage',
    'sparkbot_dedup_locks',
    'stevo_instances',
    'stevo_webhook_samples'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', tbl);
    EXECUTE format('DROP POLICY IF EXISTS deny_anon_all ON %I', tbl);
    EXECUTE format(
      'CREATE POLICY deny_anon_all ON %I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
      tbl
    );
  END LOOP;
END $$;
