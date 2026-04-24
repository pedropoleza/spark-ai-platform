-- RLS defesa em profundidade: explicit deny-by-default para anon key.
--
-- Contexto: autenticação é via GHL SSO (JWT custom), e todas as API routes
-- usam service_role key. Service role bypassa RLS, então essas policies não
-- afetam o fluxo normal. Porém se uma rota acidentalmente usar o anon key
-- (que vive no NEXT_PUBLIC_ bundle e é acessível pelo browser), essas
-- policies garantem zero acesso.
--
-- Se no futuro migrarmos pra Supabase Auth, essas policies servem de
-- baseline e podemos adicionar policies permissivas específicas.

-- Helper: cria policy de negação de tudo para o role anon.
-- Nada de SELECT/INSERT/UPDATE/DELETE com anon key.
DO $$
DECLARE
  tbl TEXT;
  tables TEXT[] := ARRAY[
    'locations',
    'agents',
    'agent_configs',
    'conversation_state',
    'message_queue',
    'execution_log',
    'scheduled_followups',
    'usage_records',
    'location_settings',
    'agent_feedback',
    'knowledge_base',
    'media_library',
    'agent_test_sessions',
    'agent_test_messages'
  ];
BEGIN
  FOREACH tbl IN ARRAY tables LOOP
    -- Confirma que RLS está habilitado (pode ser no-op se já estiver)
    EXECUTE format('ALTER TABLE IF EXISTS %I ENABLE ROW LEVEL SECURITY', tbl);

    -- Remove policies anteriores com esse nome (idempotente)
    EXECUTE format('DROP POLICY IF EXISTS deny_anon_all ON %I', tbl);

    -- Policy que nega tudo pro role anon (NULL USING = false para qualquer row)
    EXECUTE format(
      'CREATE POLICY deny_anon_all ON %I AS RESTRICTIVE FOR ALL TO anon USING (false) WITH CHECK (false)',
      tbl
    );
  END LOOP;
END $$;
