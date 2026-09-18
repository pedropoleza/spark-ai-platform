-- H92 (2026-09-18): mede a latência lead→resposta por conta.
--
-- Vive no banco porque o cálculo é um lateral join sobre message_queue ×
-- execution_log — trazer isso pro client seria puxar milhares de linhas por
-- tick. E porque o cálculo TEM que ser um só: a primeira versão disso feita à
-- mão no client pareava mensagem com resposta por ordem (row_number) e inflava
-- o atraso da Marina de ~0 pra 133min, quase levando a uma correção no lugar
-- errado. Aqui o pareamento é "a primeira resposta DEPOIS desta mensagem".
--
-- Silêncio COM motivo (humano assumiu, targeting, regra de desativação,
-- supressão de anúncio) não conta como falha — só o silêncio inexplicado.
CREATE OR REPLACE FUNCTION medir_latencia_resposta(p_horas integer DEFAULT 24)
RETURNS TABLE (
  location_id text, location_name text, amostra bigint,
  p50_min integer, p90_min integer, lentas bigint,
  pior_min integer, sem_resposta_sem_motivo bigint
)
LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH msgs AS (
    SELECT q.location_id, q.contact_id, q.received_at
    FROM message_queue q
    WHERE q.received_at > now() - make_interval(hours => p_horas)
      AND q.message_direction = 'inbound'
  ),
  pareado AS (
    SELECT m.location_id, m.contact_id, m.received_at,
      (SELECT min(e.created_at) FROM execution_log e
         WHERE e.contact_id = m.contact_id AND e.action_type = 'send_message'
           AND e.created_at > m.received_at
           AND e.created_at < m.received_at + interval '12 hours') AS respondeu_em,
      EXISTS (SELECT 1 FROM execution_log e2
         WHERE e2.contact_id = m.contact_id AND e2.created_at > m.received_at
           AND e2.created_at < m.received_at + interval '12 hours'
           AND e2.action_type IN ('ai_paused','ai_paused_skip','targeting_skip',
                                  'deactivated_by_rule_skip','entry_suppressed',
                                  'should_respond_skip','opp_closed_skip',
                                  'wallet_blocked_skip','max_messages_skip')) AS tem_motivo
    FROM msgs m
  )
  SELECT p.location_id, l.location_name,
    count(*) FILTER (WHERE p.respondeu_em IS NOT NULL) AS amostra,
    coalesce(round(percentile_cont(0.5) WITHIN GROUP (
      ORDER BY extract(epoch FROM (p.respondeu_em - p.received_at))/60)
      FILTER (WHERE p.respondeu_em IS NOT NULL))::int, 0) AS p50_min,
    coalesce(round(percentile_cont(0.9) WITHIN GROUP (
      ORDER BY extract(epoch FROM (p.respondeu_em - p.received_at))/60)
      FILTER (WHERE p.respondeu_em IS NOT NULL))::int, 0) AS p90_min,
    count(*) FILTER (WHERE p.respondeu_em IS NOT NULL
      AND extract(epoch FROM (p.respondeu_em - p.received_at))/60 > 10) AS lentas,
    coalesce(round(max(extract(epoch FROM (p.respondeu_em - p.received_at))/60)
      FILTER (WHERE p.respondeu_em IS NOT NULL))::int, 0) AS pior_min,
    count(*) FILTER (WHERE p.respondeu_em IS NULL AND NOT p.tem_motivo) AS sem_resposta_sem_motivo
  FROM pareado p
  LEFT JOIN locations l ON l.location_id = p.location_id
  GROUP BY p.location_id, l.location_name
  HAVING count(*) > 0
  ORDER BY count(*) FILTER (WHERE p.respondeu_em IS NOT NULL
    AND extract(epoch FROM (p.respondeu_em - p.received_at))/60 > 10) DESC;
$$;

REVOKE ALL ON FUNCTION medir_latencia_resposta(integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION medir_latencia_resposta(integer) TO service_role;
