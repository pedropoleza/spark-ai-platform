-- H92 (2026-09-18): agenda os dois vigias novos.
--
-- `vigia-fila` a cada 3 min: procura mensagem vencida ha >4min, FORCA o dreno
-- (auto-cura) e so emite sinal se sobrar depois do dreno. A causa exata da
-- cauda de latencia ainda nao esta isolada — esta rede garante que o lead nao
-- pague a conta da investigacao. Mesma filosofia do H69: gatilho que depende de
-- evento externo precisa de alguem perguntando "ja venceu e ainda nao saiu?".
--
-- `vigia-latencia` 1x/dia as 14h UTC (10h ET, depois do pico da manha): mede
-- p50/p90/% lentas por conta e alerta nas degradadas. Complementa o H89, que so
-- enxerga conta MUDA — conta que responde em 4h passa batido la e e justamente
-- a que gera reclamacao.
SELECT cron.schedule('vigia-fila-3min', '*/3 * * * *', $job$
  SELECT net.http_get(
    url := (SELECT base_url || '/api/cron/vigia-fila?modo=fila' FROM public.cron_config WHERE id = 1),
    headers := jsonb_build_object('x-vercel-cron', '1'),
    timeout_milliseconds := 50000
  );
$job$);

SELECT cron.schedule('vigia-latencia-diario', '0 14 * * *', $job$
  SELECT net.http_get(
    url := (SELECT base_url || '/api/cron/vigia-fila?modo=latencia&horas=24' FROM public.cron_config WHERE id = 1),
    headers := jsonb_build_object('x-vercel-cron', '1'),
    timeout_milliseconds := 50000
  );
$job$);
