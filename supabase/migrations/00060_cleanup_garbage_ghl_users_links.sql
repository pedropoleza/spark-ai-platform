-- 00060: Limpa garbage links em rep_identities.ghl_users[].
-- Pedro 2026-05-06: descobrimos via audit que `identifyRepByGhlUser` adicionava
-- links {role=null, location_name=null} sempre que via ghl_user_id em outra
-- location, mesmo sem confirmar que user existia naquela location nova.
-- Resultado: 31 links garbage em 7 reps. Code fix em commit subsequente.
--
-- Impacto pré-fix: cron de proativos iterava locations garbage, queries GHL
-- events com user_id em location onde ele não existe → desperdício de calls
-- + logs poluídos + confusão na lógica de active_location.
--
-- Esta migration remove entries cuja role IS NULL E location_name IS NULL
-- (assinatura clara de garbage, dados reais SEMPRE têm role preenchido pelo
-- step 2 do identifyRepByGhlUser). Se algum link real foi marcado pra
-- limpeza acidentalmente (improvável), próximo check-admin do user vai
-- re-adicionar normalmente (com role agora preenchido).

UPDATE rep_identities
SET ghl_users = COALESCE((
  SELECT jsonb_agg(u)
  FROM jsonb_array_elements(ghl_users) AS u
  WHERE NOT (u->>'role' IS NULL AND u->>'location_name' IS NULL)
), '[]'::jsonb),
updated_at = NOW()
WHERE EXISTS (
  SELECT 1 FROM jsonb_array_elements(ghl_users) AS u
  WHERE u->>'role' IS NULL AND u->>'location_name' IS NULL
);

-- Sanitize active_location_id: se rep apontava pra loc que tá em garbage,
-- redefine pra location_id da primeira entry restante. Sem isso,
-- processIncoming pode falhar buscando location ativa que rep nem tem mais.
UPDATE rep_identities r
SET active_location_id = (
  SELECT (u->>'location_id')::text
  FROM jsonb_array_elements(r.ghl_users) AS u
  LIMIT 1
)
WHERE r.active_location_id IS NOT NULL
  AND jsonb_array_length(r.ghl_users) > 0
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(r.ghl_users) AS u
    WHERE u->>'location_id' = r.active_location_id
  );

-- Reps que ficaram com ghl_users=[] (eram SÓ garbage): NULL active_location.
UPDATE rep_identities r
SET active_location_id = NULL
WHERE r.active_location_id IS NOT NULL
  AND jsonb_array_length(r.ghl_users) = 0;
