-- 00099: TTL cleanup crons (review de prontidão pra produção 2026-06-05)
--
-- Motivação: duas tabelas acumulavam dados indefinidamente apesar dos comentários
-- de migration prometerem um "cron de cleanup futuro" que nunca foi criado:
--   - sparkbot_messages (00040 dizia "TTL: cron de cleanup remove >30d")
--   - filter_executions (00063 dizia "Mantém 30 dias via job de cleanup (futuro)")
-- Sem isso, em produção essas tabelas crescem sem limite (custo de storage +
-- queries mais lentas). Agora há pg_cron diário deletando linhas > 30 dias.
--
-- Idempotente: re-roda em staging branches sem erro (unschedule-if-exists).
-- Off-peak (2h/3h UTC) pra não competir com o tráfego.

do $$
begin
  if exists (select 1 from cron.job where jobname = 'cleanup-sparkbot-messages') then
    perform cron.unschedule('cleanup-sparkbot-messages');
  end if;
  if exists (select 1 from cron.job where jobname = 'cleanup-filter-executions') then
    perform cron.unschedule('cleanup-filter-executions');
  end if;
end $$;

select cron.schedule(
  'cleanup-sparkbot-messages',
  '0 2 * * *',
  $cmd$delete from public.sparkbot_messages where created_at < now() - interval '30 days'$cmd$
);

select cron.schedule(
  'cleanup-filter-executions',
  '0 3 * * *',
  $cmd$delete from public.filter_executions where created_at < now() - interval '30 days'$cmd$
);
