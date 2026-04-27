-- Sparkbot: claim atômico de slot de dispatch (anti-race).
--
-- Problema antigo: dispatcher fazia (1) SELECT cooldown check, (2) LLM call
-- (5s+), (3) upsert alert_state. Entre 1 e 3, dois crons paralelos podiam
-- passar pelo check e dispatchar a mesma regra duas vezes.
--
-- Solução: função SQL que faz INSERT ON CONFLICT DO UPDATE com WHERE em
-- last_fired_at — só "claim" o slot se cooldown expirou. Atomic. Se 2
-- crons rodam simultaneamente, só 1 ganha o claim.
--
-- Uso:
--   const { data } = await supabase.rpc('try_claim_dispatch_slot', {
--     p_rep_id: rep.id,
--     p_rule_id: rule.id,
--     p_target_id: targetId,
--     p_cooldown_minutes: rule.cooldown_minutes,
--   });
--   if (!data) return { status: 'skipped_cooldown' };
--   // ... dispatch ...
--   await supabase.from('assistant_alert_state').update({status:'sent', tokens_used, cost_usd}).eq('id', data);

CREATE OR REPLACE FUNCTION try_claim_dispatch_slot(
  p_rep_id        UUID,
  p_rule_id       UUID,
  p_target_id     TEXT,
  p_cooldown_minutes INT
) RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
  v_id UUID;
  v_cutoff TIMESTAMPTZ;
BEGIN
  -- cooldown <= 0 = sempre permite
  IF p_cooldown_minutes <= 0 THEN
    INSERT INTO assistant_alert_state (rep_id, rule_id, target_id, last_fired_at, status)
    VALUES (p_rep_id, p_rule_id, p_target_id, now(), 'running')
    ON CONFLICT (rep_id, rule_id, target_id)
    DO UPDATE SET last_fired_at = now(), status = 'running'
    RETURNING id INTO v_id;
    RETURN v_id;
  END IF;

  v_cutoff := now() - make_interval(mins => p_cooldown_minutes);

  -- Insert se não existe; update se existe E cooldown expirou.
  -- NULL-safe match em target_id (necessário porque NULL != NULL no Postgres
  -- pra UNIQUE constraints; mas nosso UNIQUE inclui NULLs como "iguais").
  INSERT INTO assistant_alert_state (rep_id, rule_id, target_id, last_fired_at, status)
  VALUES (p_rep_id, p_rule_id, p_target_id, now(), 'running')
  ON CONFLICT (rep_id, rule_id, target_id)
  DO UPDATE SET last_fired_at = now(), status = 'running'
  WHERE assistant_alert_state.last_fired_at < v_cutoff
  RETURNING id INTO v_id;

  -- v_id NULL = update foi pulado (cooldown não expirou ainda)
  RETURN v_id;
END;
$$;

-- Função pra finalizar dispatch (atualiza status + métricas). Se v_id válido,
-- cooldown está reservado. Pra dispatch falhar mas não bloquear cooldown,
-- chamamos com status='failed' (ainda registra last_fired_at, evita retry
-- imediato — comportamento desejado).
CREATE OR REPLACE FUNCTION finalize_dispatch(
  p_alert_state_id UUID,
  p_status         TEXT,
  p_tokens_used    INT,
  p_cost_usd       NUMERIC
) RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE assistant_alert_state
  SET status = p_status,
      tokens_used = p_tokens_used,
      cost_usd = p_cost_usd
  WHERE id = p_alert_state_id;
END;
$$;
