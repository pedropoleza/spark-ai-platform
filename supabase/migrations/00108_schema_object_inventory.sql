-- =============================================
-- 00108_schema_object_inventory (Pedro 2026-06-15)
--
-- Inventário read-only do schema p/ a trava anti-drift (scripts/check-migration-drift.ts).
-- Retorna em 1 chamada todos os objetos persistentes de prod (tabelas, colunas,
-- índices, funções, cron jobs, triggers) pra o script comparar com o DDL dos
-- arquivos de migration — por EXISTÊNCIA REAL, sem depender de
-- supabase_migrations.schema_migrations (bookkeeping manual que falhou no apagão
-- do disparo Gustavo 2026-06-15: lote 00100-00106 com arquivo presente mas objeto
-- ausente em prod).
--
-- SECURITY DEFINER + search_path fixo (pg_temp por último, anti-shadow) + EXECUTE
-- travado em service_role: postura defense-in-depth das 00088/00100/00105.
-- Aditivo, idempotente.
-- =============================================
CREATE OR REPLACE FUNCTION public.schema_object_inventory()
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT jsonb_build_object(
    'tables', (SELECT coalesce(jsonb_agg(table_name ORDER BY table_name), '[]'::jsonb)
               FROM information_schema.tables
               WHERE table_schema = 'public' AND table_type = 'BASE TABLE'),
    'columns', (SELECT coalesce(jsonb_agg(table_name || '.' || column_name), '[]'::jsonb)
                FROM information_schema.columns
                WHERE table_schema = 'public'),
    'indexes', (SELECT coalesce(jsonb_agg(indexname ORDER BY indexname), '[]'::jsonb)
                FROM pg_indexes WHERE schemaname = 'public'),
    'functions', (SELECT coalesce(jsonb_agg(proname ORDER BY proname), '[]'::jsonb)
                  FROM pg_proc WHERE pronamespace = 'public'::regnamespace),
    'cron_jobs', (SELECT coalesce(jsonb_agg(jobname), '[]'::jsonb) FROM cron.job),
    'triggers', (SELECT coalesce(jsonb_agg(tgname), '[]'::jsonb)
                 FROM pg_trigger WHERE NOT tgisinternal)
  );
$$;

REVOKE ALL ON FUNCTION public.schema_object_inventory() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.schema_object_inventory() TO service_role;

COMMENT ON FUNCTION public.schema_object_inventory() IS
  'Guard de drift (2026-06-15): inventário read-only de objetos persistentes de prod em 1 chamada, pro scripts/check-migration-drift.ts comparar com o DDL dos arquivos. Verifica EXISTÊNCIA REAL, ignora schema_migrations.';
