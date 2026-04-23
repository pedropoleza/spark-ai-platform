-- Backfill dos recruitment_agents que foram criados com DEFAULT_SALES_DATA_FIELDS.
-- Só corrige agentes que ainda estão com os defaults de vendas intactos (não
-- sobrescreve configs já customizadas pelo admin). Detectamos "default ainda
-- intocado" pelo array exato original.

UPDATE agent_configs AS ac
SET data_fields = '[
  {"key":"full_name","label":"Nome completo","required":true,"type":"text"},
  {"key":"state","label":"Estado onde mora","required":true,"type":"text"},
  {"key":"current_occupation","label":"O que a pessoa faz hoje","required":true,"type":"text"},
  {"key":"motivation","label":"Motivação / gancho de interesse","required":false,"type":"text"}
]'::jsonb,
preferred_time_slot = COALESCE(NULLIF(ac.preferred_time_slot, ''), 'afternoon_evening'),
specialist_role = COALESCE(NULLIF(ac.specialist_role, ''), 'especialista')
FROM agents AS a
WHERE ac.agent_id = a.id
  AND a.type = 'recruitment_agent'
  AND ac.data_fields @> '[{"key":"smoker_status"}]'::jsonb;  -- marca inequívoco do default de vendas

-- Log para telemetria: quantos agentes foram ajustados
DO $$
DECLARE
  n INTEGER;
BEGIN
  SELECT COUNT(*) INTO n
  FROM agent_configs ac
  JOIN agents a ON a.id = ac.agent_id
  WHERE a.type = 'recruitment_agent';
  RAISE NOTICE 'Recruitment agents no sistema: %', n;
END $$;
